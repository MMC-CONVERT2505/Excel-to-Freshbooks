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
  getChartOfAccounts, createChartOfAccount, createAccountGroup,
  createService, setServiceRate, getServices,
  getJournalEntries, createJournalEntry,
} from './freshbooks.service.js';

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
  const sheet = await prisma.uploadedSheet.findFirst({
    where: {
      entity: entityId,
      tokenId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { uploadedAt: 'desc' },
  });
  if (!sheet) {
    const err = new Error(`No uploaded file found for "${entityId}". Upload the sheet on the entity page first.`);
    (err as any).statusCode = 400;
    throw err;
  }
  return sheet.rows as Row[];
}

const DELAY_MS    = 200;  // ms delay between batches
const CONCURRENCY = 25;   // parallel workers per batch
const MAX_RETRIES = 4;

// In-memory live progress for custom-loop migrations (invoices, bills, etc.) that don't
// use runMigration(). getMigrationStatus() merges this so the frontend sees real counts.
const liveProgress: Map<string, { done: number; total: number; startedAt: number }> = new Map();

// In-memory cancellation flags — set by cancelMigration(), checked per-batch in runMigration()
const cancelledEntities: Set<string> = new Set();

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function normalizeDate(d: string): string {
  if (!d) return d;
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(d)) {
    const [a, b, yyyy] = d.split('/');
    const first = parseInt(a, 10);
    if (first > 12) return `${yyyy}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    return `${yyyy}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  return d;
}

function isAlreadyExists(err: any): boolean {
  if (err?.response?.status === 409) return true;
  const errors = err?.response?.data?.response?.errors || [];
  return errors.some((e: any) => {
    const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
    return msg.includes('already exists') || msg.includes('already in use');
  });
}

async function callWithRetry(fn: () => Promise<any>): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (isAlreadyExists(err)) return null;
      const status = err?.response?.status;
      const isNetwork = !status && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code);
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(err?.response?.headers?.['retry-after'] || '0', 10);
        const waitMs = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * Math.pow(2, attempt), 60000); // 2s, 4s, 8s… capped at 60s
        console.log(`Rate limited — waiting ${waitMs / 1000}s before retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(waitMs);
      } else if (isNetwork && attempt < MAX_RETRIES) {
        console.log(`Network error (${err.code}) — retrying in 3s (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(3000);
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
    expense_categories: 'EXPENSE',
  };
  const entityType = entityTypeMap[entity] || 'ITEM';

  // ── Duplicate guard: reject if this entity is already RUNNING ─────────────
  const alreadyRunning = await prisma.migrationPhase.findFirst({
    where: { entity: entityType as any, status: 'RUNNING' },
  });
  if (alreadyRunning) {
    const err = new Error(`${entity} migration is already in progress — only one at a time`);
    (err as any).statusCode = 409;
    throw err;
  }

  // Create or reuse MigrationRun
  let activeRun = runId
    ? await prisma.migrationRun.findUnique({ where: { id: runId } })
    : await prisma.migrationRun.findFirst({ where: { status: 'RUNNING' } });

  if (!activeRun) {
    activeRun = await prisma.migrationRun.create({
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date(), tokenId: tokenId ?? null },
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

  console.log(`\n${tag} Starting migration — ${rows.length} records to push (${CONCURRENCY} workers)`);

  const processRow = async (row: Row, i: number) => {
    const label = `${tag} (${i + 1}/${rows.length}) ${getLabel(row)}`;

    const record = await prisma.migrationRecord.create({
      data: {
        phaseId:       phase.id,
        sourceRow:     i + 2,
        naturalKey:    getLabel(row) || undefined,
        sourcePayload: row as any,
        status:        'PENDING',
      },
    });

    if (isDuplicate(row)) {
      result.skipped++;
      await prisma.migrationRecord.update({ where: { id: record.id }, data: { status: 'SKIPPED' } });
      console.log(`${label} → ⚡ skipped (already exists in FreshBooks)`);
      return;
    }

    try {
      const res = await callWithRetry(() => handler(row));
      if (res !== null) {
        result.success++;
        await prisma.migrationRecord.update({ where: { id: record.id }, data: { status: 'SUCCESS', lastAttemptAt: new Date(), attemptCount: { increment: 1 } } });
        console.log(`${label} → ✓ pushed`);
      } else {
        result.skipped++;
        await prisma.migrationRecord.update({ where: { id: record.id }, data: { status: 'SKIPPED' } });
        console.log(`${label} → ⚡ skipped (already exists)`);
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
    if (cancelledEntities.has(entity)) {
      cancelledEntities.delete(entity);
      liveProgress.delete(entity);
      console.log(`${tag} Cancelled by user at row ${i + 1}/${rows.length} — stopping.`);
      result.durationMs = Date.now() - startTime;
      // Phase already marked FAILED by cancelMigration(); just return without overwriting status
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
    existingClients.map((c: any) => `${c.fname || ''}|${c.lname || ''}|${c.organization || ''}`.toLowerCase())
  );

  return runMigration('clients', rows, async (row) => {
    await createClient({
      fname: row.fname,
      lname: row.lname,
      email: row.email,
      organization: row.organization,
      currency_code: row.currency_code || 'USD',
      language: row.language || 'en',
      bus_phone: row.bus_phone,
      mob_phone: row.mob_phone,
      p_street: row.p_street,
      p_street2: row.p_street2,
      p_city: row.p_city,
      p_province: row.p_province,
      p_code: row.p_code,
      p_country: row.p_country,
      note: row.note,
    });
  },
  (row) => `${row.fname} ${row.lname}`.trim() || row.organization,
  (row) => existingKeys.has(`${row.fname}|${row.lname}|${row.organization}`.toLowerCase())
  );
}

// ─── ITEMS ───────────────────────────────────────────────────────────────────

export async function migrateItems(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('items', tokenId);

  const coaRes = await getChartOfAccounts();
  const accounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap, subTypeByUuid } = buildMaps(accounts);
  console.log(`[ITEMS] COA accounts loaded: ${accounts.length}, numberMap keys: ${Object.keys(numberMap).length}`);

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

  // Log unique account numbers from the CSV to compare against numberMap
  const uniqueAccounts = [...new Set(rows.map((r: any) => r.income_account_number).filter(Boolean))];
  console.log('[ITEMS] Unique income_account_numbers in CSV:', uniqueAccounts.slice(0, 10));

  return runMigration('items', rows, async (row) => {
    let income_account_id: string | undefined;

    if (row.income_account_number) {
      const uuid = numberMap[row.income_account_number]
        ?? numberMap[`name::${row.income_account_number.toLowerCase()}`];
      const subType = uuid ? subTypeByUuid[uuid] : 'NOT_FOUND';
      if (uuid && subType === 'Income') {
        income_account_id = uuid;
      }
      if (!income_account_id) {
        console.log(`[ITEMS ACCT] "${row.income_account_number}" → uuid=${uuid ?? 'NOT_FOUND'} subType=${subType} → using Sales default`);
      }
    }

    const payload: Record<string, any> = {
      name: row.name,
      description: row.description,
      sku: row.sku,
      qty: row.qty || '1',
      unit_cost: { amount: row.unit_cost, code: row.currency_code || 'USD' },
      vis_state: 0,
    };
    if (income_account_id) payload.income_account_id = income_account_id;

    const archivedId = archivedByName[row.name.toLowerCase()];
    if (archivedId) {
      await updateItem(archivedId, payload);
    } else {
      await createItem(payload);
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
    const categoryid = catMap[row.category_name?.toLowerCase()] ?? categories[0]?.id;
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
  let rowIndex = 2;

  liveProgress.set('invoices', { done: 0, total: invoiceGroups.length, startedAt: Date.now() });
  console.log(`\n[INVOICES] Starting migration — ${invoiceGroups.length} invoices to push`);

  for (const [invoiceNum, lineRows] of invoiceGroups) {
    const i = result.success + result.failed;
    const label = `[INVOICES] (${i + 1}/${invoiceGroups.length}) #${invoiceNum}`;
    if (existingInvoiceNums.has(invoiceNum.toLowerCase())) {
      result.success++;
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
          name: line.line_name,
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

      const res = await callWithRetry(() => createInvoice({
        customerid,
        invoice_number: header.invoice_number,
        create_date: normalizeDate(header.create_date),
        currency_code: header.currency_code || 'USD',
        due_offset_days: Number(header.due_offset_days) || 30,
        notes: header.notes,
        terms: header.terms,
        language: header.language || 'en',
        status: 2,
        lines,
      }));

      result.success++;
      console.log(res !== null ? `${label} → ✓ pushed` : `${label} → ⚡ skipped (already exists)`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: rowIndex, error: errMsg });
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get('invoices')!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  liveProgress.delete('invoices');
  console.log(`[INVOICES] Done — success: ${result.success}, failed: ${result.failed}`);
  return result;
}

// ─── INCOME ──────────────────────────────────────────────────────────────────

function mapIncomeCategory(_raw: string): string {
  // FreshBooks other_incomes category_name must be a valid enum — 'other' is always safe.
  // Original QBD account name is preserved in the note field.
  return 'other';
}

// Maps QBD transaction types to valid FreshBooks payment_type values
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
  'credit card':         'Credit',
  'credit card charge':  'Credit',
  'credit card credit':  'Credit',
  'credit card refund':  'Credit',
  'cash':                'Cash',
  'cash sale':           'Cash',
  'ach':                 'ACH',
  'wire':                'Wire',
  'online':              'Online',
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
  let rowIndex = 2;

  liveProgress.set('credit-notes', { done: 0, total: cnGroups.length, startedAt: Date.now() });
  console.log(`\n[CREDIT_NOTES] Starting migration — ${cnGroups.length} credit notes to push`);

  for (const [cnNum, lineRows] of cnGroups) {
    const i = result.success + result.failed;
    const label = `[CREDIT_NOTES] (${i + 1}/${cnGroups.length}) #${cnNum}`;
    if (existingCNNums.has(cnNum.toLowerCase())) {
      result.success++;
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
          name: line.line_name,
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
        credit_type: header.credit_type || 'goodwill',
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
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get('credit-notes')!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  liveProgress.delete('credit-notes');
  console.log(`[CREDIT_NOTES] Done — success: ${result.success}, failed: ${result.failed}`);
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
  let rowIndex = 2;

  liveProgress.set('bills', { done: 0, total: billGroups.length, startedAt: Date.now() });
  console.log(`\n[BILLS] Starting migration — ${billGroups.length} bills to push`);

  for (const [billNum, lineRows] of billGroups) {
    const i = result.success + result.failed;
    const label = `[BILLS] (${i + 1}/${billGroups.length}) #${billNum}`;
    const header = lineRows[0];
    const billDedupKey = `${header.vendor_name || ''}|${header.date}`.toLowerCase();
    if (existingBillKeys.has(billDedupKey)) {
      result.success++;
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
        const categoryid = catMap[line.category_name?.toLowerCase()] ?? categories[0]?.id;
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
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    rowIndex += lineRows.length;
    liveProgress.get('bills')!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  liveProgress.delete('bills');
  console.log(`[BILLS] Done — success: ${result.success}, failed: ${result.failed}`);

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

  const billByNumber: Record<string, number> = {};
  const billByVendorDate: Record<string, number> = {};
  const billsByVendor: Record<string, any[]> = {};
  for (const b of bills) {
    if (b.bill_number) billByNumber[b.bill_number.toLowerCase()] = b.id;
    const vName = (b.vendor?.vendor_name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const dateKey = `${vName}|${b.issue_date}`;
    billByVendorDate[dateKey] = b.id;
    if (vName) {
      if (!billsByVendor[vName]) billsByVendor[vName] = [];
      billsByVendor[vName].push(b);
    }
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

    // 1. Match by explicit bill_number
    if (row.bill_number) {
      billid = billByNumber[row.bill_number.toLowerCase()];
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

    if (!billid) throw new Error(`Bill not found for vendor "${row.vendor_name}" — no matching bill for $${row.amount}`);

    const billTypeMap: Record<string, string> = {
      'check': 'Check', 'cheque': 'Check', 'cash': 'Cash',
      'credit card': 'Credit', 'credit': 'Credit',
      'visa': 'Visa', 'mastercard': 'Mastercard', 'master card': 'Mastercard',
      'amex': 'Amex', 'american express': 'Amex',
      'discover': 'Discover', 'diners': 'Diners', 'jcb': 'JCB',
      'paypal': 'PayPal', 'bitcoin': 'Bitcoin',
      'ach': 'Check', 'ach/eft': 'Check', 'eft': 'Check',
      'wire': 'Check', 'wire transfer': 'Check',
      'bank transfer': 'Check', 'electronic check': 'Check', 'echeck': 'Check',
    };
    const rawBillType  = (row.payment_type || '').toLowerCase().trim();
    const safeBillType = billTypeMap[rawBillType] || 'Check';

    await createBillPayment({
      billid,
      amount: { amount: row.amount, code: row.currency_code || 'USD' },
      paid_date: normalizeDate(row.paid_date),
      payment_type: safeBillType,
      note: row.note,
    });

    const bankUuid = row.bank_account_number ? numberMap[row.bank_account_number] : undefined;
    if (pettyCashUuid && bankUuid) {
      const n = ++jeCounter;
      const [yyyy, mm, dd] = normalizeDate(row.paid_date).split('-');
      const billRef = row.bill_number || `BILL-${n}`;
      try {
        await callWithRetry(() => createJournalEntry({
          userEnteredDate:    { year: yyyy, month: mm, day: dd },
          name:               billRef,
          journalEntryNumber: `BILL-${n}`,
          description:        billRef,
          details: [
            { accountId: pettyCashUuid, amount: { amount: row.amount, code: row.currency_code || 'USD' }, type: 'TYPE_DEBIT' },
            { accountId: bankUuid,      amount: { amount: row.amount, code: row.currency_code || 'USD' }, type: 'TYPE_CREDIT' },
          ],
        }));
        console.log(`[BILL-PAY] JE "BILL-${n}" created — offset petty cash for ${billRef}`);
      } catch (jeErr: any) {
        console.warn(`[BILL-PAY] ⚠ Petty cash JE skipped for ${billRef}: ${jeErr?.message}`);
      }
    } else if (pettyCashUuid && !bankUuid && row.bank_account_number) {
      console.warn(`[BILL-PAY] Bank account "${row.bank_account_number}" not found in COA — JE skipped for ${row.bill_number}`);
    }
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

  // Fetch all invoices and build lookup maps
  const invoiceRes = await getInvoices();
  const invoices: any[] = invoiceRes?.response?.result?.invoices || [];
  console.log(`[INV-PAY] Fetched ${invoices.length} invoices. Sample numbers: ${invoices.slice(0, 5).map((i: any) => i.invoice_number).join(', ')}`);

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

    // 3. Fallback: match by customer + amount
    if (!invoiceid) {
      console.warn(`[INV-PAY] Invoice #${row.invoice_number} not found in FreshBooks — trying client+amount fallback`);

      let clientid: number | undefined;
      for (const v of clientNameVariants(row.customer_name || '')) {
        if (clientByName[v]) { clientid = clientByName[v]; break; }
      }
      if (!clientid) {
        throw new Error(
          `Invoice #${row.invoice_number} not found in FreshBooks, and client "${row.customer_name}" was not found either. ` +
          `Push invoices first, then re-push invoice payments.`
        );
      }

      const clientInvoices = invoicesByClient[clientid] || [];
      const payAmt = parseFloat(row.amount);

      const matched = clientInvoices.find(inv =>
        Math.abs(parseFloat(inv.outstanding?.amount || '0') - payAmt) < 0.01
      ) || clientInvoices.find(inv =>
        Math.abs(parseFloat(inv.amount?.amount || '0') - payAmt) < 0.01
      );

      if (!matched) throw new Error(`Invoice #${row.invoice_number} not found in FreshBooks. Push invoices first, then re-push invoice payments.`);
      invoiceid = matched.id;
    }

    // Map common QBD payment types to FreshBooks-safe values (no spaces or slashes)
    const typeMap: Record<string, string> = {
      'check': 'Check', 'cheque': 'Check', 'cash': 'Cash',
      'credit card': 'Credit', 'credit': 'Credit',
      'visa': 'Visa', 'mastercard': 'Mastercard', 'master card': 'Mastercard',
      'amex': 'Amex', 'american express': 'Amex',
      'discover': 'Discover', 'diners': 'Diners', 'jcb': 'JCB',
      'paypal': 'PayPal', 'bitcoin': 'Bitcoin',
      'ach': 'Check', 'ach/eft': 'Check', 'eft': 'Check',
      'wire': 'Check', 'wire transfer': 'Check',
      'bank transfer': 'Check', 'electronic check': 'Check', 'echeck': 'Check',
    };
    const rawType   = (row.payment_type || '').toLowerCase().trim();
    const safeType  = typeMap[rawType] || 'Check';

    await createPayment({
      invoiceid,
      amount: { amount: row.amount, code: row.currency_code || 'USD' },
      date: normalizeDate(row.date),
      type: safeType,
      note: row.note,
    });

    const bankUuid = row.bank_account_number ? numberMap[row.bank_account_number] : undefined;
    if (pettyCashUuid && bankUuid) {
      const n = ++jeCounter;
      const [yyyy, mm, dd] = normalizeDate(row.date).split('-');
      const invoiceRef = row.invoice_number || `INV-${n}`;
      try {
        await callWithRetry(() => createJournalEntry({
          userEnteredDate:    { year: yyyy, month: mm, day: dd },
          name:               invoiceRef,
          journalEntryNumber: `INV-${n}`,
          description:        invoiceRef,
          details: [
            { accountId: bankUuid,      amount: { amount: row.amount, code: row.currency_code || 'USD' }, type: 'TYPE_DEBIT' },
            { accountId: pettyCashUuid, amount: { amount: row.amount, code: row.currency_code || 'USD' }, type: 'TYPE_CREDIT' },
          ],
        }));
        console.log(`[INV-PAY] JE "INV-${n}" created — offset petty cash for ${invoiceRef}`);
      } catch (jeErr: any) {
        console.warn(`[INV-PAY] ⚠ Petty cash JE skipped for ${invoiceRef}: ${jeErr?.message}`);
      }
    } else if (pettyCashUuid && !bankUuid && row.bank_account_number) {
      console.warn(`[INV-PAY] Bank account "${row.bank_account_number}" not found in COA — JE skipped for ${row.invoice_number}`);
    }
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
} {
  const numberMap:     Record<string, string> = {};
  const subTypeByUuid: Record<string, string> = {};

  function traverse(items: any[]) {
    for (const item of items) {
      if (item.account_number && item.account_uuid) {
        numberMap[item.account_number] = item.account_uuid;
      }
      const itemName = item.account_name || item.name;
      if (itemName && item.account_uuid) {
        numberMap[`name::${itemName.toLowerCase()}`] = item.account_uuid;
      }
      if (item.account_uuid && item.account_sub_type) {
        subTypeByUuid[item.account_uuid] = item.account_sub_type;
      }
      if (item.sub_accounts?.length) traverse(item.sub_accounts);
    }
  }
  traverse(accounts);
  return { numberMap, subTypeByUuid };
}


export async function migrateChartOfAccounts(tokenId: number | null = null): Promise<MigrationResult> {
  const rows = await readUploadedRows('chart-of-accounts', tokenId);

  const coaRes = await getChartOfAccounts();
  const accounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];

  const { numberMap, subTypeByUuid } = buildMaps(accounts);
  console.log(`\n[COA] Loaded ${accounts.length} accounts from FreshBooks into lookup map`);

  const result: MigrationResult = { entity: 'chart_of_accounts', total: rows.length, success: 0, skipped: 0, failed: 0, durationMs: 0, errors: [] };

  liveProgress.set('chart-of-accounts', { done: 0, total: rows.length, startedAt: Date.now() });
  console.log(`\n[COA] Starting migration — ${rows.length} accounts to push`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `[COA] (${i + 1}/${rows.length}) ${row.number || '(no number)'} - ${row.name}`;
    try {
      const parentNumber = row.parent_account_number || '';
      let parent_account = parentNumber
        ? (numberMap[parentNumber] ?? numberMap[`name::${parentNumber.toLowerCase()}`])
        : undefined;

      // If parent UUID found but sub_type doesn't match → wrong FreshBooks account
      // (happens when FB default account number collides with QBD number e.g. FB uses 3000=equity)
      if (parent_account && row.sub_type) {
        const parentSubType = subTypeByUuid[parent_account];
        if (parentSubType && parentSubType !== row.sub_type) {
          parent_account = undefined;
        }
      }

      // Fallback to DEFAULT_PARENT when parent missing or type mismatch
      if (parentNumber && !parent_account) {
        const fallbackNum = DEFAULT_PARENT[`${row.type}|${row.sub_type}`];
        parent_account = fallbackNum ? numberMap[fallbackNum] : undefined;
        if (parent_account) {
          console.log(`${label} → parent ${parentNumber} not found, routing to default parent ${fallbackNum}`);
        } else {
          throw new Error(`Parent account not found for number: ${parentNumber}`);
        }
      }

      const isChild = Boolean(parentNumber);

      // Number collision: FreshBooks already has an account at this number
      // (e.g. its default "1000 - Cash" vs QBD "1000 - CSB Checking").
      // Increment until we find a free slot: 1000 → 1001 → 1002 ...
      let accountNumber = row.number;
      if (accountNumber && numberMap[accountNumber]) {
        const n = parseInt(accountNumber, 10);
        accountNumber = !isNaN(n) ? String(n + 1) : `${accountNumber}-1`;
        console.log(`${label} → number collision, using ${accountNumber}`);
      }

      const payload: Record<string, any> = {
        name:     row.name,
        type:     row.type,
        sub_type: row.sub_type,
        state:    row.state || 'active',
      };
      if (accountNumber) payload.number = accountNumber;

      const res = parent_account
        ? await callWithRetry(() => createChartOfAccount({ ...payload, parent_account }))
        : await callWithRetry(() => createAccountGroup(payload));

      // Add newly created account to map so subsequent rows can use it as parent
      const inner   = res?.data || res;
      const created = inner?.ledger_account || inner?.journal_entry_account || inner;
      const createdNumber = created?.account_number || created?.number;
      const createdUuid   = created?.account_uuid   || created?.uuid || created?.id;
      if (createdUuid) {
        // Register by number (if available)
        if (createdNumber) {
          numberMap[createdNumber] = createdUuid;
          if (row.number && createdNumber !== row.number) numberMap[row.number] = createdUuid;
        }
        // Always register by name so N/P (numberless) accounts can still be found by children
        if (row.name) numberMap[`name::${row.name.toLowerCase()}`] = createdUuid;
        console.log(`[COA] Registered: ${createdNumber || '(no number)'} / name::${row.name} → ${createdUuid}`);
      }

      // If skipped (already exists) but this is a top-level account, recover its UUID
      // by name so its children can find it — handles FreshBooks default accounts
      // that have no account_number stored in their API response
      if (!res && !isChild && row.number) {
        const fallback = numberMap[`name::${row.name.toLowerCase()}`];
        if (fallback) numberMap[row.number] = fallback;
      }

      result.success++;
      console.log(res ? `${label} → ✓ pushed` : `${label} → ⚡ skipped (already exists)`);
    } catch (err: any) {
      result.failed++;
      const detail = err?.response?.data;
      const errMsg = detail ? JSON.stringify(detail) : err.message;
      result.errors.push({ row: i + 2, error: errMsg });
      console.log(`${label} → ❌ failed: ${errMsg}`);
    }
    liveProgress.get('chart-of-accounts')!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  liveProgress.delete('chart-of-accounts');
  console.log(`[COA] Done — success: ${result.success}, failed: ${result.failed}`);
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

  const coaRes = await getChartOfAccounts();
  const accounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
  const { numberMap, subTypeByUuid } = buildMaps(accounts);

  const existingServicesRes = await getServices();
  const existingServices: any[] = existingServicesRes?.services || [];
  const existingServiceKeys = new Set(existingServices.map((s: any) => (s.name || '').toLowerCase()));

  return runMigration('services', rows, async (row) => {
    const payload: Record<string, any> = { name: row.name };

    if (row.billable) payload.billable = row.billable === 'true';

    let income_account_id: string | undefined;
    if (row.income_account_number) {
      const uuid = numberMap[row.income_account_number]
        ?? numberMap[`name::${row.income_account_number.toLowerCase()}`];
      if (uuid && subTypeByUuid[uuid] === 'Income') income_account_id = uuid;
    }
    if (income_account_id) payload.income_account_id = income_account_id;

    const res = await createService(payload);
    const serviceId = res?.service?.id;

    if (serviceId && row.rate) {
      await setServiceRate(serviceId, row.rate);
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
  const existingEntries: any[] = existingRes?.manualJournalEntries || existingRes?.journal_entries || [];
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

  liveProgress.set('journal-entries', { done: 0, total: entryGroups.length, startedAt: Date.now() });
  console.log(`\n[JE] Starting migration — ${entryGroups.length} journal entries to push (${CONCURRENCY} workers)`);

  for (let i = 0; i < entryGroups.length; i += CONCURRENCY) {
    const batch = entryGroups.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ([entryNum, lineRows], bi) => {
      const idx   = i + bi;
      const label = `[JE] (${idx + 1}/${entryGroups.length}) #${entryNum}`;

      if (existingNums.has(entryNum.toLowerCase())) {
        result.skipped++;
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
        console.log(`${label} → ❌ failed: ${errMsg}`);
      }
    }));

    liveProgress.get('journal-entries')!.done = result.success + result.failed + result.skipped;
    await sleep(DELAY_MS);
  }

  liveProgress.delete('journal-entries');
  console.log(`[JE] Done — success: ${result.success}, failed: ${result.failed}`);
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
  results.push(await migrateBills(tokenId));             // 11 — needs vendors, categories
  results.push(await migrateCreditNotes(tokenId));       // 12 — needs clients
  results.push(await migrateInvoicePayments(tokenId));   // 13 — needs invoices to exist first
  results.push(await migrateBillPayments(tokenId));      // 14 — needs bills to exist first

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
};

export async function getMigrationStatus(tokenId?: number | null) {
  // Scope to the session's tokenId so each user sees only their own history.
  // Falls back to isCurrent token for unauthenticated / legacy calls.
  let scopeTokenId = tokenId ?? null;
  if (!scopeTokenId) {
    const currentToken = await prisma.freshbooksToken.findFirst({ where: { isCurrent: true } });
    scopeTokenId = currentToken?.id ?? null;
  }

  // Get the most recent phase for EACH entity across ALL runs for this company.
  // We do this because DAG scheduling can create multiple runs:
  // fast entities complete their run, later entities create a new one.
  // Grouping by entity gives the true last-known state per entity.
  const allPhases = await prisma.migrationPhase.findMany({
    where: {
      status: { in: ['COMPLETED', 'PARTIAL', 'FAILED', 'RUNNING'] },
      ...(scopeTokenId ? { run: { tokenId: scopeTokenId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      records: {
        where: { status: 'FAILED' },
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
    const errors = phase.records.map(record => ({
      row:   record.sourceRow,
      error: record.errors[0]?.message ?? 'Unknown error',
    }));

    return {
      entity:      ENTITY_TYPE_TO_ID[String(phase.entity)] ?? String(phase.entity).toLowerCase(),
      status:      phase.status,
      total:       phase.totalRecords,
      success:     phase.successCount,
      skipped:     phase.skippedCount,
      failed:      phase.failedCount,
      durationMs:  phase.durationMs ?? 0,
      completedAt: phase.completedAt?.toISOString() ?? null,
      startedAt:   phase.startedAt?.toISOString()   ?? null,
      errors,
    };
  });

  // Always merge liveProgress BEFORE checking for empty — a migration can be actively
  // running even when allPhases is empty (e.g. new company token, no DB phases yet,
  // or the current run hasn't written its first phase to DB yet).
  for (const [entity, prog] of liveProgress) {
    const runningPhase = {
      entity,
      status:      'RUNNING' as const,
      total:       prog.total,
      success:     prog.done,
      skipped:     0,
      failed:      0,
      durationMs:  Date.now() - prog.startedAt,
      completedAt: null,
      startedAt:   new Date(prog.startedAt).toISOString(),
      errors:      [],
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
  'credit-notes':      'CREDIT_NOTE',
  'bills':             'BILL',
  'bill-payments':     'BILL_PAYMENT',
  'invoice-payments':  'INVOICE_PAYMENT',
  'chart-of-accounts': 'CHART_OF_ACCOUNTS',
  'journal-entries':   'JOURNAL_ENTRY',
};

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

export async function cancelMigration(entityId: string): Promise<{ cancelled: boolean }> {
  // Signal the in-memory batch loop to stop (for runMigration-based entities)
  const serviceKey = ID_TO_SERVICE_KEY[entityId];
  if (serviceKey) cancelledEntities.add(serviceKey);

  // Remove from liveProgress so the status endpoint no longer shows it as RUNNING
  liveProgress.delete(entityId);

  // Immediately mark the running phase FAILED in DB so the next status poll reflects it
  const entityType = ID_TO_ENTITY_TYPE[entityId];
  if (entityType) {
    await prisma.migrationPhase.updateMany({
      where: { entity: entityType as any, status: 'RUNNING' },
      data:  { status: 'FAILED', completedAt: new Date() },
    });
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
