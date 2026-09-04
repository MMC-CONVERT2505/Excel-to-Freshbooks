import { createRequire } from 'module';
import prisma from '../lib/prisma.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
import {
  createClient, getClients,
  createItem, getItems, getArchivedItems, updateItem, deleteItem,
  createVendor, getVendors,
  getExpenseCategories, createExpense,
  createExpenseCategory,
  createIncome,
  createInvoice, getInvoices, searchInvoiceByNumber,
  createCreditNote, getCreditNotes,
  getBills, createBills,
  createBillPayment,
  createPayment,
  getChartOfAccounts, getLedgerAccounts, createChartOfAccount, createAccountGroup,
  createService, setServiceRate, getServices, getTasks, updateTask,
  getJournalEntries, createJournalEntry,
  getSessionTokenId,
  getSessionCompany,
  getSessionTriggeredBy,
} from './freshbooks.service.js';

// ── Per-session key helper ────────────────────────────────────────────────────
// liveProgress and cancelledEntities used to be keyed by entity only (e.g. 'invoices'),
// so two concurrent users pushing the same entity would overwrite each other's progress.
// Now keyed by "tokenId:entity" so each user's state is fully isolated.
function sessionKey(entity: string): string {
  const tid = getSessionTokenId();
  return tid != null ? `${tid}:${entity}` : entity;
}

type Row = Record<string, string>;

// Generate multiple normalized forms of a client name for fuzzy matching.
// Handles: extra punctuation, & vs and, word-order differences, spacing variations.
function clientNameVariants(name: string): string[] {
  const lower = name.toLowerCase().trim();
  const norm = lower
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const noSpace   = norm.replace(/ /g, '');
  const wordSorted = norm.split(' ').filter(Boolean).sort().join(' ');
  return [...new Set([lower, norm, noSpace, wordSorted])].filter(Boolean);
}

// FreshBooks only allows [a-zA-Z0-9 . -] in journal entry numbers — sanitize everything else to dash.
function sanitizeJeNumber(s: string): string {
  return s.replace(/[^a-zA-Z0-9.\-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'JE';
}

type MigrationResult = {
  entity: string;
  total: number;
  success: number;
  skipped: number;
  failed: number;
  durationMs: number;
  errors: { row: number; error: string }[];
};

// Read uploaded rows for an entity from DB, scoped to the caller's session token.
async function readUploadedRows(entityId: string, tokenId: number | null): Promise<Row[]> {
  const company = getSessionCompany();

  // Scope by COMPANY, not by connection. Sheets are stored against the tokenId that
  // uploaded them, but every reconnect mints a fresh token — even for the same company.
  // Matching on the token's accountId keeps a user's sheets across reconnects, and makes
  // it impossible for sheets uploaded for one company to be read while pushing to another.
  const sheet = await prisma.uploadedSheet.findFirst({
    where: {
      entity:    entityId,
      expiresAt: { gt: new Date() },
      ...(company ? { token: { accountId: company.accountId } } : { tokenId }),
    },
    orderBy: { uploadedAt: 'desc' },
    include: { token: { select: { accountId: true, companyLabel: true } } },
  });

  if (!sheet) {
    // Distinguish "never uploaded" from "uploaded for a different company". Both used to
    // report "upload first", which hid the real reason and invited a blind re-upload.
    const elsewhere = company
      ? await prisma.uploadedSheet.findFirst({
          where:   { entity: entityId, expiresAt: { gt: new Date() } },
          orderBy: { uploadedAt: 'desc' },
          include: { token: { select: { companyLabel: true } } },
        })
      : null;

    const err = elsewhere
      ? new Error(
          `"${entityId}" was uploaded for ${elsewhere.token?.companyLabel ?? 'a different company'}, ` +
          `but you are connected to ${company!.label}. Data is always pushed to the connected company — ` +
          `re-upload the sheet while connected to ${company!.label}, or reconnect to the other company.`
        )
      : new Error(`No uploaded file found for "${entityId}". Upload the sheet on the entity page first.`);
    (err as any).statusCode = elsewhere ? 409 : 400;
    throw err;
  }

  // Belt-and-braces: the query above already constrains this, but assert it explicitly so
  // any future change to the filter cannot quietly start pushing another company's data.
  if (company && sheet.token?.accountId && sheet.token.accountId !== company.accountId) {
    const err = new Error(
      `Refusing to push: "${entityId}" was uploaded for ${sheet.token.companyLabel ?? 'another company'} ` +
      `but this session is connected to ${company.label}. Re-upload the sheet for the correct company.`
    );
    (err as any).statusCode = 409;
    throw err;
  }

  return sheet.rows as Row[];
}

const DELAY_MS    = 200;  // ms delay between batches
const CONCURRENCY = 25;   // parallel workers per batch
const MAX_RETRIES = 4;

// In-memory live progress for custom-loop migrations (invoices, bills, etc.) that don't
// use runMigration(). getMigrationStatus() merges this so the frontend sees real counts.
const liveProgress: Map<string, { done: number; total: number; startedAt: number; completed?: boolean; completedAt?: number }> = new Map();

// In-memory cancellation flags — set by cancelMigration(), checked per-batch in runMigration()
const cancelledEntities: Set<string> = new Set();

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Marks a custom-loop entity as completed in liveProgress so the status poll returns
// COMPLETED status. The entry is kept alive for 30s so in-flight polls can pick it up,
// then deleted to free memory.
function markLiveProgressCompleted(key: string) {
  const prog = liveProgress.get(key);
  if (!prog) return;
  liveProgress.set(key, { ...prog, done: prog.total, completed: true, completedAt: Date.now() });
  setTimeout(() => liveProgress.delete(key), 30_000);
}

function normalizeDate(d: string): string {
  if (!d) return d;
  // YYYY-MM-DD (already correct)
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  // M/D/YYYY or D/M/YYYY (slashes)
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(d)) {
    const [a, b, yyyy] = d.split('/');
    const first = parseInt(a, 10);
    if (first > 12) return `${yyyy}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    return `${yyyy}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  // DD-MM-YYYY (dashes, day first — e.g. 18-02-2026)
  if (/^\d{1,2}-\d{1,2}-\d{4}/.test(d)) {
    const [dd, mm, yyyy] = d.split('-');
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return d;
}

function isConcurrencyConflict(err: any): boolean {
  if (err?.response?.status !== 409) return false;
  const body = JSON.stringify(err?.response?.data ?? '').toLowerCase();
  return body.includes('same time') || body.includes('concurrent') || body.includes('conflicts with another');
}

function isAlreadyExists(err: any): boolean {
  if (err?.response?.status === 409) {
    // Concurrency conflicts are NOT duplicates — they should be retried
    if (isConcurrencyConflict(err)) return false;
    return true;
  }
  const errors = err?.response?.data?.response?.errors || [];
  return errors.some((e: any) => {
    const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
    return msg.includes('already exists') || msg.includes('already in use');
  });
}

const SKIP_SENTINEL = Symbol('skip');
type SkipResult = { [SKIP_SENTINEL]: true; reason: string; rawResponse: any };
function makeSkip(err: any): SkipResult {
  const errors = err?.response?.data?.response?.errors || [];
  const reason = errors.map((e: any) => e.message).join('; ') || err?.message || 'already exists';
  return { [SKIP_SENTINEL]: true, reason, rawResponse: err?.response?.data ?? null };
}
function isSkip(res: any): res is SkipResult { return res != null && res[SKIP_SENTINEL] === true; }

async function callWithRetry(fn: () => Promise<any>): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (isAlreadyExists(err)) return makeSkip(err);
      const status = err?.response?.status;
      const isNetwork = !status && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code);
      const isServerError = status >= 500 && status <= 599;
      const isConcurrency = isConcurrencyConflict(err);
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(err?.response?.headers?.['retry-after'] || '0', 10);
        const waitMs = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * Math.pow(2, attempt), 60000);
        console.log(`Rate limited — waiting ${waitMs / 1000}s before retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(waitMs);
      } else if (isConcurrency && attempt < MAX_RETRIES) {
        const waitMs = Math.min(2000 * attempt, 10000); // 2s, 4s, 6s… FreshBooks concurrency conflict
        console.log(`FreshBooks concurrency conflict — retrying in ${waitMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(waitMs);
      } else if ((isNetwork || isServerError) && attempt < MAX_RETRIES) {
        const waitMs = Math.min(5000 * attempt, 30000);
        console.log(`${isServerError ? `FreshBooks ${status}` : `Network error (${err.code})`} — retrying in ${waitMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(waitMs);
      } else {
        throw err;
      }
    }
  }
}

function extractErrorDetails(err: any): { category: string; httpStatus?: number; errorCode?: string; message: string; rawResponse?: any } {
  const status   = err?.response?.status;
  const fbErrors = err?.response?.data?.response?.errors || [];
  const fbMsg    = fbErrors[0]?.message || err?.response?.data?.message;
  const fbCode   = fbErrors[0]?.errno ? String(fbErrors[0].errno) : undefined;
  const message  = fbMsg || err.message || 'Unknown error';

  let category = 'UNKNOWN';
  if (status === 401)                                           category = 'AUTHENTICATION';
  else if (status === 403)                                      category = 'AUTHORIZATION';
  else if (status === 429)                                      category = 'RATE_LIMIT';
  else if (status === 422 || status === 400)                    category = 'VALIDATION';
  else if (status && status >= 500)                             category = 'SERVER_ERROR';
  else if (!status)                                             category = 'NETWORK';
  else if (message.toLowerCase().includes('already'))           category = 'DUPLICATE';

  return { category, httpStatus: status, errorCode: fbCode, message, rawResponse: err?.response?.data };
}

async function runMigration(
  entity: string,
  rows: Row[],
  handler: (row: Row) => Promise<any>,
  getLabel: (row: Row) => string = () => '',
  isDuplicate: (row: Row) => boolean = () => false,
  runId?: number,
  tokenId?: number | null
): Promise<MigrationResult> {
  const tag = `[${entity.toUpperCase()}]`;
  const result: MigrationResult = { entity, total: rows.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const startTime = Date.now();

  // Map entity string to EntityType enum
  const entityTypeMap: Record<string, string> = {
    clients:            'CLIENT',
    vendors:            'VENDOR',
    items:              'ITEM',
    services:           'SERVICE',
    invoices:           'INVOICE',
    expenses:           'EXPENSE',
    income:             'INCOME',
    credit_notes:       'CREDIT_NOTE',
    bills:              'BILL',
    bill_payments:      'BILL_PAYMENT',
    invoice_payments:   'INVOICE_PAYMENT',
    chart_of_accounts:  'CHART_OF_ACCOUNTS',
    journal_entries:    'JOURNAL_ENTRY',
    expense_categories: 'EXPENSE_CATEGORY',
    sales_receipts:     'SALES_RECEIPT',
  };
  const entityType = entityTypeMap[entity] || 'ITEM';

  // ── Duplicate guard: reject if this entity is already RUNNING ─────────────
  // Scoped to this company. Unscoped, one company pushing Clients blocked every other
  // company from pushing Clients, and a single stuck phase locked the entity globally.
  const effectiveTokenId = tokenId ?? getSessionTokenId();
  const alreadyRunning = await prisma.migrationPhase.findFirst({
    where: {
      entity: entityType as any,
      status: 'RUNNING',
      run:    { tokenId: effectiveTokenId },
    },
  });
  if (alreadyRunning) {
    const err = new Error(`${entity} migration is already in progress — only one at a time`);
    (err as any).statusCode = 409;
    throw err;
  }

  // Create or reuse MigrationRun (effectiveTokenId computed above for the duplicate guard).
  // findFirst({ status: 'RUNNING' }) with no scoping used to reuse ANY user's active run —
  // company A and company B pushing at the same time would land on the SAME MigrationRun.
  // The phase upsert below is unique on (runId, entity), so the second user's push would
  // overwrite the first user's phase totals mid-flight, and deleteMany() would wipe the
  // first user's already-created MigrationRecord rows out from under their still-running
  // loop. Both loops then insert records against the same phaseId; sourceRow collides
  // between the two independent uploads and the unique (phaseId, sourceRow) constraint
  // throws inside processRow() below (now caught defensively there, but this is the
  // actual root cause to fix). That is the exact "one user's frontend shows the other
  // user's numbers, and their own push dies partway through" failure.
  //
  // Scope the reuse to this token so two concurrent users can never share a run. With no
  // token to scope by, always create fresh rather than risk matching a legacy run.
  let activeRun = runId
    ? await prisma.migrationRun.findUnique({ where: { id: runId } })
    : effectiveTokenId != null
      ? await prisma.migrationRun.findFirst({ where: { status: 'RUNNING', tokenId: effectiveTokenId } })
      : null;

  if (!activeRun) {
    activeRun = await prisma.migrationRun.create({
      data: {
        status:      'RUNNING',
        startedAt:   new Date(),
        heartbeatAt: new Date(),
        tokenId:     effectiveTokenId,
        triggeredBy: getSessionTriggeredBy(),
      },
    });
  }

  // Create or reset phase (unique on runId + entity)
  const phase = await prisma.migrationPhase.upsert({
    where:  { runId_entity: { runId: activeRun.id, entity: entityType as any } },
    update: { status: 'RUNNING', totalRecords: rows.length, startedAt: new Date(), completedAt: null, successCount: 0, failedCount: 0, skippedCount: 0, durationMs: 0 },
    create: { runId: activeRun.id, entity: entityType as any, status: 'RUNNING', totalRecords: rows.length, startedAt: new Date() },
  });

  // Clear old records so re-runs start clean
  await prisma.migrationRecord.deleteMany({ where: { phaseId: phase.id } });

  // Clear any stale cancellation flag before starting. The loop below only tests the flag
  // at each batch boundary, so a cancel arriving during the final batch is never consumed
  // — and with rows <= CONCURRENCY there is just one batch, so it is never consumed at all.
  // The flag would then survive and abort the *next* run at row 1, which is what a fresh
  // push reporting "Cancelled by user at row 1/N" actually means.
  cancelledEntities.delete(sessionKey(entity));

  console.log(`\n${tag} Starting migration — ${rows.length} records to push (${CONCURRENCY} workers)`);

  const processRow = async (row: Row, i: number) => {
    const label = `${tag} (${i + 1}/${rows.length}) ${getLabel(row)}`;

    // Defense in depth: the run-scoping fix above should make a (phaseId, sourceRow)
    // collision unreachable in normal operation, but this create() used to sit outside
    // any try/catch — an unhandled unique-constraint violation here rejected the whole
    // Promise.all for the batch, crashing the entire migration for whichever request
    // lost the race, not just this one row.
    let record;
    try {
      record = await prisma.migrationRecord.create({
        data: {
          phaseId:       phase.id,
          sourceRow:     i + 2,
          naturalKey:    getLabel(row) || undefined,
          sourcePayload: row as any,
          status:        'PENDING',
        },
      });
    } catch (err: any) {
      console.error(`${label} → ⚠️ could not create tracking record, skipping row: ${err.message}`);
      result.failed++;
      result.errors.push({ row: i + 2, error: `Tracking record conflict: ${err.message}` });
      return;
    }

    if (isDuplicate(row)) {
      result.skipped++;
      await prisma.migrationRecord.update({ where: { id: record.id }, data: { status: 'SKIPPED' } });
      console.log(`${label} → ⚡ skipped (already exists in FreshBooks)`);
      return;
    }

    try {
      const res = await callWithRetry(() => handler(row));
      if (!isSkip(res)) {
        result.success++;
        await prisma.migrationRecord.update({ where: { id: record.id }, data: { status: 'SUCCESS', lastAttemptAt: new Date(), attemptCount: { increment: 1 } } });
        console.log(`${label} → ✓ pushed`);
      } else {
        result.skipped++;
        await prisma.migrationRecord.update({ where: { id: record.id }, data: { status: 'SKIPPED', lastAttemptAt: new Date(), attemptCount: { increment: 1 } } });
        await prisma.migrationError.create({
          data: {
            recordId:    record.id,
            attempt:     1,
            category:    'DUPLICATE',
            message:     res.reason,
            rawResponse: res.rawResponse,
          },
        });
        console.log(`${label} → ⚡ skipped: ${res.reason}`);
      }
    } catch (err: any) {
      result.failed++;
      const errDetails = extractErrorDetails(err);
      result.errors.push({ row: i + 2, error: errDetails.message });
      await prisma.migrationRecord.update({
        where: { id: record.id },
        data: { status: 'FAILED', lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
      });
      await prisma.migrationError.create({
        data: {
          recordId:    record.id,
          attempt:     1,
          category:    errDetails.category as any,
          httpStatus:  errDetails.httpStatus,
          errorCode:   errDetails.errorCode,
          message:     errDetails.message,
          rawResponse: errDetails.rawResponse,
        },
      });
      console.log(`${label} → ❌ failed: ${errDetails.message}`);
    }
  };

  // Process rows in parallel batches of CONCURRENCY
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    // Check cancellation flag — set by cancelMigration() from the HTTP cancel endpoint
    const cancelKey = sessionKey(entity);
    if (cancelledEntities.has(cancelKey)) {
      cancelledEntities.delete(cancelKey);
      liveProgress.delete(sessionKey(entity));
      console.log(`${tag} Cancelled by user at row ${i + 1}/${rows.length} — stopping.`);
      result.durationMs = Date.now() - startTime;
      // cancelMigration() normally marks the phase FAILED already, but settle it here too.
      // This phase was just upserted to RUNNING above, and leaving it RUNNING would both
      // freeze the UI on "Running… 0/N" and trip the duplicate guard, permanently blocking
      // any further push of this entity.
      await prisma.migrationPhase.update({
        where: { id: phase.id },
        data:  { status: 'FAILED', completedAt: new Date(), durationMs: result.durationMs },
      }).catch(() => {});
      return result;
    }

    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((row, offset) => processRow(row, i + offset)));
    // Flush live counts + elapsed to DB in parallel with rate-limit delay — zero extra time,
    // but the 1500ms frontend poll now sees real progress and correct elapsed time.
    await Promise.all([
      sleep(DELAY_MS),
      prisma.migrationPhase.update({
        where: { id: phase.id },
        data:  { successCount: result.success, failedCount: result.failed, skippedCount: result.skipped, durationMs: Date.now() - startTime },
      }),
    ]);
  }

  result.durationMs = Date.now() - startTime;
  const totalSecs = Math.round(result.durationMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  console.log(`${tag} Done in ${duration} — pushed: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);

  // Update phase counters
  const phaseStatus = result.failed > 0 && result.success === 0 ? 'FAILED'
    : result.failed > 0 ? 'PARTIAL' : 'COMPLETED';

  await prisma.migrationPhase.update({
    where: { id: phase.id },
    data: {
      status:       phaseStatus as any,
      successCount: result.success,
      failedCount:  result.failed,
      skippedCount: result.skipped,
      completedAt:  new Date(),
      durationMs:   result.durationMs,
    },
  });

  // Update run status
  const runStatus = result.failed > 0 ? 'PARTIAL' : 'COMPLETED';
  await prisma.migrationRun.update({
    where: { id: activeRun.id },
    data: { status: runStatus as any, heartbeatAt: new Date() },
  });

  return result;
}

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

export async function migrateClients(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('clients', tokenId);

  const existingRes = await getClients();
  const existingClients: any[] = existingRes?.response?.result?.clients || [];
  const existingKeys = new Set(
    existingClients.map((c: any) => (c.organization || '').toLowerCase().trim()).filter(Boolean)
  );

  return runMigration('clients', rows, async (row) => {
    const org = row.organization?.trim() || '';
    if (!org) throw new Error('organization is required');
    const payload: Record<string, any> = {
      fname:         row.fname?.trim() || undefined,
      lname:         row.lname?.trim() || undefined,
      email:         row.email?.trim() || undefined,
      organization:  org,
      currency_code: row.currency_code || 'USD',
      language:      row.language || 'en',
      bus_phone:     row.bus_phone,
      mob_phone:     row.mob_phone,
      p_street:      row.p_street,
      p_street2:     row.p_street2,
      p_city:        row.p_city,
      p_province:    row.p_province,
      p_code:        row.p_code,
      p_country:     row.p_country,
      note:          row.note,
    };
    try {
      await createClient(payload);
    } catch (err: any) {
      // FreshBooks auto-generates a username from email/fname/lname.
      // If that username is already taken, retry with org+address only
      // (email, fname, lname are optional — only organization is required).
      const fbErrors: any[] = err?.response?.data?.response?.errors || [];
      const isUsernameTaken = fbErrors.some((e: any) =>
        typeof e.message === 'string' && e.message.toLowerCase().includes('username') && e.message.toLowerCase().includes('already exists')
      );
      if (!isUsernameTaken) throw err;
      await createClient({
        organization:  org,
        currency_code: payload.currency_code,
        language:      payload.language,
        bus_phone:     payload.bus_phone,
        mob_phone:     payload.mob_phone,
        p_street:      payload.p_street,
        p_street2:     payload.p_street2,
        p_city:        payload.p_city,
        p_province:    payload.p_province,
        p_code:        payload.p_code,
        p_country:     payload.p_country,
        note:          payload.note,
      });
    }
  },
  (row) => row.organization?.trim() || `${row.fname || ''} ${row.lname || ''}`.trim() || row.email || '(blank)',
  (row) => existingKeys.has((row.organization || '').toLowerCase().trim())
  );
}

// ─── ITEMS ───────────────────────────────────────────────────────────────────

export async function migrateItems(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('items', tokenId);

  // Fetch both endpoints: COA has JE-history accounts, ledger has ALL accounts.
  // Merge so income_account_number lookup works for income accounts too.
  const coaRes = await getChartOfAccounts();
  const accounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap, subTypeByUuid, typeByUuid } = buildMaps(accounts);

  const ledgerRes = await getLedgerAccounts();
  const { numberMap: ledgerMap, typeByUuid: ledgerTypeMap } = buildMaps(ledgerRes?.accounts || []);
  Object.assign(numberMap, ledgerMap);
  Object.assign(typeByUuid, ledgerTypeMap);

  // Build integer-ID map from raw COA accounts.
  // The old Items API uses the integer account `id` for income_account_id, not UUIDs.
  const intIdByNumber: Record<string, number> = {};
  function traverseForIntIds(items: any[]) {
    for (const item of items) {
      const acctNum = item.account_number || item.number;
      if (acctNum && typeof item.id === 'number') intIdByNumber[String(acctNum)] = item.id;
      if (item.sub_accounts?.length) traverseForIntIds(item.sub_accounts);
      if (item.children?.length)     traverseForIntIds(item.children);
    }
  }
  traverseForIntIds(accounts);

  console.log(`[ITEMS] COA accounts: ${accounts.length}, numberMap: ${Object.keys(numberMap).length} keys, intIdMap: ${Object.keys(intIdByNumber).length} keys`);

  const existingItemsRes = await getItems();
  const activeItems: any[] = existingItemsRes?.response?.result?.items || [];
  const existingItemKeys = new Set(activeItems.map((it: any) => (it.name || '').toLowerCase()));

  // Archived items still block name creation in FreshBooks — fetch them to restore+update
  const archivedItems: any[] = await getArchivedItems();
  const archivedByName: Record<string, number> = {};
  for (const it of archivedItems) {
    if (it.name) archivedByName[it.name.toLowerCase()] = it.id;
  }
  console.log(`[ITEMS] Active: ${activeItems.length}, Archived: ${archivedItems.length}`);

  // Log unique account numbers from the CSV — show both UUID and integer ID
  const uniqueAccounts = [...new Set(rows.map((r: any) => r.income_account_number).filter(Boolean))];
  for (const acctNum of uniqueAccounts.slice(0, 10)) {
    const uuid  = numberMap[String(acctNum)] ?? numberMap[`name::${String(acctNum).toLowerCase()}`];
    const intId = intIdByNumber[String(acctNum)];
    console.log(`[ITEMS ACCT MAP] "${acctNum}" → uuid: ${uuid ?? '(NOT FOUND)'}, intId: ${intId ?? '(NOT FOUND)'}`);
  }

  return runMigration('items', rows, async (row) => {
    const acctNum = row.income_account_number ? String(row.income_account_number).trim() : undefined;
    const income_account_uuid   = acctNum ? resolveIncomeAccount(acctNum, numberMap, typeByUuid, 'ITEMS') : undefined;
    const income_account_int_id = acctNum ? intIdByNumber[acctNum] : undefined;

    const payload: Record<string, any> = {
      name: row.name,
      description: row.description,
      sku: row.sku,
      qty: row.qty || '1',
      unit_cost: { amount: row.unit_cost, code: row.currency_code || 'USD' },
      vis_state: 0,
    };
    // FreshBooks Items API uses account_uuid (confirmed via browser inspect) — not income_account_id
    if (income_account_uuid)          payload.account_uuid = income_account_uuid;
    else if (income_account_int_id)   payload.income_account_id = income_account_int_id;

    const archivedId = archivedByName[row.name.toLowerCase()];
    let fbResponse: any;
    if (archivedId) {
      fbResponse = await updateItem(archivedId, payload);
    } else {
      fbResponse = await createItem(payload);
    }

    const stored = fbResponse?.response?.result?.item?.income_account_id;
    const itemId  = fbResponse?.response?.result?.item?.id;
    console.log(`[ITEMS STORED] "${row.name}" stored=${stored ?? 'null'} (sent intId=${income_account_int_id ?? 'n/a'} uuid=${income_account_uuid ?? 'n/a'})`);

    // account_uuid ignored on create — set via explicit updateItem
    if (!stored && itemId && (income_account_uuid || income_account_int_id)) {
      const updatePayload: Record<string, any> = {};
      if (income_account_uuid)   updatePayload.account_uuid = income_account_uuid;
      else                       updatePayload.income_account_id = income_account_int_id;
      try {
        const upd = await updateItem(itemId, updatePayload);
        const storedUpd = upd?.response?.result?.item?.income_account_id;
        console.log(`[ITEMS UPDATE] "${row.name}" income_account_id after explicit updateItem: ${storedUpd ?? 'null'}`);
      } catch (e: any) {
        console.warn(`[ITEMS UPDATE] "${row.name}" updateItem failed: ${e.message}`);
      }
    }
  },
  (row) => row.name,
  (row) => existingItemKeys.has(row.name.toLowerCase())
  );
}

export async function deleteAllItems(): Promise<{ deleted: number; failed: number }> {
  const res = await getItems();
  const items: any[] = res?.response?.result?.items || [];
  let deleted = 0;
  let failed  = 0;

  console.log(`\n[DELETE ITEMS] Found ${items.length} items to delete`);
  for (const item of items) {
    try {
      await deleteItem(item.id);
      deleted++;
      console.log(`[DELETE ITEMS] ✓ deleted: ${item.name}`);
    } catch (err: any) {
      failed++;
      console.log(`[DELETE ITEMS] ❌ failed: ${item.name} — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`[DELETE ITEMS] Done — deleted: ${deleted}, failed: ${failed}`);
  return { deleted, failed };
}

// ─── VENDORS ─────────────────────────────────────────────────────────────────

export async function migrateVendors(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('vendors', tokenId);

  const existingVendorsRes = await getVendors();
  const existingVendors: any[] = existingVendorsRes?.response?.result?.bill_vendors || [];
  const existingVendorKeys = new Set(existingVendors.map((v: any) => (v.vendor_name || '').toLowerCase()));

  return runMigration('vendors', rows, async (row) => {
    const vendorPayload: Record<string, any> = {
      vendor_name: row.vendor_name,
      primary_contact_first_name: row.primary_contact_first_name,
      primary_contact_last_name: row.primary_contact_last_name,
      phone: row.phone,
      street: row.street,
      city: row.city,
      province: row.province,
      postal_code: row.postal_code,
      country: row.country,
      currency_code: row.currency_code || 'USD',
      language: row.language || 'en',
      website: row.website,
      note: row.note,
    };
    if (row.primary_contact_email) vendorPayload.primary_contact_email = row.primary_contact_email;
    await createVendor(vendorPayload);
  },
  (row) => row.vendor_name,
  (row) => existingVendorKeys.has(row.vendor_name.toLowerCase())
  );
}

// Resolve a QBD category name (may be "Parent:Child") to a FreshBooks category id.
// Tries: exact → last segment → first segment → fallback first category.
function resolveExpenseCategory(raw: string | undefined, catMap: Record<string, number>, fallbackId: number | undefined, label: string): number | undefined {
  if (!raw) return fallbackId;
  const key = raw.toLowerCase().trim();
  if (catMap[key] !== undefined) return catMap[key];
  const parts = key.split(':').map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (catMap[last] !== undefined) { console.log(`${label} category "${raw}" → matched on subcategory "${last}"`); return catMap[last]; }
    const first = parts[0];
    if (catMap[first] !== undefined) { console.log(`${label} category "${raw}" → matched on parent "${first}"`); return catMap[first]; }
  }
  console.warn(`${label} category "${raw}" not found in FreshBooks — using fallback`);
  return fallbackId;
}

// ─── EXPENSES ────────────────────────────────────────────────────────────────

export async function migrateExpenses(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('expenses', tokenId);

  const catRes = await getExpenseCategories();
  const categories: any[] = catRes?.response?.result?.categories || [];
  const catMap: Record<string, number> = {};
  for (const c of categories) {
    catMap[c.category.toLowerCase()] = c.id;
  }

  return runMigration('expenses', rows, async (row) => {
    const categoryid = resolveExpenseCategory(row.category_name, catMap, categories[0]?.id, '[EXPENSES]');
    const base = parseFloat(row.amount) || 0;
    const tax1 = parseFloat(row.tax_amount1) || 0;
    const tax2 = parseFloat(row.tax_amount2) || 0;
    const grandTotal = (base + tax1 + tax2).toFixed(2);

    await createExpense({
      amount: { amount: grandTotal, code: row.currency_code || 'USD' },
      categoryid,
      staffid: 1,
      date: normalizeDate(row.date),
      vendor: row.vendor,
      notes: row.notes,
      clientid: 0,
      taxName1: row.tax_name1 || '',
      taxName2: row.tax_name2 || '',
      taxPercent1: tax1 ? String(Math.ceil((tax1 / base) * 100) + 1) : '0',
      taxPercent2: tax2 ? String(Math.ceil((tax2 / base) * 100) + 1) : '0',
      taxAmount1: tax1 ? { amount: row.tax_amount1, code: row.currency_code || 'USD' } : undefined,
      taxAmount2: tax2 ? { amount: row.tax_amount2, code: row.currency_code || 'USD' } : undefined,
    });
  }, (row) => `${row.date} | ${row.vendor} | $${row.amount}`);
}

// ─── INVOICES ────────────────────────────────────────────────────────────────

export async function migrateInvoices(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('invoices', tokenId);

  // Load parsed client data for full-detail auto-creation
  let clientCsvRows: Row[] = [];
  try { clientCsvRows = await readUploadedRows('clients', tokenId); } catch { clientCsvRows = []; }
  const clientCsvByName: Record<string, Row> = {};
  for (const r of clientCsvRows) {
    const addCsvVariants = (name: string) => {
      for (const v of clientNameVariants(name)) clientCsvByName[v] = r;
    };
    if (r.organization) addCsvVariants(r.organization);
    const full = `${r.fname || ''} ${r.lname || ''}`.trim();
    if (full) addCsvVariants(full);
  }

  const clientRes = await getClients();
  const clients: any[] = clientRes?.response?.result?.clients || [];

  // Lookup by email
  const clientByEmail: Record<string, number> = {};
  for (const c of clients) {
    if (c.email) clientByEmail[c.email.toLowerCase()] = c.id;
  }
  // Lookup by name — all normalized variants for fuzzy matching
  const clientByName: Record<string, number> = {};
  for (const c of clients) {
    const addVariants = (name: string) => {
      for (const v of clientNameVariants(name)) clientByName[v] = c.id;
    };
    if (c.organization) addVariants(c.organization);
    const firstLast = `${c.fname || ''} ${c.lname || ''}`.trim();
    if (firstLast) addVariants(firstLast);
    const lastFirst = `${c.lname || ''}, ${c.fname || ''}`.trim().replace(/^,\s*/, '');
    if (lastFirst) addVariants(lastFirst);
  }

  const existingInvoicesRes = await getInvoices();
  const existingInvoices: any[] = existingInvoicesRes?.response?.result?.invoices || [];
  const existingInvoiceNums = new Set(existingInvoices.map((inv: any) => String(inv.invoice_number || '').toLowerCase()));

  // Group rows by invoice_number — each row is one line item
  const groups: Record<string, Row[]> = {};
  for (const row of rows) {
    const num = row.invoice_number;
    if (!groups[num]) groups[num] = [];
    groups[num].push(row);
  }

  const invoiceGroups = Object.entries(groups);
  const result: MigrationResult = { entity: 'invoices', total: invoiceGroups.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const issues = newIssueCollector();
  const invStart = Date.now();
  let rowIndex = 2;

  liveProgress.set(sessionKey('invoices'), { done: 0, total: invoiceGroups.length, startedAt: Date.now() });
  console.log(`\n[INVOICES] Starting migration — ${invoiceGroups.length} invoices to push`);

  for (const [invoiceNum, lineRows] of invoiceGroups) {
    const i = result.success + result.failed + result.skipped;
    const label = `[INVOICES] (${i + 1}/${invoiceGroups.length}) #${invoiceNum}`;
    if (existingInvoiceNums.has(invoiceNum.toLowerCase())) {
      // Counted as success previously, which is why invoices always reported 0 skipped.
      result.skipped++;
      issues.skipped(rowIndex, `#${invoiceNum}`, lineRows[0], 'Invoice number already exists in FreshBooks');
      console.log(`${label} → ⚡ skipped (already exists in FreshBooks)`);
      rowIndex += lineRows.length;
      continue;
    }
    try {
      const header = lineRows[0];
      let customerid = clientByEmail[header.customer_email?.toLowerCase() || ''];
      if (!customerid && header.customer_name) {
        for (const v of clientNameVariants(header.customer_name)) {
          if (clientByName[v]) { customerid = clientByName[v]; break; }
        }
      }

      // Client not found after full lookup — create them (they weren't in the client migration)
      if (!customerid && header.customer_name) {
        // Try to find full details in 01_clients.csv first
        let csvClient: Row | undefined;
        for (const v of clientNameVariants(header.customer_name)) {
          if (clientCsvByName[v]) { csvClient = clientCsvByName[v]; break; }
        }
        const nameParts = header.customer_name.split(', ');
        const hasComma  = nameParts.length === 2;
        try {
          const newClient = await createClient(csvClient ? {
            fname:         csvClient.fname        || '',
            lname:         csvClient.lname        || '',
            email:         csvClient.email        || '',
            organization:  csvClient.organization || '',
            bus_phone:     csvClient.bus_phone    || '',
            mob_phone:     csvClient.mob_phone    || '',
            p_street:      csvClient.p_street     || '',
            p_street2:     csvClient.p_street2    || '',
            p_city:        csvClient.p_city       || '',
            p_province:    csvClient.p_province   || '',
            p_code:        csvClient.p_code       || '',
            p_country:     csvClient.p_country    || '',
            currency_code: csvClient.currency_code || 'USD',
            language:      csvClient.language      || 'en',
            note:          csvClient.note          || '',
          } : {
            lname:        hasComma ? nameParts[0].trim() : '',
            fname:        hasComma ? nameParts[1].trim() : header.customer_name,
            organization: hasComma ? '' : header.customer_name,
            currency_code: 'USD',
            language:      'en',
          });
          customerid = newClient?.response?.result?.client?.id;
          if (customerid) {
            for (const v of clientNameVariants(header.customer_name)) clientByName[v] = customerid;
            console.log(`${label} → 👤 created missing client: "${header.customer_name}"`);
          }
        } catch (createErr: any) {
          if (isAlreadyExists(createErr)) {
            // Client exists in FreshBooks but no name variant matched — log FreshBooks names to help diagnose
            const fbNames = clients
              .map((c: any) => c.organization || `${c.fname || ''} ${c.lname || ''}`.trim())
              .filter(Boolean)
              .join(', ');
            console.warn(`${label} → ⚠ client "${header.customer_name}" exists in FreshBooks but no name variant matched.\n  FreshBooks clients: ${fbNames}`);
          } else {
            throw createErr;
          }
        }
      }

      if (!customerid) {
        const fbNames = clients
          .map((c: any) => c.organization || `${c.fname || ''} ${c.lname || ''}`.trim())
          .filter(Boolean).slice(0, 10).join(' | ');
        throw new Error(`Client not found: "${header.customer_name}". FreshBooks has: ${fbNames}`);
      }

      const lines = lineRows.map((line) => {
        const qty = Number(line.line_qty) || 1;
        const unitCost = parseFloat(line.line_unit_cost) || 0;
        const subtotal = qty * unitCost;

        const taxAmt1 = parseFloat(line.tax_amount1) || 0;
        const taxAmt2 = parseFloat(line.tax_amount2) || 0;

        const lineObj: Record<string, any> = {
          name: line.line_name?.trim() || 'Sales',
          description: line.line_description || '',
          qty,
          unit_cost: { amount: line.line_unit_cost, code: header.currency_code || 'USD' },
        };

        if (line.tax_name1 && taxAmt1 && subtotal) {
          lineObj.taxName1 = line.tax_name1;
          lineObj.taxAmount1 = parseFloat(((taxAmt1 / subtotal) * 100).toFixed(4));
        }
        if (line.tax_name2 && taxAmt2 && subtotal) {
          lineObj.taxName2 = line.tax_name2;
          lineObj.taxAmount2 = parseFloat(((taxAmt2 / subtotal) * 100).toFixed(4));
        }

        return lineObj;
      });

      // FreshBooks only accepts 1=draft, 2=sent, 3=viewed on create (errno 8008 on anything else).
      // 4 (outstanding) and 5 (overdue) are computed by FreshBooks from the due date — map to 2.
      const statusMap: Record<string, number> = {
        '1': 1, draft: 1,
        '2': 2, sent: 2,
        '3': 3, viewed: 3,
        '4': 2, outstanding: 2,
        '5': 2, overdue: 2,
      };
      const fbStatus = statusMap[String(header.status ?? '').trim().toLowerCase()] ?? 2;

      // FreshBooks invoice_number max length is 20 characters
      const invoiceNum = String(header.invoice_number ?? '').slice(0, 20);

      const res = await callWithRetry(() => createInvoice({
        customerid,
        invoice_number: invoiceNum,
        create_date: normalizeDate(header.create_date),
        currency_code: header.currency_code || 'USD',
        due_offset_days: Number(header.due_offset_days) || 30,
        notes: header.notes,
        terms: header.terms,
        language: header.language || 'en',
        status: fbStatus,
        lines,
      }));

      result.success++;
      console.log(res !== null ? `${label} → ✓ pushed` : `${label} → ⚡ skipped (already exists)`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: rowIndex, error: errMsg });
      issues.failed(rowIndex, `#${invoiceNum}`, lineRows[0], errMsg);
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get(sessionKey('invoices'))!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  markLiveProgressCompleted(sessionKey('invoices'));
  result.durationMs = Date.now() - invStart;
  await flushCustomPhase('invoices', result, issues.all, tokenId);
  console.log(`[INVOICES] Done — success: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);
  return result;
}

// ─── SALES RECEIPTS ──────────────────────────────────────────────────────────
// A sales receipt = invoice paid immediately at point of sale.
// Creates a FreshBooks invoice (using receipt_number as invoice_number) and then
// immediately applies a payment for the full amount so it shows as paid.

export async function migrateSalesReceipts(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('sales-receipts', tokenId);

  // Normalize column aliases so invoice-format exports work without renaming
  for (const row of rows) {
    if (!row.receipt_number && row.invoice_number) row.receipt_number = row.invoice_number;
    if (!row.date && row.create_date)             row.date = row.create_date;
    if (!row.payment_type)                         row.payment_type = 'other';
  }

  // Load parsed client data for auto-creation (same as migrateInvoices)
  let clientCsvRows: Row[] = [];
  try { clientCsvRows = await readUploadedRows('clients', tokenId); } catch { clientCsvRows = []; }
  const clientCsvByName: Record<string, Row> = {};
  for (const r of clientCsvRows) {
    const addCsv = (name: string) => { for (const v of clientNameVariants(name)) clientCsvByName[v] = r; };
    if (r.organization) addCsv(r.organization);
    const full = `${r.fname || ''} ${r.lname || ''}`.trim();
    if (full) addCsv(full);
  }

  const clientRes = await getClients();
  const clients: any[] = clientRes?.response?.result?.clients || [];

  const clientByEmail: Record<string, number> = {};
  for (const c of clients) {
    if (c.email) clientByEmail[c.email.toLowerCase()] = c.id;
  }
  const clientByName: Record<string, number> = {};
  for (const c of clients) {
    const addVariants = (name: string) => { for (const v of clientNameVariants(name)) clientByName[v] = c.id; };
    if (c.organization) addVariants(c.organization);
    const firstLast = `${c.fname || ''} ${c.lname || ''}`.trim();
    if (firstLast) addVariants(firstLast);
    const lastFirst = `${c.lname || ''}, ${c.fname || ''}`.trim().replace(/^,\s*/, '');
    if (lastFirst) addVariants(lastFirst);
  }

  // Check existing invoices to skip already-pushed receipts
  const existingInvoicesRes = await getInvoices();
  const existingInvoices: any[] = existingInvoicesRes?.response?.result?.invoices || [];
  const existingInvoiceNums = new Set(existingInvoices.map((inv: any) => String(inv.invoice_number || '').toLowerCase()));

  // Group rows by receipt_number
  const groups: Record<string, Row[]> = {};
  for (const row of rows) {
    const num = row.receipt_number;
    if (!groups[num]) groups[num] = [];
    groups[num].push(row);
  }

  const receiptGroups = Object.entries(groups);
  const result: MigrationResult = { entity: 'sales-receipts', total: receiptGroups.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const issues = newIssueCollector();
  const srStart = Date.now();
  let rowIndex = 2;

  liveProgress.set(sessionKey('sales-receipts'), { done: 0, total: receiptGroups.length, startedAt: Date.now() });
  console.log(`\n[SALES-RCPT] Starting migration — ${receiptGroups.length} receipts to push`);

  for (const [receiptNum, lineRows] of receiptGroups) {
    const i = result.success + result.failed + result.skipped;
    const label = `[SALES-RCPT] (${i + 1}/${receiptGroups.length}) #${receiptNum}`;

    if (existingInvoiceNums.has(receiptNum.toLowerCase())) {
      result.skipped++;
      issues.skipped(rowIndex, `#${receiptNum}`, lineRows[0], 'Receipt number already exists in FreshBooks');
      console.log(`${label} → ⚡ skipped (already exists in FreshBooks)`);
      rowIndex += lineRows.length;
      liveProgress.get(sessionKey('sales-receipts'))!.done = result.success + result.failed + result.skipped;
      continue;
    }

    try {
      const header = lineRows[0];

      // Resolve customer
      let customerid = clientByEmail[header.customer_email?.toLowerCase() || ''];
      if (!customerid && header.customer_name) {
        for (const v of clientNameVariants(header.customer_name)) {
          if (clientByName[v]) { customerid = clientByName[v]; break; }
        }
      }
      if (!customerid && header.customer_name) {
        let csvClient: Row | undefined;
        for (const v of clientNameVariants(header.customer_name)) {
          if (clientCsvByName[v]) { csvClient = clientCsvByName[v]; break; }
        }
        const nameParts = header.customer_name.split(', ');
        const hasComma  = nameParts.length === 2;
        try {
          const newClient = await createClient(csvClient ? {
            fname: csvClient.fname || '', lname: csvClient.lname || '',
            email: csvClient.email || '', organization: csvClient.organization || '',
            currency_code: csvClient.currency_code || 'USD', language: csvClient.language || 'en',
          } : {
            lname: hasComma ? nameParts[0].trim() : '',
            fname: hasComma ? nameParts[1].trim() : header.customer_name,
            organization: hasComma ? '' : header.customer_name,
            currency_code: 'USD', language: 'en',
          });
          customerid = newClient?.response?.result?.client?.id;
          if (customerid) {
            for (const v of clientNameVariants(header.customer_name)) clientByName[v] = customerid;
            console.log(`${label} → 👤 created missing client: "${header.customer_name}"`);
          }
        } catch (createErr: any) {
          if (!isAlreadyExists(createErr)) throw createErr;
        }
      }
      if (!customerid) throw new Error(`Client not found: "${header.customer_name}"`);

      // Build line items
      const lines = lineRows.map((line) => {
        const qty      = Number(line.line_qty) || 1;
        const unitCost = parseFloat(line.line_unit_cost) || 0;
        const subtotal = qty * unitCost;
        const taxAmt1  = parseFloat(line.tax_amount1) || 0;
        const taxAmt2  = parseFloat(line.tax_amount2) || 0;
        const lineObj: Record<string, any> = {
          name: line.line_name?.trim() || 'Sales',
          description: line.line_description || '',
          qty,
          unit_cost: { amount: line.line_unit_cost, code: header.currency_code || 'USD' },
        };
        if (line.tax_name1 && taxAmt1 && subtotal) {
          lineObj.taxName1   = line.tax_name1;
          lineObj.taxAmount1 = parseFloat(((taxAmt1 / subtotal) * 100).toFixed(4));
        }
        if (line.tax_name2 && taxAmt2 && subtotal) {
          lineObj.taxName2   = line.tax_name2;
          lineObj.taxAmount2 = parseFloat(((taxAmt2 / subtotal) * 100).toFixed(4));
        }
        return lineObj;
      });

      // Create invoice (receipt_number becomes the FreshBooks invoice_number)
      const invoiceRes = await callWithRetry(() => createInvoice({
        customerid,
        invoice_number: receiptNum,
        create_date:    normalizeDate(header.date),
        currency_code:  header.currency_code || 'USD',
        due_offset_days: 0,
        notes:  header.notes,
        status: 2,
        lines,
      }));

      result.success++;
      console.log(`${label} → ✓ pushed`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: rowIndex, error: errMsg });
      issues.failed(rowIndex, `#${receiptNum}`, lineRows[0], errMsg);
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get(sessionKey('sales-receipts'))!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  markLiveProgressCompleted(sessionKey('sales-receipts'));
  result.durationMs = Date.now() - srStart;
  await flushCustomPhase('sales-receipts', result, issues.all, tokenId);
  console.log(`[SALES-RCPT] Done — success: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);
  return result;
}

// ─── INCOME ──────────────────────────────────────────────────────────────────

function mapIncomeCategory(_raw: string): string {
  // FreshBooks other_incomes category_name must be a valid enum — 'other' is always safe.
  // Original QBD account name is preserved in the note field.
  return 'other';
}

// Maps QBD transaction types to valid FreshBooks other_incomes payment_type values.
// FreshBooks only accepts: Check, Cash, Credit, ACH — Wire/Online are NOT valid here.
const QBD_PAYMENT_TYPE_MAP: Record<string, string> = {
  'deposit':             'Check',
  'check':               'Check',
  'payment':             'Check',
  'transfer':            'Check',
  'general journal':     'Check',
  'liability check':     'Check',
  'paycheck':            'Check',
  'bill pmt -check':     'Check',
  'sales receipt':       'Check',
  'wire':                'Check',
  'wire transfer':       'Check',
  'online':              'Check',
  'bank transfer':       'Check',
  'credit card':         'Credit',
  'credit card charge':  'Credit',
  'credit card credit':  'Credit',
  'credit card refund':  'Credit',
  'credit':              'Credit',
  'cash':                'Cash',
  'cash sale':           'Cash',
  'ach':                 'ACH',
};

function mapPaymentType(qbdType: string): string {
  return QBD_PAYMENT_TYPE_MAP[qbdType.toLowerCase().trim()] || 'Check';
}

export async function migrateIncome(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('income', tokenId);
  return runMigration('income', rows, async (row) => {
    const fbCategory = mapIncomeCategory(row.category_name || '');
    const note = [row.note, row.category_name ? `[${row.category_name}]` : ''].filter(Boolean).join(' ');
    await createIncome({
      amount:        { amount: row.amount, code: row.currency_code || 'USD' },
      source:        row.source || 'other',
      category_name: fbCategory,
      date:          normalizeDate(row.date),
      note,
      payment_type:  mapPaymentType(row.payment_type || 'Deposit'),
    });
  }, (row) => `${row.date} | $${row.amount} | ${row.category_name}`);
}

// ─── CREDIT NOTES ────────────────────────────────────────────────────────────

export async function migrateCreditNotes(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('credit-notes', tokenId);

  const clientRes = await getClients();
  const clients: any[] = clientRes?.response?.result?.clients || [];

  // Lookup by email
  const clientByEmail: Record<string, number> = {};
  for (const c of clients) {
    if (c.email) clientByEmail[c.email.toLowerCase()] = c.id;
  }
  // Lookup by fuzzy name (org + full name)
  const clientByName: Record<string, number> = {};
  for (const c of clients) {
    if (c.organization) {
      clientByName[c.organization.toLowerCase()] = c.id;
      clientByName[c.organization.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()] = c.id;
    }
    const lnFn = `${c.lname || ''}, ${c.fname || ''}`.toLowerCase().trim().replace(/^,\s*/, '');
    if (lnFn) clientByName[lnFn] = c.id;
    const fnLn = `${c.fname || ''} ${c.lname || ''}`.toLowerCase().trim();
    if (fnLn) clientByName[fnLn] = c.id;
  }

  const existingCNRes = await getCreditNotes();
  const existingCNs: any[] = existingCNRes?.response?.result?.credit_notes || [];
  const existingCNNums = new Set(existingCNs.map((cn: any) => String(cn.credit_number || '').toLowerCase()));

  // Group rows by credit_note_number — each row is one line item
  const groups: Record<string, Row[]> = {};
  for (const row of rows) {
    const num = row.credit_note_number;
    if (!groups[num]) groups[num] = [];
    groups[num].push(row);
  }

  const cnGroups = Object.entries(groups);
  const result: MigrationResult = { entity: 'credit_notes', total: cnGroups.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const issues = newIssueCollector();
  const cnStart = Date.now();
  let rowIndex = 2;

  liveProgress.set(sessionKey('credit-notes'), { done: 0, total: cnGroups.length, startedAt: Date.now() });
  console.log(`\n[CREDIT_NOTES] Starting migration — ${cnGroups.length} credit notes to push`);

  for (const [cnNum, lineRows] of cnGroups) {
    const i = result.success + result.failed + result.skipped;
    const label = `[CREDIT_NOTES] (${i + 1}/${cnGroups.length}) #${cnNum}`;
    if (existingCNNums.has(cnNum.toLowerCase())) {
      // Was counted as success, so credit notes always reported 0 skipped.
      result.skipped++;
      issues.skipped(rowIndex, `#${cnNum}`, lineRows[0], 'Credit note number already exists in FreshBooks');
      console.log(`${label} → ⚡ skipped (already exists in FreshBooks)`);
      rowIndex += lineRows.length;
      continue;
    }
    try {
      const header = lineRows[0];
      const nameKey     = (header.customer_name || '').toLowerCase();
      const nameKeyNorm = nameKey.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const clientid    = clientByEmail[header.customer_email?.toLowerCase()]
        || clientByName[nameKey]
        || clientByName[nameKeyNorm];
      if (!clientid) throw new Error(`Client not found: "${header.customer_name || header.customer_email}"`);

      const lines = lineRows.map((line) => {
        const qty = Number(line.qun) || 1;
        const unitCost = parseFloat(line.amt) || 0;
        const subtotal = qty * unitCost;

        const taxAmt1 = parseFloat(line.taxq) || 0;
        const taxAmt2 = parseFloat(line.taxq2) || 0;

        const lineObj: Record<string, any> = {
          name: line.line_name?.trim() || 'Sales',
          description: line.des || '',
          qty,
          unit_cost: { amount: line.amt, code: header.currency_code || 'USD' },
        };

        if (line.tax && taxAmt1 && subtotal) {
          lineObj.taxName1 = line.tax;
          lineObj.taxAmount1 = parseFloat(((taxAmt1 / subtotal) * 100).toFixed(4));
        }
        if (line.tax2 && taxAmt2 && subtotal) {
          lineObj.taxName2 = line.tax2;
          lineObj.taxAmount2 = parseFloat(((taxAmt2 / subtotal) * 100).toFixed(4));
        }

        return lineObj;
      });

      const res = await callWithRetry(() => createCreditNote({
        clientid,
        credit_number: header.credit_note_number,
        currency_code: header.currency_code || 'USD',
        create_date: header.date,
        credit_type: (() => {
          const raw = (header.credit_type || 'goodwill').toLowerCase().trim();
          const map: Record<string, string> = {
            'overpayment': 'overpayment',
            'over payment': 'overpayment',
            'credit_note': 'credit_note',
            'credit note': 'credit_note',
            'credit': 'credit_note',
            'goodwill': 'goodwill',
          };
          return map[raw] ?? 'goodwill';
        })(),
        notes: header.notes,
        terms: header.terms,
        lines,
      }));

      result.success++;
      console.log(res !== null ? `${label} → ✓ pushed` : `${label} → ⚡ skipped (already exists)`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: rowIndex, error: errMsg });
      issues.failed(rowIndex, `#${cnNum}`, lineRows[0], errMsg);
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get(sessionKey('credit-notes'))!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  markLiveProgressCompleted(sessionKey('credit-notes'));
  result.durationMs = Date.now() - cnStart;
  await flushCustomPhase('credit-notes', result, issues.all, tokenId);
  console.log(`[CREDIT_NOTES] Done — success: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);
  return result;
}

// ─── BILLS ───────────────────────────────────────────────────────────────────

export async function migrateBills(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('bills', tokenId);

  const vendorRes = await getVendors();
  const vendors: any[] = vendorRes?.response?.result?.bill_vendors || [];
  const vendorMap: Record<string, number> = {};
  for (const v of vendors) {
    if (!v.vendor_name) continue;
    const exact = v.vendor_name.toLowerCase();
    const norm  = exact.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    vendorMap[exact] = v.vendorid;
    vendorMap[norm]  = v.vendorid;
  }

  const catRes = await getExpenseCategories();
  const categories: any[] = catRes?.response?.result?.categories || [];
  const catMap: Record<string, number> = {};
  for (const c of categories) {
    catMap[c.category.toLowerCase()] = c.id;
  }

  const existingBillsRes = await getBills();
  const existingBills: any[] = existingBillsRes?.response?.result?.bills || [];
  const existingBillKeys = new Set(
    existingBills.map((b: any) => `${b.vendor?.vendor_name || ''}|${b.issue_date}`.toLowerCase())
  );

  // Group rows by bill_number — each row is one line item
  const groups: Record<string, Row[]> = {};
  for (const row of rows) {
    const num = row.bill_number;
    if (!groups[num]) groups[num] = [];
    groups[num].push(row);
  }

  const billGroups = Object.entries(groups);
  const result: MigrationResult = { entity: 'bills', total: billGroups.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const issues = newIssueCollector();
  const billStart = Date.now();
  let rowIndex = 2;

  liveProgress.set(sessionKey('bills'), { done: 0, total: billGroups.length, startedAt: Date.now() });
  console.log(`\n[BILLS] Starting migration — ${billGroups.length} bills to push`);

  for (const [billNum, lineRows] of billGroups) {
    const i = result.success + result.failed + result.skipped;
    const label = `[BILLS] (${i + 1}/${billGroups.length}) #${billNum}`;
    const header = lineRows[0];
    const billDedupKey = `${header.vendor_name || ''}|${header.date}`.toLowerCase();
    if (existingBillKeys.has(billDedupKey)) {
      // Was counted as success, so bills always reported 0 skipped.
      result.skipped++;
      issues.skipped(rowIndex, `#${billNum}`, header, `A bill for "${header.vendor_name}" dated ${header.date} already exists in FreshBooks`);
      console.log(`${label} → ⚡ skipped (already exists in FreshBooks)`);
      rowIndex += lineRows.length;
      continue;
    }
    try {
      const vKey     = (header.vendor_name || '').toLowerCase();
      const vKeyNorm = vKey.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      let vendorid   = vendorMap[vKey] || vendorMap[vKeyNorm];

      if (!vendorid && header.vendor_name) {
        try {
          const newVendor = await createVendor({ vendor_name: header.vendor_name, currency_code: 'USD', language: 'en' });
          vendorid = newVendor?.response?.result?.bill_vendor?.vendorid;
          if (vendorid) {
            vendorMap[vKey]     = vendorid;
            vendorMap[vKeyNorm] = vendorid;
            console.log(`${label} → 🏢 created missing vendor: "${header.vendor_name}"`);
          }
        } catch (e: any) {
          if (!isAlreadyExists(e)) throw e;
        }
      }

      if (!vendorid) throw new Error(`Vendor not resolved: "${header.vendor_name}"`);

      const lines = lineRows.map((line) => {
        const categoryid = resolveExpenseCategory(line.category_name, catMap, categories[0]?.id, '[BILLS]');
        const qty = Number(line.quantity) || 1;
        const unitCost = parseFloat(line.amount) || 0;
        const subtotal = qty * unitCost;

        const taxAmt1 = parseFloat(line.tax_amount1) || 0;
        const taxAmt2 = parseFloat(line.tax_amount2) || 0;

        const lineObj: Record<string, any> = {
          categoryid,
          description: line.desc || '',
          quantity: qty,
          unit_cost: { amount: line.amount, code: header.currency_code || 'USD' },
        };

        if (line.tax_name1 && taxAmt1 && subtotal) {
          lineObj.taxName1 = line.tax_name1;
          lineObj.taxPercent1 = parseFloat(((taxAmt1 / subtotal) * 100).toFixed(4));
        }
        if (line.tax_name2 && taxAmt2 && subtotal) {
          lineObj.taxName2 = line.tax_name2;
          lineObj.taxPercent2 = parseFloat(((taxAmt2 / subtotal) * 100).toFixed(4));
        }

        return lineObj;
      });

      const billPayload = {
        vendorid,
        bill_number: header.bill_number || '',
        issue_date: normalizeDate(header.date),
        due_offset_days: Number(header.due_offset_days) || 30,
        currency_code: header.currency_code || 'USD',
        language: 'en',
        lines,
      };
      const res = await callWithRetry(() => createBills(billPayload));

      result.success++;
      const createdId = res?.response?.result?.bill?.id;
      console.log(res !== null
        ? `${label} → ✓ pushed (FreshBooks bill ID: ${createdId})`
        : `${label} → ⚡ skipped (already exists)`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: rowIndex, error: errMsg });
      issues.failed(rowIndex, `#${billNum}`, header, errMsg);
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get(sessionKey('bills'))!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  markLiveProgressCompleted(sessionKey('bills'));
  result.durationMs = Date.now() - billStart;
  await flushCustomPhase('bills', result, issues.all, tokenId);
  console.log(`[BILLS] Done — success: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);

  // Verify actual count in FreshBooks
  try {
    const verifyRes = await getBills();
    const fbCount = verifyRes?.response?.result?.bills?.length ?? '?';
    console.log(`[BILLS] ✅ Verification: FreshBooks now has ${fbCount} bills total`);
  } catch (e: any) {
    console.warn(`[BILLS] Could not verify FreshBooks bill count: ${e.message}`);
  }

  return result;
}

// ─── BILL PAYMENTS ───────────────────────────────────────────────────────────

export async function migrateBillPayments(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('bill-payments', tokenId);

  const billsRes = await getBills();
  const bills: any[] = billsRes?.response?.result?.bills || [];

  console.log(`[BILL-PAY] Fetched ${bills.length} bills from FreshBooks`);
  if (bills.length > 0) {
    const sample = bills.slice(0, 5).map((b: any) =>
      `ID:${b.id} num:"${b.bill_number || ''}" vendor:"${b.vendor?.vendor_name || ''}" amt:${b.amount?.amount || b.outstanding?.amount || '?'} date:${b.issue_date || '?'}`
    ).join(' | ');
    console.log(`[BILL-PAY] Sample bills: ${sample}`);
  }

  const billByNumber: Record<string, number> = {};
  const billByVendorDate: Record<string, number> = {};
  const billsByVendor: Record<string, any[]> = {};
  // Index bills by amount for global fallback (vendor-agnostic)
  const billsByAmount: Record<string, any[]> = {};
  const billsByDateAndAmount: Record<string, number> = {};
  // Strip a leading letter-dash prefix (e.g. "B-", "INV-", "PO-") for fuzzy matching
  const stripPrefix = (s: string) => s.replace(/^[a-z]+-/i, '').toLowerCase();

  for (const b of bills) {
    if (b.bill_number) {
      const fullKey = b.bill_number.toLowerCase();
      billByNumber[fullKey] = b.id;
      // Also index by the bare key without prefix so payment-side can match either way
      const bareKey = stripPrefix(b.bill_number);
      if (bareKey !== fullKey) billByNumber[bareKey] = b.id;
    }
    const vName = (b.vendor?.vendor_name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const dateKey = `${vName}|${b.issue_date}`;
    billByVendorDate[dateKey] = b.id;
    if (vName) {
      if (!billsByVendor[vName]) billsByVendor[vName] = [];
      billsByVendor[vName].push(b);
    }
    // Build global amount index
    const amtKey = parseFloat(b.amount?.amount || b.outstanding?.amount || '0').toFixed(2);
    if (!billsByAmount[amtKey]) billsByAmount[amtKey] = [];
    billsByAmount[amtKey].push(b);
    if (b.issue_date) billsByDateAndAmount[`${b.issue_date}|${amtKey}`] = b.id;
  }

  // Load COA for offsetting journal entries (Petty Cash nullification)
  const coaRes = await getChartOfAccounts();
  const coaAccounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap } = buildMaps(coaAccounts);

  const pettyCashUuid = numberMap['name::petty cash'];
  if (!pettyCashUuid) {
    console.warn('[BILL-PAY] "Petty Cash" account not found in COA — offsetting JEs will be skipped');
  }

  let jeCounter = 0;

  return runMigration('bill_payments', rows, async (row) => {
    let billid: number | undefined;

    // 1. Match by bill_number — try exact, then bare (strip prefix), then with "B-" prefix
    if (row.bill_number) {
      const numKey  = row.bill_number.toLowerCase();
      const numBare = stripPrefix(row.bill_number);
      billid = billByNumber[numKey] ?? billByNumber[numBare] ?? billByNumber[`b-${numBare}`];
    }

    // 2. Match by vendor_name + issue_date
    if (!billid && row.vendor_name && row.issue_date) {
      const vNorm = row.vendor_name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      billid = billByVendorDate[`${vNorm}|${row.issue_date}`];
    }

    // 3. Match by vendor_name + amount (outstanding or total)
    if (!billid && row.vendor_name) {
      const vNorm = row.vendor_name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const vendorBills = billsByVendor[vNorm] || [];
      const payAmt = parseFloat(row.amount);
      const matched = vendorBills.find(b =>
        Math.abs(parseFloat(b.outstanding?.amount || b.amount?.amount || '0') - payAmt) < 0.01
      );
      if (matched) billid = matched.id;
    }

    // 4. Global fallback: match by issue_date + amount across ALL bills (ignores vendor mismatch)
    if (!billid && row.paid_date) {
      const amtKey = parseFloat(row.amount).toFixed(2);
      const dateNorm = normalizeDate(row.paid_date);
      billid = billsByDateAndAmount[`${dateNorm}|${amtKey}`];
      if (billid) console.log(`[BILL-PAY] Matched by date+amount: $${row.amount} on ${dateNorm} → bill ID ${billid}`);
    }

    // 5. Global fallback: match by amount alone across ALL bills (warns if ambiguous)
    if (!billid) {
      const amtKey = parseFloat(row.amount).toFixed(2);
      const candidates = billsByAmount[amtKey] || [];
      if (candidates.length === 1) {
        billid = candidates[0].id;
        console.log(`[BILL-PAY] Matched by amount alone: $${row.amount} → bill ID ${billid} (vendor: ${candidates[0].vendor?.vendor_name || 'unknown'})`);
      } else if (candidates.length > 1) {
        // Pick earliest unpaid bill with that amount
        const unpaid = candidates.filter(b => parseFloat(b.outstanding?.amount || '0') > 0);
        const pick = unpaid[0] || candidates[0];
        billid = pick.id;
        console.warn(`[BILL-PAY] Ambiguous amount match: $${row.amount} matches ${candidates.length} bills — using bill ID ${billid} (${pick.vendor?.vendor_name || 'unknown'})`);
      }
    }

    if (!billid) throw new Error(`Bill not found for vendor "${row.vendor_name}" — no bill in FreshBooks matches $${row.amount} (total FreshBooks bills: ${bills.length})`);

    const safeBillType = (row.payment_type || '').trim() || 'Check';

    await createBillPayment({
      billid,
      amount: { amount: row.amount, code: row.currency_code || 'USD' },
      paid_date: normalizeDate(row.paid_date),
      payment_type: safeBillType,
      note: row.note,
    });

  }, (row) => `${row.bill_number || row.vendor_name} | ${row.paid_date} | $${row.amount}`);
}

// ─── INVOICE PAYMENTS ────────────────────────────────────────────────────────

export async function migrateInvoicePayments(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('invoice-payments', tokenId);

  // Build fuzzy client name → clientid map (same variants as migrateInvoices)
  const clientRes = await getClients();
  const clients: any[] = clientRes?.response?.result?.clients || [];
  console.log(`[INV-PAY] Fetched ${clients.length} clients. Sample: ${clients.slice(0, 5).map((c: any) => c.organization || `${c.fname} ${c.lname}`).join(', ')}`);
  const clientByName: Record<string, number> = {};
  for (const c of clients) {
    const addVariants = (name: string) => {
      for (const v of clientNameVariants(name)) clientByName[v] = c.id;
    };
    if (c.organization) addVariants(c.organization);
    const firstLast = `${c.fname || ''} ${c.lname || ''}`.trim();
    if (firstLast) addVariants(firstLast);
    const lastFirst = `${c.lname || ''}, ${c.fname || ''}`.trim().replace(/^,\s*/, '');
    if (lastFirst) addVariants(lastFirst);
  }

  // Fetch all FreshBooks invoices — this includes both regular invoices AND
  // sales receipts (which are stored in FreshBooks as paid invoices with the receipt_number
  // as their invoice_number). Both types live under the same /invoices/invoices endpoint.
  const invoiceRes = await getInvoices();
  const invoices: any[] = invoiceRes?.response?.result?.invoices || [];
  console.log(`[INV-PAY] Fetched ${invoices.length} invoices from FreshBooks (includes sales receipts). Sample: ${invoices.slice(0, 5).map((i: any) => i.invoice_number).join(', ')}`);

  const invoiceByNumber: Record<string, number> = {};
  const invoicesByClient: Record<number, any[]> = {};
  for (const inv of invoices) {
    if (inv.invoice_number) {
      const full     = String(inv.invoice_number).toLowerCase();
      const stripped = full.replace(/^[a-z]+-/i, ''); // SRI-153611 → 153611
      invoiceByNumber[full]     = inv.id;
      invoiceByNumber[stripped] = inv.id;
    }
    if (!invoicesByClient[inv.customerid]) invoicesByClient[inv.customerid] = [];
    invoicesByClient[inv.customerid].push(inv);
  }

  // Also load the locally-uploaded sales-receipts sheet and pre-search FreshBooks
  // for any receipt_number not already covered by the invoice cache above.
  // This is a safety net — if the user pushed receipts before this run, getInvoices()
  // already includes them. But if any are missing (e.g. API pagination gap), we catch them here.
  try {
    const srRows = await readUploadedRows('sales-receipts', tokenId);
    const allReceiptNums = [...new Set(
      srRows.map(r => String(r.receipt_number || '').toLowerCase()).filter(Boolean)
    )];
    const missingNums = allReceiptNums.filter(num => {
      const stripped = num.replace(/^[a-z]+-/i, '');
      return !invoiceByNumber[num] && !invoiceByNumber[stripped];
    });
    if (missingNums.length > 0) {
      console.log(`[INV-PAY] ${missingNums.length} receipt number(s) not in invoice cache — searching FreshBooks directly`);
      for (const num of missingNums) {
        const stripped = num.replace(/^[a-z]+-/i, '');
        const found = await searchInvoiceByNumber(stripped) || await searchInvoiceByNumber(num);
        if (found?.id) {
          invoiceByNumber[num]     = found.id;
          invoiceByNumber[stripped] = found.id;
          console.log(`[INV-PAY] Mapped receipt #${num} → FreshBooks invoice id=${found.id}`);
        }
      }
    } else {
      console.log(`[INV-PAY] All ${allReceiptNums.length} receipt number(s) already in invoice cache ✓`);
    }
  } catch {
    // sales-receipts sheet not uploaded — nothing to pre-load, that's fine
  }

  // Load COA for offsetting journal entries (Petty Cash nullification)
  const coaRes = await getChartOfAccounts();
  const coaAccounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap } = buildMaps(coaAccounts);
  const allNumbers = Object.keys(numberMap).filter(k => !k.startsWith('name::'));
  console.log(`[INV-PAY] COA loaded: ${allNumbers.length} accounts. Numbers: ${allNumbers.slice(0, 20).join(', ')}`);

  const pettyCashUuid = numberMap['name::petty cash'];
  if (!pettyCashUuid) {
    console.warn('[INV-PAY] "Petty Cash" account not found in COA — offsetting JEs will be skipped');
  }

  // Sequential JE counter — incremented synchronously before any await so it's safe under concurrent batches
  let jeCounter = 0;

  return runMigration('invoice_payments', rows, async (row) => {
    let invoiceid: number | undefined;

    // 1. Match by invoice_number from pre-fetched list (try full and stripped of prefix)
    if (row.invoice_number) {
      const full     = String(row.invoice_number).toLowerCase();
      const stripped = full.replace(/^[a-z]+-/i, ''); // SRI-153653 → 153653
      invoiceid = invoiceByNumber[full] || invoiceByNumber[stripped];
    }

    // 2. Direct FreshBooks search (try both full and stripped number)
    if (!invoiceid && row.invoice_number) {
      console.warn(`[INV-PAY] Invoice #${row.invoice_number} not in cached list — searching FreshBooks directly`);
      const stripped = String(row.invoice_number).toLowerCase().replace(/^[a-z]+-/i, '');
      const found = await searchInvoiceByNumber(stripped) || await searchInvoiceByNumber(row.invoice_number);
      if (found?.id) {
        invoiceid = found.id;
        invoiceByNumber[String(row.invoice_number).toLowerCase()] = found.id;
        console.log(`[INV-PAY] Found invoice #${row.invoice_number} via direct search (id=${found.id})`);
      }
    }

    // 3. Invoice not found — log to error sheet and continue with next row
    if (!invoiceid) {
      throw new Error(`Invoice #${row.invoice_number} not found in FreshBooks — skipped. Push the invoice first, then re-push this payment.`);
    }

    // Map common QBD payment types to FreshBooks-safe values (no spaces or slashes)
    const safeType = (row.payment_type || '').trim() || 'Check';

    await createPayment({
      invoiceid,
      amount: { amount: row.amount, code: row.currency_code || 'USD' },
      date: normalizeDate(row.date),
      type: safeType,
      note: row.note,
    });

  }, (row) => `#${row.invoice_number || '?'} | ${row.customer_name} | $${row.amount} | ${row.date}`);
}

// ─── CHART OF ACCOUNTS ───────────────────────────────────────────────────────

// Default parent account number by type + sub_type
const DEFAULT_PARENT: Record<string, string> = {
  'asset|Cash & Bank':                        '1000',
  'asset|Current Asset':                      '1200',
  'asset|Property, Plant, and Equipment':     '1500',
  'liability|Current Liability':              '2000',
  'equity|Equity':                            '3002',
  'income|Income':                            '4000',
  'expense|Cost of Goods Sold':               '5000',
  'expense|Operating Expense':                '6008',
};

function buildMaps(accounts: any[]): {
  numberMap:     Record<string, string>;
  subTypeByUuid: Record<string, string>;
  typeByUuid:    Record<string, string>;
} {
  const numberMap:     Record<string, string> = {};
  const subTypeByUuid: Record<string, string> = {};
  const typeByUuid:    Record<string, string> = {};

  function traverse(items: any[]) {
    for (const item of items) {
      // FreshBooks uses different field names across endpoints:
      //   COA report:    account_number, account_uuid, account_type
      //   Ledger GET:    number (or account_number), account_uuid (or uuid), account_type
      const acctNum  = item.account_number || item.number;
      const acctUuid = item.account_uuid   || item.uuid
        || (item.id && typeof item.id === 'string' ? item.id : undefined);
      const acctType = item.account_type;

      if (acctNum && acctUuid) numberMap[String(acctNum)] = acctUuid;

      // Also index by name so users can supply the account name instead of number
      const itemName = item.account_name || item.name;
      if (itemName && acctUuid) numberMap[`name::${itemName.toLowerCase()}`] = acctUuid;

      const subType = item.account_sub_type || item.sub_account_type;
      if (acctUuid && subType)  subTypeByUuid[acctUuid] = subType;
      if (acctUuid && acctType) typeByUuid[acctUuid]    = acctType;

      if (item.sub_accounts?.length) traverse(item.sub_accounts);
      if (item.children?.length)     traverse(item.children);
    }
  }
  traverse(accounts);
  return { numberMap, subTypeByUuid, typeByUuid };
}

// Resolve an income_account_number/name from the CSV → UUID.
// Accepts: account number ("4001"), account name ("Design Income"), or either with spaces.
// Warns if the matched account is not an income-type account.
function resolveIncomeAccount(
  raw: string,
  numberMap: Record<string, string>,
  typeByUuid: Record<string, string>,
  label: string,
): string | undefined {
  const val = String(raw).trim();
  if (!val) return undefined;

  // Try by number, then by name
  const uuid = numberMap[val] ?? numberMap[`name::${val.toLowerCase()}`];
  if (!uuid) {
    console.warn(`[${label}] income account "${val}" not found in COA/ledger — will fall back to FreshBooks default`);
    return undefined;
  }

  // Verify the account is an income-type account
  const acctType = typeByUuid[uuid];
  if (acctType && acctType !== 'income') {
    console.warn(`[${label}] income account "${val}" resolved to UUID ${uuid} but account_type="${acctType}" (expected "income") — skipping to avoid wrong mapping`);
    return undefined;
  }
  if (!acctType) {
    // Type not known (e.g. system account) — allow it through with a note
    console.log(`[${label}] income account "${val}" → ${uuid} (type unknown — using anyway)`);
  } else {
    console.log(`[${label}] income account "${val}" → ${uuid} (type=${acctType})`);
  }
  return uuid;
}


export async function migrateChartOfAccounts(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('chart-of-accounts', tokenId);

  const coaRes = await getChartOfAccounts();
  const accounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap, subTypeByUuid } = buildMaps(accounts);
  console.log(`\n[COA] Loaded ${accounts.length} accounts from FreshBooks into lookup map`);

  const result: MigrationResult = { entity: 'chart_of_accounts', total: rows.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };
  const issues = newIssueCollector();
  const coaStart = Date.now();
  liveProgress.set(sessionKey('chart-of-accounts'), { done: 0, total: rows.length, startedAt: Date.now() });
  console.log(`\n[COA] Starting migration — ${rows.length} accounts to push`);

  // Determine if a row is a sub-account (has a parent pointing to a DIFFERENT account).
  // Self-referencing parents (seen in some QBD exports) are treated as top-level.
  const isSubAccount = (row: any): boolean => {
    const p = String(row.parent_account_number ?? '').trim();
    return p !== '' && p !== String(row.number ?? '').trim();
  };

  // Preserve original indices so console labels remain (i+1/total) across both passes.
  const topPass: Array<{ row: any; i: number }> = [];
  const subPass: Array<{ row: any; i: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    (isSubAccount(rows[i]) ? subPass : topPass).push({ row: rows[i], i });
  }

  // ── Shared per-row processor ──────────────────────────────────────────────
  const processRow = async (row: any, i: number) => {
    const label = `[COA] (${i + 1}/${rows.length}) ${row.number || '(no number)'} - ${row.name}`;
    try {
      // Name-first skip: if this name already exists in FreshBooks, register its
      // UUID under the sheet number so child accounts can still find it as parent.
      const nameKey = `name::${(row.name || '').toLowerCase()}`;
      if (row.name && numberMap[nameKey]) {
        const existingUuid = numberMap[nameKey];
        if (row.number && !numberMap[row.number]) numberMap[row.number] = existingUuid;
        result.success++;
        console.log(`${label} → ⚡ skipped (already in FreshBooks)`);
        liveProgress.get(sessionKey('chart-of-accounts'))!.done = result.success + result.failed + result.skipped;
        await sleep(DELAY_MS);
        return;
      }

      // Parent resolution
      const parentNumber = (row.parent_account_number && row.parent_account_number !== row.number)
        ? row.parent_account_number : '';
      let parent_account = parentNumber
        ? (numberMap[parentNumber] ?? numberMap[`name::${parentNumber.toLowerCase()}`])
        : undefined;

      // Drop parent if sub_type mismatches (avoids routing to wrong FB default account)
      if (parent_account && row.sub_type) {
        const parentSubType = subTypeByUuid[parent_account];
        if (parentSubType && parentSubType !== row.sub_type) parent_account = undefined;
      }

      // Fallback to a known FreshBooks default group when parent is missing
      if (parentNumber && !parent_account) {
        const fallbackNum = DEFAULT_PARENT[`${row.type}|${row.sub_type}`];
        parent_account = fallbackNum ? numberMap[fallbackNum] : undefined;
        if (parent_account) {
          console.log(`${label} → parent ${parentNumber} not found, routing to default parent ${fallbackNum}`);
        } else {
          throw new Error(`Parent account not found for number: ${parentNumber}`);
        }
      }

      // Number collision: bump to next free slot (1000 → 1001 → …)
      let accountNumber = row.number;
      if (accountNumber && numberMap[accountNumber]) {
        const n = parseInt(accountNumber, 10);
        accountNumber = !isNaN(n) ? String(n + 1) : `${accountNumber}-1`;
        console.log(`${label} → number collision on ${row.number}, using ${accountNumber}`);
      }

      // For sub-accounts, strip the QBD "Parent:Child" prefix — FreshBooks only
      // wants the child part; the parent relationship is set via parent_account UUID.
      const accountName = parent_account && row.name?.includes(':')
        ? row.name.slice(row.name.lastIndexOf(':') + 1).trim()
        : row.name;

      const payload: Record<string, any> = {
        name:     accountName,
        type:     row.type,
        sub_type: row.sub_type,
        state:    row.state || 'active',
      };
      if (accountNumber) payload.number = accountNumber;

      const res = parent_account
        ? await callWithRetry(() => createChartOfAccount({ ...payload, parent_account }))
        : await callWithRetry(() => createAccountGroup(payload));

      // Register newly created account so subsequent rows can use it as parent
      const inner   = res?.data || res;
      const created = inner?.ledger_account || inner?.journal_entry_account || inner;
      const createdNumber = created?.account_number || created?.number;
      const createdUuid   = created?.account_uuid   || created?.uuid || created?.id;
      if (createdUuid) {
        if (createdNumber) {
          numberMap[createdNumber] = createdUuid;
          if (row.number && createdNumber !== row.number) numberMap[row.number] = createdUuid;
        }
        if (row.name) numberMap[`name::${row.name.toLowerCase()}`] = createdUuid;
        console.log(`[COA] Registered: ${createdNumber || '(no number)'} / name::${row.name} → ${createdUuid}`);
      }

      // If skipped (already exists but not in initial map), recover UUID so children can find it
      if (!res && row.number) {
        const fallback = numberMap[`name::${row.name.toLowerCase()}`];
        if (fallback && !numberMap[row.number]) numberMap[row.number] = fallback;
      }

      result.success++;
      console.log(res ? `${label} → ✓ pushed` : `${label} → ⚡ skipped (already exists)`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: i + 2, error: errMsg });
      issues.failed(i + 2, row.name || row.number || '', row, errMsg);
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    liveProgress.get(sessionKey('chart-of-accounts'))!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  };

  // ── Pass 1: Top-level accounts (no parent) ────────────────────────────────
  console.log(`\n[COA] Pass 1 — ${topPass.length} top-level accounts`);
  for (const { row, i } of topPass) await processRow(row, i);

  // ── Refresh numberMap from FreshBooks ─────────────────────────────────────
  // Two sources:
  //   • getChartOfAccounts() → journal_entry_accounts tree (includes accounts with JE history)
  //   • getLedgerAccounts()  → flat list of ALL user-created accounts (catches accounts that
  //     exist in FreshBooks but have no journal entries, e.g. "Payroll Expenses")
  // This refresh ensures:
  //   1. Newly created parents have their canonical FreshBooks UUID indexed
  //   2. Pre-existing accounts that were skipped are now in the map so children find them
  console.log(`\n[COA] Refreshing account map from FreshBooks after pass 1...`);
  const freshCoa = await getChartOfAccounts();
  const freshCoaAccounts = freshCoa?.response?.result?.journal_entry_accounts || [];
  const { numberMap: m1, subTypeByUuid: s1 } = buildMaps(freshCoaAccounts);
  Object.assign(numberMap, m1);
  Object.assign(subTypeByUuid, s1);

  const freshLedger = await getLedgerAccounts();
  const freshLedgerAccounts: any[] = freshLedger?.accounts || [];
  const { numberMap: m2, subTypeByUuid: s2 } = buildMaps(freshLedgerAccounts);
  Object.assign(numberMap, m2);
  Object.assign(subTypeByUuid, s2);
  console.log(`[COA] Map refreshed — ${Object.keys(numberMap).length} entries (COA: ${freshCoaAccounts.length}, ledger: ${freshLedgerAccounts.length})`);

  // ── Pass 2: Sub-accounts (has parent) ────────────────────────────────────
  console.log(`\n[COA] Pass 2 — ${subPass.length} sub-accounts`);
  for (const { row, i } of subPass) await processRow(row, i);

  markLiveProgressCompleted(sessionKey('chart-of-accounts'));
  result.durationMs = Date.now() - coaStart;
  await flushCustomPhase('chart-of-accounts', result, issues.all, tokenId);
  console.log(`[COA] Done — success: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);
  return result;
}

// ─── MIGRATE ALL (in dependency order) ───────────────────────────────────────

// ─── EXPENSE CATEGORIES ───────────────────────────────────────────────────────

export async function migrateExpenseCategories(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('expense-categories', tokenId);

  const existingCatRes = await getExpenseCategories();
  const existingCats: any[] = existingCatRes?.response?.result?.categories || [];
  const existingCatKeys = new Set(existingCats.map((c: any) => (c.category || '').toLowerCase()));

  return runMigration('expense_categories', rows, async (row) => {
    await createExpenseCategory({ category: row.category_name });
  },
  (row) => row.category_name,
  (row) => existingCatKeys.has(row.category_name.toLowerCase())
  );
}

// ─── SERVICES ────────────────────────────────────────────────────────────────

export async function migrateServices(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('services', tokenId);

  // Fetch both endpoints: COA has JE-history accounts, ledger has ALL accounts.
  // Merge so income_account_number lookup works even for accounts with no JE history.
  const coaRes = await getChartOfAccounts();
  const coaAccounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap, typeByUuid } = buildMaps(coaAccounts);

  const ledgerRes = await getLedgerAccounts();
  const { numberMap: ledgerMap, typeByUuid: ledgerTypeMap } = buildMaps(ledgerRes?.accounts || []);
  Object.assign(numberMap, ledgerMap);
  Object.assign(typeByUuid, ledgerTypeMap);

  // FreshBooks income account on services lives on the TASK object (not the service itself).
  // createService({ income_account_id }) is silently ignored — must use updateTask({ account_uuid }).
  // Pre-fetch tasks so we can find the matching task after each service is created.
  const allTasks = await getTasks();
  const taskByName: Record<string, any> = {};
  for (const t of allTasks) {
    if (t.name) taskByName[t.name.toLowerCase().trim()] = t;
  }

  const existingServicesRes = await getServices();
  const existingServices: any[] = existingServicesRes?.response?.result?.services || [];
  const existingServiceKeys = new Set(existingServices.map((s: any) => (s.name || '').toLowerCase()));

  return runMigration('services', rows, async (row) => {
    const payload: Record<string, any> = { name: row.name };
    if (row.billable) payload.billable = row.billable === 'true';

    const income_account_id = row.income_account_number
      ? resolveIncomeAccount(row.income_account_number, numberMap, typeByUuid, 'SERVICES')
      : undefined;

    const res = await createService(payload);
    const serviceId = res?.service?.id;

    // Set rate
    if (serviceId && row.rate) await setServiceRate(serviceId, row.rate);

    // Set income account via Tasks API (the only way FreshBooks supports it)
    if (income_account_id) {
      // FreshBooks auto-creates a task when a service is created — find it by name.
      // Re-fetch tasks if not in the pre-fetched map (service might have just been created).
      let task = taskByName[row.name.toLowerCase().trim()];
      if (!task) {
        const freshTasks = await getTasks();
        task = freshTasks.find((t: any) => t.name?.toLowerCase().trim() === row.name.toLowerCase().trim());
        if (task) taskByName[row.name.toLowerCase().trim()] = task;
      }
      if (task) {
        await updateTask(task.id, {
          name:         task.name,
          billable:     task.billable ?? true,
          account_uuid: income_account_id,
          rate:         task.rate ?? { amount: row.rate ?? '0.00', code: 'USD' },
        });
        console.log(`[SERVICES] income account set on task "${row.name}" → ${income_account_id}`);
      } else {
        console.warn(`[SERVICES] task not found for service "${row.name}" — income account not set`);
      }
    }
  },
  (row) => row.name,
  (row) => existingServiceKeys.has(row.name.toLowerCase())
  );
}

// ─── JOURNAL ENTRIES ─────────────────────────────────────────────────────────

export async function migrateJournalEntries(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('journal-entries', tokenId);

  // Build FreshBooks COA number/name → UUID map
  const coaRes  = await getChartOfAccounts();
  const accounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap } = buildMaps(accounts);

  // Fetch existing journal entries to skip duplicates
  const existingRes = await getJournalEntries();
  const existingEntries: any[] = existingRes?.manualJournalEntries || [];
  const existingNums = new Set(
    existingEntries.map((e: any) => String(e.journalEntryNumber || e.journal_entry_number || '').toLowerCase())
  );

  // Group rows by entry_number — each row is one debit/credit line
  const groups: Record<string, Row[]> = {};
  for (const row of rows) {
    if (!groups[row.entry_number]) groups[row.entry_number] = [];
    groups[row.entry_number].push(row);
  }

  const entryGroups = Object.entries(groups);
  const result: MigrationResult = {
    entity: 'journal_entries', total: entryGroups.length,
    success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [],
  };

  const issues = newIssueCollector();
  const jeStart = Date.now();

  liveProgress.set(sessionKey('journal-entries'), { done: 0, total: entryGroups.length, startedAt: Date.now() });
  console.log(`\n[JE] Starting migration — ${entryGroups.length} journal entries to push (${CONCURRENCY} workers)`);

  for (let i = 0; i < entryGroups.length; i += CONCURRENCY) {
    const batch = entryGroups.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ([entryNum, lineRows], bi) => {
      const idx   = i + bi;
      const label = `[JE] (${idx + 1}/${entryGroups.length}) #${entryNum}`;

      if (existingNums.has(entryNum.toLowerCase())) {
        result.skipped++;
        issues.skipped(idx + 2, `#${entryNum}`, lineRows[0], 'Journal entry number already exists in FreshBooks');
        console.log(`${label} → ⚡ skipped (already exists)`);
        return;
      }

      try {
        const header = lineRows[0];
        const rawDate = normalizeDate(header.date);
        const [yyyy, mm, dd] = rawDate.split('-');

        const details = lineRows.map((line) => {
          const num  = (line.account_number || '').trim();
          const name = (line.account_name  || '').trim();
          const accountId =
            (num  && numberMap[num])                          ||
            (name && numberMap[`name::${name.toLowerCase()}`]);

          if (!accountId) throw new Error(`Account not found: "${num || name}"`);

          const debit  = parseFloat(line.debit  || '0') || 0;
          const credit = parseFloat(line.credit || '0') || 0;
          const amount = debit > 0 ? debit : credit;
          const type   = debit > 0 ? 'TYPE_DEBIT' : 'TYPE_CREDIT';

          return {
            accountId,
            amount: { amount: amount.toFixed(2), code: line.currency_code || 'USD' },
            type,
          };
        });

        await callWithRetry(() => createJournalEntry({
          userEnteredDate:    { year: yyyy, month: mm, day: dd },
          name:               header.name || entryNum,
          journalEntryNumber: sanitizeJeNumber(entryNum),
          description:        header.description || '',
          details,
        }));

        result.success++;
        console.log(`${label} → ✓ pushed (${details.length} lines)`);
      } catch (err: any) {
        result.failed++;
        const detail = err?.response?.data;
        const errMsg = detail ? JSON.stringify(detail) : err.message;
        result.errors.push({ row: idx + 2, error: errMsg });
        issues.failed(idx + 2, `#${entryNum}`, lineRows[0], errMsg);
        console.log(`${label} → ❌ failed: ${errMsg}`);
      }
    }));

    liveProgress.get(sessionKey('journal-entries'))!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  markLiveProgressCompleted(sessionKey('journal-entries'));
  result.durationMs = Date.now() - jeStart;
  await flushCustomPhase('journal-entries', result, issues.all, tokenId);
  console.log(`[JE] Done — success: ${result.success}, skipped: ${result.skipped}, failed: ${result.failed}`);
  return result;
}

export async function migrateAll(tokenId: number | null = null): Promise<MigrationResult[]> {
  const allStart = Date.now();
  const results: MigrationResult[] = [];

  // Dependency-ordered: each entity depends on everything above it
  results.push(await migrateChartOfAccounts(tokenId));   // 1 — everything references COA
  results.push(await migrateExpenseCategories(tokenId)); // 2 — expenses need categories
  results.push(await migrateClients(tokenId));           // 3 — invoices/payments need clients
  results.push(await migrateVendors(tokenId));           // 4 — bills/payments need vendors
  results.push(await migrateItems(tokenId));             // 5 — invoices reference items
  results.push(await migrateServices(tokenId));          // 6 — invoices reference services
  results.push(await migrateExpenses(tokenId));          // 7 — standalone, needs categories
  results.push(await migrateIncome(tokenId));            // 8 — standalone
  results.push(await migrateJournalEntries(tokenId));    // 9 — references COA accounts
  results.push(await migrateInvoices(tokenId));          // 10 — needs clients, items, services
  results.push(await migrateSalesReceipts(tokenId));     // 11 — needs clients; creates invoice+payment
  results.push(await migrateBills(tokenId));             // 12 — needs vendors, categories
  results.push(await migrateCreditNotes(tokenId));       // 13 — needs clients
  results.push(await migrateInvoicePayments(tokenId));   // 14 — needs invoices to exist first
  results.push(await migrateBillPayments(tokenId));      // 15 — needs bills to exist first

  const totalMs   = Date.now() - allStart;
  const totalMins = Math.floor(totalMs / 60000);
  const totalSecs = Math.floor((totalMs % 60000) / 1000);

  console.log('\n════════════════════════════════════════');
  console.log('  MIGRATION COMPLETE — TIMING SUMMARY');
  console.log('════════════════════════════════════════');
  for (const r of results) {
    const mins = Math.floor(r.durationMs / 60000);
    const secs = Math.floor((r.durationMs % 60000) / 1000);
    const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    const pad  = r.entity.padEnd(22);
    console.log(`  ${pad} ${time.padStart(8)}   ✓${r.success} ⚡${r.skipped} ❌${r.failed}`);
  }
  console.log('────────────────────────────────────────');
  console.log(`  ${'TOTAL'.padEnd(22)} ${`${totalMins}m ${totalSecs}s`.padStart(8)}`);
  console.log('════════════════════════════════════════\n');

  return results;
}

// ─── MIGRATION STATUS ─────────────────────────────────────────────────────────

const ENTITY_TYPE_TO_ID: Record<string, string> = {
  CHART_OF_ACCOUNTS: 'chart-of-accounts',
  CLIENT:            'clients',
  VENDOR:            'vendors',
  ITEM:              'items',
  SERVICE:           'services',
  INVOICE:           'invoices',
  EXPENSE:           'expenses',
  INCOME:            'income',
  CREDIT_NOTE:       'credit-notes',
  BILL:              'bills',
  BILL_PAYMENT:      'bill-payments',
  INVOICE_PAYMENT:   'invoice-payments',
  JOURNAL_ENTRY:     'journal-entries',
  SALES_RECEIPT:     'sales-receipts',
  EXPENSE_CATEGORY:  'expense-categories',
};

export async function getMigrationStatus(tokenId?: number | null) {
  // Resolve the FreshBooks accountId (stable identifier across re-logins).
  // We filter by accountId so history persists even after reconnecting FreshBooks.
  let scopeAccountId: string | null = null;
  if (tokenId) {
    const tok = await prisma.freshbooksToken.findUnique({ where: { id: tokenId }, select: { accountId: true } });
    scopeAccountId = tok?.accountId ?? null;
  }
  // No session token means we cannot say whose history this is. Falling back to the
  // isCurrent global would show whichever company connected last — another client's
  // migration history. Return nothing instead of guessing.
  if (!scopeAccountId) {
    return { run: null, phases: [] };
  }

  const allPhases = await prisma.migrationPhase.findMany({
    where: {
      status: { in: ['COMPLETED', 'PARTIAL', 'FAILED', 'RUNNING'] },
      // Strictly this company's runs. This previously also matched
      // `{ run: { tokenId: null } }` as a "legacy runs" allowance — but tokenId was
      // never populated (fixed separately), so every run in the table was null and
      // every company saw every other company's history. Worse, the newest phase per
      // entity wins below, so another company's run could mask the correct one.
      run: { token: { accountId: scopeAccountId } },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      records: {
        where: { status: { in: ['FAILED', 'SKIPPED'] } },
        include: {
          errors: { orderBy: { attempt: 'desc' }, take: 1 },
        },
      },
    },
  });

  // Keep only the most recent phase per entity type
  const latestByEntity = new Map<string, typeof allPhases[0]>();
  for (const phase of allPhases) {
    const key = String(phase.entity);
    if (!latestByEntity.has(key)) latestByEntity.set(key, phase);
  }

  const phases = Array.from(latestByEntity.values()).map(phase => {
    const failedRecords  = phase.records.filter(r => r.status === 'FAILED');
    const skippedRecords = phase.records.filter(r => r.status === 'SKIPPED');

    const errors = failedRecords.map(record => ({
      row:   record.sourceRow,
      error: record.errors[0]?.message ?? 'Unknown error',
    }));

    const skipped_rows = skippedRecords.map(record => ({
      row:     record.sourceRow,
      reason:  record.errors[0]?.message ?? 'already exists in FreshBooks',
      payload: record.sourcePayload as Record<string, any>,
    }));

    return {
      entity:       ENTITY_TYPE_TO_ID[String(phase.entity)] ?? String(phase.entity).toLowerCase(),
      status:       phase.status,
      total:        phase.totalRecords,
      success:      phase.successCount,
      skipped:      phase.skippedCount,
      failed:       phase.failedCount,
      durationMs:   phase.durationMs ?? 0,
      completedAt:  phase.completedAt?.toISOString() ?? null,
      startedAt:    phase.startedAt?.toISOString()   ?? null,
      errors,
      skipped_rows,
    };
  });

  // Always merge liveProgress BEFORE checking for empty — a migration can be actively
  // running even when allPhases is empty (e.g. new company token, no DB phases yet,
  // or the current run hasn't written its first phase to DB yet).
  // Keys are now "tokenId:entity" — filter to this session only, then strip the prefix.
  const tokenPrefix = tokenId ? `${tokenId}:` : '';
  for (const [key, prog] of liveProgress) {
    if (tokenId && !key.startsWith(tokenPrefix)) continue; // skip other users' progress
    const entity = tokenId ? key.slice(tokenPrefix.length) : key;
    const runningPhase = {
      entity,
      status:      (prog.completed ? 'COMPLETED' : 'RUNNING') as 'COMPLETED' | 'RUNNING',
      total:       prog.total,
      success:     prog.done,
      skipped:     0,
      failed:      0,
      durationMs:  Date.now() - prog.startedAt,
      completedAt: prog.completed && prog.completedAt
        ? new Date(prog.completedAt).toISOString()
        : null,
      startedAt:    new Date(prog.startedAt).toISOString(),
      errors:       [],
      skipped_rows: [],
    };
    const idx = phases.findIndex(p => p.entity === entity);
    if (idx >= 0) {
      phases[idx] = runningPhase; // replace stale DB phase
    } else {
      phases.push(runningPhase);
    }
  }

  if (!phases.length) return { run: null, phases: [] };

  return { run: null, phases };
}

// ── Frontend entity ID → DB EntityType enum ───────────────────────────────────
const ID_TO_ENTITY_TYPE: Record<string, string> = {
  'clients':           'CLIENT',
  'vendors':           'VENDOR',
  'items':             'ITEM',
  'services':          'SERVICE',
  'expenses':          'EXPENSE',
  'income':            'INCOME',
  'invoices':          'INVOICE',
  'credit-notes':      'CREDIT_NOTE',
  'bills':             'BILL',
  'bill-payments':     'BILL_PAYMENT',
  'invoice-payments':  'INVOICE_PAYMENT',
  'chart-of-accounts': 'CHART_OF_ACCOUNTS',
  'journal-entries':   'JOURNAL_ENTRY',
  'sales-receipts':     'SALES_RECEIPT',
  'expense-categories': 'EXPENSE_CATEGORY',
};

// ── Issue recording for custom-loop migrations ───────────────────────────────
// invoices, sales-receipts, bills, credit-notes, journal-entries and chart-of-accounts
// run bespoke loops instead of runMigration(), so they create no MigrationPhase and no
// MigrationRecords — their skip/error detail vanished with the HTTP response and never
// reached History or the issue report. Collect issues during the loop, then flush once
// at the end. Everything here is best-effort: reporting must never fail a migration.
type CollectedIssue = {
  sourceRow:  number;
  naturalKey: string;
  payload:    Record<string, any>;
  status:     'SKIPPED' | 'FAILED';
  message:    string;
};

export function newIssueCollector() {
  const issues: CollectedIssue[] = [];
  return {
    skipped(sourceRow: number, naturalKey: string, payload: Record<string, any>, message: string) {
      issues.push({ sourceRow, naturalKey, payload, status: 'SKIPPED', message });
    },
    failed(sourceRow: number, naturalKey: string, payload: Record<string, any>, message: string) {
      issues.push({ sourceRow, naturalKey, payload, status: 'FAILED', message });
    },
    get all() { return issues; },
  };
}

// Persists a phase plus one record per collected issue for a custom-loop migration.
async function flushCustomPhase(
  entity: string,
  result: MigrationResult,
  issues: CollectedIssue[],
  tokenId: number | null,
): Promise<void> {
  try {
    const entityTypeMap: Record<string, string> = {
      invoices:          'INVOICE',
      'sales-receipts':  'SALES_RECEIPT',
      bills:             'BILL',
      'credit-notes':    'CREDIT_NOTE',
      'journal-entries': 'JOURNAL_ENTRY',
      'chart-of-accounts': 'CHART_OF_ACCOUNTS',
    };
    const entityType = entityTypeMap[entity];
    if (!entityType) return;

    const effectiveTokenId = tokenId ?? getSessionTokenId();

    let run = await prisma.migrationRun.findFirst({
      where:   { status: 'RUNNING', tokenId: effectiveTokenId },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) {
      run = await prisma.migrationRun.create({
        data: {
          status:      'COMPLETED',
          startedAt:   new Date(),
          completedAt: new Date(),
          tokenId:     effectiveTokenId,
          triggeredBy: getSessionTriggeredBy(),
        },
      });
    }

    const status = result.failed > 0 ? 'PARTIAL' : 'COMPLETED';
    const phase = await prisma.migrationPhase.upsert({
      where:  { runId_entity: { runId: run.id, entity: entityType as any } },
      update: {
        status: status as any, totalRecords: result.total, successCount: result.success,
        failedCount: result.failed, skippedCount: result.skipped,
        completedAt: new Date(), durationMs: result.durationMs,
      },
      create: {
        runId: run.id, entity: entityType as any, status: status as any,
        totalRecords: result.total, successCount: result.success,
        failedCount: result.failed, skippedCount: result.skipped,
        startedAt: new Date(), completedAt: new Date(), durationMs: result.durationMs,
      },
    });

    await prisma.migrationRecord.deleteMany({ where: { phaseId: phase.id } });

    for (const issue of issues) {
      const record = await prisma.migrationRecord.create({
        data: {
          phaseId:       phase.id,
          sourceRow:     issue.sourceRow,
          naturalKey:    issue.naturalKey || undefined,
          sourcePayload: issue.payload as any,
          status:        issue.status as any,
          lastAttemptAt: new Date(),
          attemptCount:  1,
        },
      });
      await prisma.migrationError.create({
        data: {
          recordId: record.id,
          attempt:  1,
          category: issue.status === 'SKIPPED' ? 'DUPLICATE' : 'UNKNOWN',
          message:  issue.message,
        },
      });
    }
  } catch (err: any) {
    console.warn(`[${entity.toUpperCase()}] Could not persist issue report: ${err.message}`);
  }
}

// Builds an .xlsx with a "Skipped" sheet and an "Errors" sheet for the latest run of one
// entity, scoped to the connected company. Each row carries the reason plus every column
// of the original upload, so the file can be corrected and re-uploaded directly.
export async function buildIssueReport(entityId: string): Promise<{ buffer: Buffer; skipped: number; failed: number }> {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  const entityType = ID_TO_ENTITY_TYPE[entityId];
  if (!entityType) {
    const err = new Error(`Unknown entity: ${entityId}`);
    (err as any).statusCode = 400;
    throw err;
  }

  const company = getSessionCompany();
  if (!company) {
    const err = new Error('No FreshBooks connection for this session. Connect on the Connect page.');
    (err as any).statusCode = 409;
    throw err;
  }

  // Most recent phase for this entity belonging to this company.
  const phase = await prisma.migrationPhase.findFirst({
    where:   { entity: entityType as any, run: { token: { accountId: company.accountId } } },
    orderBy: { createdAt: 'desc' },
    include: {
      records: {
        where:   { status: { in: ['SKIPPED', 'FAILED'] } },
        orderBy: { sourceRow: 'asc' },
        include: { errors: { orderBy: { attempt: 'desc' }, take: 1 } },
      },
    },
  });

  const records = phase?.records ?? [];
  const skipped = records.filter(r => r.status === 'SKIPPED');
  const failed  = records.filter(r => r.status === 'FAILED');

  const toSheet = (rows: typeof records, reasonHeader: string) => {
    if (rows.length === 0) {
      return XLSX.utils.aoa_to_sheet([['(none)']]);
    }
    // Union of every original column across the rows, so nothing is dropped when
    // different rows carry different keys.
    const cols = [...new Set(rows.flatMap(r => Object.keys((r.sourcePayload ?? {}) as object)))];
    const out = rows.map(r => {
      const payload = (r.sourcePayload ?? {}) as Record<string, any>;
      const row: Record<string, any> = {
        source_row:   r.sourceRow,
        identifier:   r.naturalKey ?? '',
        [reasonHeader]: r.errors[0]?.message ?? (r.status === 'SKIPPED' ? 'already exists in FreshBooks' : 'Unknown error'),
      };
      for (const c of cols) row[c] = payload[c] ?? '';
      return row;
    });
    return XLSX.utils.json_to_sheet(out, { header: ['source_row', 'identifier', reasonHeader, ...cols] });
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, toSheet(skipped, 'skip_reason'), 'Skipped');
  XLSX.utils.book_append_sheet(wb, toSheet(failed,  'error'),       'Errors');

  return {
    buffer:  XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    skipped: skipped.length,
    failed:  failed.length,
  };
}

// ── Frontend entity ID → runMigration() service key ──────────────────────────
const ID_TO_SERVICE_KEY: Record<string, string> = {
  'clients':          'clients',
  'vendors':          'vendors',
  'items':            'items',
  'services':         'services',
  'expenses':         'expenses',
  'income':           'income',
  'bill-payments':    'bill_payments',
  'invoice-payments': 'invoice_payments',
};

export async function cancelMigration(entityId: string, tokenId?: number | null): Promise<{ cancelled: boolean }> {
  // Signal the in-memory batch loop to stop (for runMigration-based entities).
  // Key includes tokenId so cancelling one user never affects another's migration.
  const serviceKey = ID_TO_SERVICE_KEY[entityId];
  if (serviceKey) {
    cancelledEntities.add(tokenId ? `${tokenId}:${serviceKey}` : serviceKey);
  }

  // Remove from liveProgress so the status endpoint no longer shows it as RUNNING
  liveProgress.delete(tokenId ? `${tokenId}:${entityId}` : entityId);

  // Immediately mark the running phase FAILED in DB so the next status poll reflects it.
  // Resolve the ids first: this must only touch THIS company's phase — unscoped, cancelling
  // here also killed another company's in-flight migration of the same entity.
  const entityType = ID_TO_ENTITY_TYPE[entityId];
  if (entityType) {
    const mine = await prisma.migrationPhase.findMany({
      where:  {
        entity: entityType as any,
        status: 'RUNNING',
        run:    { tokenId: tokenId ?? getSessionTokenId() },
      },
      select: { id: true },
    });
    if (mine.length) {
      await prisma.migrationPhase.updateMany({
        where: { id: { in: mine.map(p => p.id) } },
        data:  { status: 'FAILED', completedAt: new Date() },
      });
    }
  }

  // If no other phases are still running, mark the run as CANCELLED too
  const stillRunning = await prisma.migrationPhase.findFirst({ where: { status: 'RUNNING' } });
  if (!stillRunning) {
    await prisma.migrationRun.updateMany({
      where: { status: 'RUNNING' },
      data:  { status: 'CANCELLED', completedAt: new Date() },
    });
  }

  return { cancelled: true };
}
