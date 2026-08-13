/**
 * Finds (and optionally removes) records created in a FreshBooks company on/after
 * a given date — used to undo a migration that was pushed to the wrong company.
 *
 * SAFE BY DEFAULT: prints a report and deletes nothing.
 *
 *   # 1. See which companies are connected
 *   npx tsx scripts/find-wrong-push.ts --list
 *
 *   # 2. Dry run — show what was created on/after the push date
 *   npx tsx scripts/find-wrong-push.ts --token 3 --since 2026-08-08
 *
 *   # 3. Write the full record list to a file for review
 *   npx tsx scripts/find-wrong-push.ts --token 3 --since 2026-08-08 --out review.json
 *
 *   # 4. ONLY after reviewing: actually delete (reverse dependency order)
 *   npx tsx scripts/find-wrong-push.ts --token 3 --since 2026-08-08 --i-have-reviewed-and-want-to-delete
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';

// The production image ships compiled dist/ only (src/ is not copied), while local
// dev runs from source. Try dist first, fall back to src.
async function load(mod: string): Promise<any> {
  try { return await import(`../dist/${mod}.js`); }
  catch { return await import(`../src/${mod}.js`); }
}
const prisma = (await load('lib/prisma')).default;
const {
  runWithToken, deleteEntityById,
  getBillPayments, getPayments, getCreditNotes, getBills, getInvoices,
  getJournalEntries, getIncome, getExpenses, getServices, getItems,
  getVendors, getClients,
} = await load('services/freshbooks.service');

const args = process.argv.slice(2);
const has  = (f: string) => args.includes(f);
const get  = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };

const DELETE_FLAG = '--i-have-reviewed-and-want-to-delete';

// Reverse dependency order — payments before the documents they belong to,
// documents before the clients/vendors they reference.
const ENTITIES: { id: string; label: string; getAll: () => Promise<any>; pick: (d: any) => any[] }[] = [
  { id: 'bill-payments',    label: 'Bill Payments',    getAll: getBillPayments,   pick: d => d?.response?.result?.bill_payments  || [] },
  { id: 'invoice-payments', label: 'Invoice Payments', getAll: getPayments,       pick: d => d?.response?.result?.payments       || [] },
  { id: 'credit-notes',     label: 'Credit Notes',     getAll: getCreditNotes,    pick: d => d?.response?.result?.credit_notes   || [] },
  { id: 'bills',            label: 'Bills',            getAll: getBills,          pick: d => d?.response?.result?.bills          || [] },
  { id: 'invoices',         label: 'Invoices',         getAll: getInvoices,       pick: d => d?.response?.result?.invoices       || [] },
  { id: 'journal-entries',  label: 'Journal Entries',  getAll: getJournalEntries, pick: d => d?.manualJournalEntries             || [] },
  { id: 'income',           label: 'Income',           getAll: getIncome,         pick: d => d?.response?.result?.other_incomes  || [] },
  { id: 'expenses',         label: 'Expenses',         getAll: getExpenses,       pick: d => d?.response?.result?.expenses       || [] },
  { id: 'services',         label: 'Services',         getAll: getServices,       pick: d => d?.services                         || [] },
  { id: 'items',            label: 'Items',            getAll: getItems,          pick: d => d?.response?.result?.items          || [] },
  { id: 'vendors',          label: 'Vendors',          getAll: getVendors,        pick: d => d?.response?.result?.bill_vendors   || [] },
  { id: 'clients',          label: 'Clients',          getAll: getClients,        pick: d => d?.response?.result?.clients        || [] },
];

// FreshBooks is inconsistent about which timestamp field it returns per entity.
const DATE_FIELDS = ['created_at', 'created', 'date_created', 'updated', 'updated_at', 'signup_date'];

function recordDate(rec: any): { value: Date | null; field: string | null } {
  for (const f of DATE_FIELDS) {
    const raw = rec?.[f];
    if (!raw) continue;
    const d = new Date(typeof raw === 'object' ? raw.date ?? raw : raw);
    if (!isNaN(d.getTime())) return { value: d, field: f };
  }
  return { value: null, field: null };
}

// Human-readable identifier so the review list is checkable against FreshBooks
function labelOf(rec: any): string {
  return rec.invoice_number || rec.billNumber || rec.bill_number || rec.credit_number
      || rec.estimatenum   || rec.organization || rec.vendorName || rec.name
      || rec.description   || rec.entry_id     || `id=${rec.id}`;
}

async function listCompanies() {
  const tokens = await prisma.freshbooksToken.findMany({
    where:   { isActive: true },
    select:  { id: true, companyLabel: true, accountId: true, businessId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!tokens.length) { console.log('No active FreshBooks connections found.'); return; }
  console.log('\nConnected companies:\n');
  for (const t of tokens) {
    console.log(`  --token ${String(t.id).padEnd(4)} ${(t.companyLabel ?? '(unnamed)').padEnd(38)} account=${t.accountId ?? '?'}  connected=${t.createdAt.toISOString().slice(0, 10)}`);
  }
  console.log('');
}

async function main() {
  if (has('--list')) { await listCompanies(); return; }

  const tokenId = Number(get('--token'));
  const sinceIn = get('--since');
  const outFile = get('--out');
  const doDelete = has(DELETE_FLAG);

  if (!tokenId || !sinceIn) {
    console.error('Usage: --token <id> --since <YYYY-MM-DD> [--out file.json] [--list]');
    process.exit(1);
  }

  const since = new Date(sinceIn);
  if (isNaN(since.getTime())) { console.error(`Invalid --since date: ${sinceIn}`); process.exit(1); }

  const token = await prisma.freshbooksToken.findUnique({ where: { id: tokenId } });
  if (!token) { console.error(`No token with id ${tokenId}. Run --list to see options.`); process.exit(1); }

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`  Company : ${token.companyLabel ?? '(unnamed)'}  (token ${tokenId}, account ${token.accountId})`);
  console.log(`  Cutoff  : records created on/after ${since.toISOString().slice(0, 10)}`);
  console.log(`  Mode    : ${doDelete ? '*** DELETE ***' : 'DRY RUN — nothing will be deleted'}`);
  console.log('════════════════════════════════════════════════════════\n');

  const report: Record<string, any[]> = {};
  let grandTotal = 0;

  await runWithToken(tokenId, async () => {
    for (const ent of ENTITIES) {
      let records: any[] = [];
      try {
        records = ent.pick(await ent.getAll());
      } catch (err: any) {
        console.log(`  ${ent.label.padEnd(18)} — could not fetch: ${err.message}`);
        continue;
      }

      const matched: any[] = [];
      let undated = 0;
      for (const rec of records) {
        const { value, field } = recordDate(rec);
        if (!value) { undated++; continue; }
        if (value >= since) matched.push({ id: rec.id, label: labelOf(rec), created: value.toISOString(), dateField: field });
      }

      report[ent.id] = matched;
      grandTotal += matched.length;

      const note = undated > 0 ? `  (${undated} had no usable date — NOT matched)` : '';
      console.log(`  ${ent.label.padEnd(18)} ${String(matched.length).padStart(5)} of ${String(records.length).padStart(5)} on/after cutoff${note}`);
      for (const m of matched.slice(0, 5)) console.log(`      · ${m.label}  (${m.created.slice(0, 10)})`);
      if (matched.length > 5) console.log(`      · … and ${matched.length - 5} more`);
    }
  });

  console.log(`\n  TOTAL MATCHED: ${grandTotal} record(s)\n`);

  if (outFile) {
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`  Full list written to ${outFile} — review it before deleting.\n`);
  }

  if (!doDelete) {
    console.log('  DRY RUN — nothing was deleted.');
    console.log(`  To delete after reviewing, re-run with ${DELETE_FLAG}\n`);
    return;
  }

  console.log('  Deleting in reverse dependency order…\n');
  await runWithToken(tokenId, async () => {
    for (const ent of ENTITIES) {
      const list = report[ent.id] ?? [];
      if (!list.length) continue;
      let ok = 0, fail = 0;
      for (const rec of list) {
        try { await deleteEntityById(ent.id, String(rec.id)); ok++; }
        catch (err: any) { fail++; console.log(`      ✗ ${ent.label} ${rec.label}: ${err?.response?.data?.message || err.message}`); }
      }
      console.log(`  ${ent.label.padEnd(18)} deleted ${ok}, failed ${fail}`);
    }
  });
  console.log('\n  Done.\n');
}

try { await main(); } finally { await prisma.$disconnect(); }
