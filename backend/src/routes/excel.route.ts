import { Router } from 'express';
import { createRequire } from 'module';
import prisma from '../lib/prisma.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

type EntityFile = {
  id: string;
  name: string;
  required: Array<string | string[]>;
};

type DryRunIssue = {
  row: number;
  sev: 'error' | 'warning';
  field: string;
  value: string;
  msg: string;
  fix: string;
};

type Row = Record<string, string>;

const EXCEL_FILES: Record<string, EntityFile> = {
  'chart-of-accounts': {
    id: 'chart-of-accounts',
    name: 'Chart of Accounts',
    required: ['name', 'type', 'sub_type'],
  },
  'expense-categories': {
    id: 'expense-categories',
    name: 'Expense Categories',
    required: ['category_name'],
  },
  clients: {
    id: 'clients',
    name: 'Clients',
    required: ['organization'],
  },
  vendors: {
    id: 'vendors',
    name: 'Vendors',
    required: ['vendor_name'],
  },
  items: {
    id: 'items',
    name: 'Items',
    required: ['name', 'unit_cost', 'income_account_number', 'currency_code'],
  },
  services: {
    id: 'services',
    name: 'Services',
    required: ['name', 'rate', 'income_account_number'],
  },
  expenses: {
    id: 'expenses',
    name: 'Expenses',
    required: ['date', 'amount', 'category_name', 'vendor', 'currency_code'],
  },
  income: {
    id: 'income',
    name: 'Income',
    required: ['date', 'amount', 'category_name', 'currency_code'],
  },
  'journal-entries': {
    id: 'journal-entries',
    name: 'Journal Entries',
    required: ['entry_number', 'date', ['account_number', 'account_name'], ['debit', 'credit'], 'name', 'currency_code'],
  },
  invoices: {
    id: 'invoices',
    name: 'Invoices',
    required: ['invoice_number', 'customer_name', 'create_date', 'line_name', 'line_qty', 'line_unit_cost'],
  },
  bills: {
    id: 'bills',
    name: 'Bills',
    required: ['bill_number', 'vendor_name', 'date', 'category_name', 'amount', 'quantity', 'currency_code', 'due_offset_days'],
  },
  'credit-notes': {
    id: 'credit-notes',
    name: 'Credit Notes',
    required: ['credit_note_number', 'customer_name', 'date', 'amt', 'line_name', 'customer_email', 'currency_code', 'credit_type'],
  },
  'invoice-payments': {
    id: 'invoice-payments',
    name: 'Invoice Payments',
    required: ['invoice_number', 'amount', 'date', 'payment_type', 'currency_code', 'bank_account_number'],
  },
  'bill-payments': {
    id: 'bill-payments',
    name: 'Bill Payments',
    required: ['bill_number', 'amount', 'paid_date', 'payment_type', 'currency_code', 'bank_account_number'],
  },
};

const router = Router();

// ── Normalise raw XLSX rows to {string: string} — same logic as migration service ──
function toRow(rawRows: any[]): Row[] {
  return rawRows.map(row => {
    const out: Row = {};
    for (const key of Object.keys(row)) {
      const val = row[key];
      if (val instanceof Date) {
        out[key] = val.toISOString().split('T')[0];
      } else if (typeof val === 'number' && val > 40000 && val < 60000 && key.toLowerCase().includes('date')) {
        const d = new Date(Math.round((val - 25569) * 86400 * 1000));
        out[key] = d.toISOString().split('T')[0];
      } else {
        out[key] = String(val);
      }
    }
    return out;
  });
}

function decodeBase64(input: string): Buffer {
  const clean = input.includes(',') ? input.split(',').pop() || '' : input;
  return Buffer.from(clean, 'base64');
}

function parseExcelBuffer(buffer: Buffer): Row[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return toRow(XLSX.utils.sheet_to_json(ws, { defval: '' }) as any[]);
}

function getCurrentTokenId(req: any): number | null {
  return (req as any).sessionTokenId ?? null;
}

// Read uploaded rows for an entity from DB (used by dry-run cross-checks)
async function loadRowsFor(entityId: string, tokenId: number | null): Promise<Row[]> {
  const sheet = await prisma.uploadedSheet.findFirst({
    where: { entity: entityId, tokenId: tokenId },
    orderBy: { uploadedAt: 'desc' },
  });
  return sheet ? (sheet.rows as Row[]) : [];
}

// ── helpers ────────────────────────────────────────────────────────────────────
function colLabel(req: string | string[]) {
  return Array.isArray(req) ? req.join(' or ') : req;
}
function hasAnyColumn(columns: string[], req: string | string[]) {
  const lower = new Set(columns.map(c => c.toLowerCase()));
  const options = Array.isArray(req) ? req : [req];
  return options.some(c => lower.has(c.toLowerCase()));
}
function rowValue(row: Row, req: string | string[]) {
  const options = Array.isArray(req) ? req : [req];
  for (const key of options) {
    const actual = Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase());
    if (actual && String(row[actual] ?? '').trim()) return String(row[actual]).trim();
  }
  return '';
}

function push(issues: DryRunIssue[], row: number, sev: 'error' | 'warning', field: string, value: string, msg: string, fix: string) {
  issues.push({ row, sev, field, value, msg, fix });
}

// ─── VALID VALUE SETS ─────────────────────────────────────────────────────────
const VALID_PAYMENT_TYPES = new Set(['check', 'cash', 'credit', 'ach', 'wire', 'online']);
const VALID_CREDIT_TYPES  = new Set(['goodwill', 'overpayment', 'credit']);

// ─── ISO 4217 common currency codes ──────────────────────────────────────────
const ISO_CURRENCIES = new Set([
  'USD','EUR','GBP','CAD','AUD','NZD','JPY','CHF','CNY','HKD','SGD','SEK','NOK',
  'DKK','MXN','BRL','INR','ZAR','AED','SAR','MYR','PHP','THB','IDR','TWD','KRW',
  'CZK','HUF','PLN','TRY','ILS','CLP','COP','PEN','VND','EGP','PKR','BDT','NGN',
]);

// ─── BATCH 1: within-file validations ────────────────────────────────────────
function runBatch1(entity: EntityFile, rows: Row[], issues: DryRunIssue[]) {
  const id = entity.id;

  // Journal Entries: debits must equal credits per entry_number group
  if (id === 'journal-entries') {
    const groups: Record<string, { debit: number; credit: number; firstRow: number }> = {};
    for (let i = 0; i < rows.length; i++) {
      const num = String(rows[i].entry_number || '').trim();
      if (!num) continue;
      if (!groups[num]) groups[num] = { debit: 0, credit: 0, firstRow: i + 2 };
      groups[num].debit  += parseFloat(String(rows[i].debit  || 0)) || 0;
      groups[num].credit += parseFloat(String(rows[i].credit || 0)) || 0;
    }
    for (const [num, { debit, credit, firstRow }] of Object.entries(groups)) {
      if (Math.abs(debit - credit) > 0.01) {
        push(issues, firstRow, 'error', 'debit/credit', num,
          `Entry #${num} is unbalanced — debits ${debit.toFixed(2)} ≠ credits ${credit.toFixed(2)}.`,
          'Make sure total debits equal total credits for every entry_number group.');
      }
    }
  }

  // Invoices: line_qty must be > 0
  if (id === 'invoices') {
    for (let i = 0; i < rows.length; i++) {
      const raw = String(rows[i].line_qty ?? '').trim();
      if (!raw) continue;
      const qty = parseFloat(raw);
      if (isNaN(qty) || qty <= 0) {
        push(issues, i + 2, 'error', 'line_qty', raw,
          `Line quantity "${raw}" is zero or negative — FreshBooks rejects this.`,
          'Set a positive quantity (> 0) for every invoice line.');
      }
    }
  }

  // Vendors: vendor_name cannot be N/A, -, na, none, etc.
  if (id === 'vendors') {
    const JUNK = /^(n\/a|na|none|null|-|\.+)$/i;
    for (let i = 0; i < rows.length; i++) {
      const name = String(rows[i].vendor_name || '').trim();
      if (name && JUNK.test(name)) {
        push(issues, i + 2, 'error', 'vendor_name', name,
          `Vendor name "${name}" is a placeholder value — FreshBooks will reject it.`,
          'Replace with the real vendor name or remove the row.');
      }
    }
  }

  // payment_type must be a valid FreshBooks value
  const PAYMENT_TYPE_ENTITIES = new Set(['invoice-payments', 'bill-payments', 'income', 'expenses']);
  if (PAYMENT_TYPE_ENTITIES.has(id)) {
    for (let i = 0; i < rows.length; i++) {
      const raw = String(rows[i].payment_type || '').trim();
      if (raw && !VALID_PAYMENT_TYPES.has(raw.toLowerCase())) {
        push(issues, i + 2, 'warning', 'payment_type', raw,
          `"${raw}" is not a valid payment type.`,
          'Use one of: Check, Cash, Credit, ACH, Wire, Online.');
      }
    }
  }

  // credit-notes: credit_type must be valid
  if (id === 'credit-notes') {
    for (let i = 0; i < rows.length; i++) {
      const raw = String(rows[i].credit_type || '').trim();
      if (raw && !VALID_CREDIT_TYPES.has(raw.toLowerCase())) {
        push(issues, i + 2, 'error', 'credit_type', raw,
          `"${raw}" is not a valid credit type.`,
          'Use one of: goodwill, overpayment, credit.');
      }
    }
  }

  // Invoices: same invoice_number but different customer_name = data corruption
  if (id === 'invoices') {
    const invoiceCustomer: Record<string, string> = {};
    for (let i = 0; i < rows.length; i++) {
      const num  = String(rows[i].invoice_number  || '').trim();
      const cust = String(rows[i].customer_name || '').trim().toLowerCase();
      if (!num) continue;
      if (!invoiceCustomer[num]) { invoiceCustomer[num] = cust; continue; }
      if (invoiceCustomer[num] !== cust) {
        push(issues, i + 2, 'error', 'invoice_number', num,
          `Invoice #${num} has conflicting customer names across rows.`,
          'All rows with the same invoice_number must have the same customer_name.');
      }
    }
  }

  // Bills: same bill_number but different vendor_name
  if (id === 'bills') {
    const billVendor: Record<string, string> = {};
    for (let i = 0; i < rows.length; i++) {
      const num    = String(rows[i].bill_number  || '').trim();
      const vendor = String(rows[i].vendor_name || '').trim().toLowerCase();
      if (!num) continue;
      if (!billVendor[num]) { billVendor[num] = vendor; continue; }
      if (billVendor[num] !== vendor) {
        push(issues, i + 2, 'error', 'bill_number', num,
          `Bill #${num} has conflicting vendor names across rows.`,
          'All rows with the same bill_number must have the same vendor_name.');
      }
    }
  }

  // Invoices: same invoice_number but different date or currency
  if (id === 'invoices') {
    const headerDate: Record<string, string>     = {};
    const headerCurrency: Record<string, string> = {};
    for (let i = 0; i < rows.length; i++) {
      const num  = String(rows[i].invoice_number || '').trim();
      const date = String(rows[i].create_date    || '').trim();
      const curr = String(rows[i].currency_code  || '').trim().toUpperCase();
      if (!num) continue;
      if (!headerDate[num]) { headerDate[num] = date; headerCurrency[num] = curr; continue; }
      if (date && headerDate[num] && headerDate[num] !== date)
        push(issues, i + 2, 'warning', 'create_date', date,
          `Invoice #${num} has inconsistent dates across rows.`,
          'All rows for the same invoice must share the same create_date.');
      if (curr && headerCurrency[num] && headerCurrency[num] !== curr)
        push(issues, i + 2, 'warning', 'currency_code', curr,
          `Invoice #${num} has inconsistent currency codes.`,
          'All rows for the same invoice must use the same currency_code.');
    }
  }
  if (id === 'bills') {
    const headerDate: Record<string, string> = {};
    for (let i = 0; i < rows.length; i++) {
      const num  = String(rows[i].bill_number || '').trim();
      const date = String(rows[i].date        || '').trim();
      if (!num) continue;
      if (!headerDate[num]) { headerDate[num] = date; continue; }
      if (date && headerDate[num] && headerDate[num] !== date)
        push(issues, i + 2, 'warning', 'date', date,
          `Bill #${num} has inconsistent dates across rows.`,
          'All rows for the same bill must share the same date.');
    }
  }

  // Clients: duplicate organization names
  if (id === 'clients') {
    const seen = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const org = String(rows[i].organization || '').trim().toLowerCase();
      if (!org) continue;
      if (seen.has(org)) {
        push(issues, i + 2, 'warning', 'organization', rows[i].organization,
          `Organization "${rows[i].organization}" appears more than once (first at row ${seen.get(org)}).`,
          'Duplicate organizations will create duplicate clients in FreshBooks — remove one.');
      } else { seen.set(org, i + 2); }
    }
  }

  // Vendors: duplicate vendor names
  if (id === 'vendors') {
    const seen = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const name = String(rows[i].vendor_name || '').trim().toLowerCase();
      if (!name) continue;
      if (seen.has(name)) {
        push(issues, i + 2, 'warning', 'vendor_name', rows[i].vendor_name,
          `Vendor "${rows[i].vendor_name}" appears more than once (first at row ${seen.get(name)}).`,
          'Duplicate vendor names will create duplicates in FreshBooks — remove one.');
      } else { seen.set(name, i + 2); }
    }
  }
}

// ─── BATCH 2: cross-file validations — reads sibling sheets from DB ───────────
async function runBatch2(entity: EntityFile, rows: Row[], issues: DryRunIssue[], tokenId: number | null) {
  const id = entity.id;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

  // Invoice customer_name must exist in clients file
  if (id === 'invoices') {
    const clientRows = await loadRowsFor('clients', tokenId);
    if (clientRows.length) {
      const clientNames = new Set<string>();
      for (const r of clientRows) {
        if (r.organization) clientNames.add(norm(String(r.organization)));
        const full = `${r.fname || ''} ${r.lname || ''}`.trim();
        if (full) clientNames.add(norm(full));
      }
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const cust = String(rows[i].customer_name || '').trim();
        if (!cust || seen.has(cust.toLowerCase())) continue;
        if (!clientNames.has(norm(cust))) {
          seen.add(cust.toLowerCase());
          push(issues, i + 2, 'warning', 'customer_name', cust,
            `"${cust}" not found in the uploaded Clients file.`,
            'The migration will auto-create this client — verify the name is correct or add them to Clients first.');
        }
      }
    }
  }

  // Bill vendor_name must exist in vendors file
  if (id === 'bills') {
    const vendorRows = await loadRowsFor('vendors', tokenId);
    if (vendorRows.length) {
      const vendorNames = new Set(vendorRows.map(r => norm(String(r.vendor_name || ''))));
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const v = String(rows[i].vendor_name || '').trim();
        if (!v || seen.has(v.toLowerCase())) continue;
        if (!vendorNames.has(norm(v))) {
          seen.add(v.toLowerCase());
          push(issues, i + 2, 'warning', 'vendor_name', v,
            `"${v}" not found in the uploaded Vendors file.`,
            'The migration will auto-create this vendor — verify the name or add them to Vendors first.');
        }
      }
    }
  }

  // Invoice Payments: bank_account_number must exist in COA
  if (id === 'invoice-payments') {
    const coaRows = await loadRowsFor('chart-of-accounts', tokenId);
    if (coaRows.length) {
      const coaNums = new Set(coaRows.map(r => String(r.number || '').trim()));
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const acct = String(rows[i].bank_account_number || '').trim();
        if (!acct || seen.has(acct)) continue;
        if (!coaNums.has(acct)) {
          seen.add(acct);
          push(issues, i + 2, 'error', 'bank_account_number', acct,
            `Bank account "${acct}" not found in the uploaded Chart of Accounts.`,
            'Push Chart of Accounts first or check the account number.');
        }
      }
    }
  }

  // Invoice Payments: invoice_number must exist in invoices file
  if (id === 'invoice-payments') {
    const invoiceRows = await loadRowsFor('invoices', tokenId);
    if (invoiceRows.length) {
      const invoiceNums = new Set(invoiceRows.map(r => String(r.invoice_number || '').toLowerCase().trim()));
      for (let i = 0; i < rows.length; i++) {
        const num = String(rows[i].invoice_number || '').trim();
        if (!num) continue;
        if (!invoiceNums.has(num.toLowerCase()))
          push(issues, i + 2, 'error', 'invoice_number', num,
            `Invoice #${num} not found in the uploaded Invoices file.`,
            'This payment will fail — add the invoice to the Invoices file or push Invoices first.');
      }
    }
  }

  // Bill Payments: bank_account_number must exist in COA
  if (id === 'bill-payments') {
    const coaRows = await loadRowsFor('chart-of-accounts', tokenId);
    if (coaRows.length) {
      const coaNums = new Set(coaRows.map(r => String(r.number || '').trim()));
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const acct = String(rows[i].bank_account_number || '').trim();
        if (!acct || seen.has(acct)) continue;
        if (!coaNums.has(acct)) {
          seen.add(acct);
          push(issues, i + 2, 'error', 'bank_account_number', acct,
            `Bank account "${acct}" not found in the uploaded Chart of Accounts.`,
            'Push Chart of Accounts first or check the account number.');
        }
      }
    }
  }

  // Bill Payments: bill_number must exist in bills file
  if (id === 'bill-payments') {
    const billRows = await loadRowsFor('bills', tokenId);
    if (billRows.length) {
      const billNums = new Set(billRows.map(r => String(r.bill_number || '').toLowerCase().trim()));
      for (let i = 0; i < rows.length; i++) {
        const num = String(rows[i].bill_number || '').trim();
        if (!num) continue;
        if (!billNums.has(num.toLowerCase()))
          push(issues, i + 2, 'error', 'bill_number', num,
            `Bill #${num} not found in the uploaded Bills file.`,
            'This payment will fail — add the bill to the Bills file or push Bills first.');
      }
    }
  }

  // Credit Notes: customer_name must exist in clients file
  if (id === 'credit-notes') {
    const clientRows = await loadRowsFor('clients', tokenId);
    if (clientRows.length) {
      const clientNames = new Set<string>();
      for (const r of clientRows) {
        if (r.organization) clientNames.add(norm(String(r.organization)));
        const full = `${r.fname || ''} ${r.lname || ''}`.trim();
        if (full) clientNames.add(norm(full));
      }
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const cust = String(rows[i].customer_name || '').trim();
        if (!cust || seen.has(cust.toLowerCase())) continue;
        if (!clientNames.has(norm(cust))) {
          seen.add(cust.toLowerCase());
          push(issues, i + 2, 'error', 'customer_name', cust,
            `"${cust}" not found in the uploaded Clients file.`,
            'Credit notes cannot auto-create clients — push Clients first, or fix the name.');
        }
      }
    }
  }

  // Items / Services: income_account_number must exist in COA
  if (id === 'items' || id === 'services') {
    const coaRows = await loadRowsFor('chart-of-accounts', tokenId);
    if (coaRows.length) {
      const coaNums  = new Set(coaRows.map(r => String(r.number || '').trim()));
      const coaNames = new Set(coaRows.map(r => norm(String(r.name || ''))));
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const acct = String(rows[i].income_account_number || '').trim();
        if (!acct || seen.has(acct)) continue;
        if (!coaNums.has(acct) && !coaNames.has(norm(acct))) {
          seen.add(acct);
          push(issues, i + 2, 'warning', 'income_account_number', acct,
            `Account "${acct}" not found in the uploaded Chart of Accounts.`,
            'Push Chart of Accounts first or check the account number.');
        }
      }
    }
  }

  // Journal Entries: account_number / account_name must exist in COA
  if (id === 'journal-entries') {
    const coaRows = await loadRowsFor('chart-of-accounts', tokenId);
    if (coaRows.length) {
      const coaNums  = new Set(coaRows.map(r => String(r.number || '').trim()));
      const coaNames = new Set(coaRows.map(r => norm(String(r.name || ''))));
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const num  = String(rows[i].account_number || '').trim();
        const name = String(rows[i].account_name  || '').trim();
        const key  = num || name;
        if (!key || seen.has(key.toLowerCase())) continue;
        const found = (num && coaNums.has(num)) || (name && coaNames.has(norm(name)));
        if (!found) {
          seen.add(key.toLowerCase());
          push(issues, i + 2, 'error', num ? 'account_number' : 'account_name', key,
            `Account "${key}" not found in the uploaded Chart of Accounts.`,
            'Push Chart of Accounts first or correct the account reference.');
        }
      }
    }
  }

  // Empty trailing rows
  const reqCols = entity.required.flatMap(r => Array.isArray(r) ? r : [r]);
  if (reqCols.length) {
    for (let i = 0; i < rows.length; i++) {
      const allBlank = reqCols.every(col => !String(rows[i][col] ?? '').trim());
      if (allBlank)
        push(issues, i + 2, 'warning', '(all required)', '',
          `Row ${i + 2} appears to be empty — all required fields are blank.`,
          'Delete empty rows at the bottom of your Excel file before uploading.');
    }
  }

  // Whitespace-only values in required fields
  for (let i = 0; i < rows.length; i++) {
    for (const req of entity.required) {
      const options = Array.isArray(req) ? req : [req];
      for (const col of options) {
        const raw = rows[i][col];
        if (raw !== undefined && raw !== '' && String(raw).trim() === '')
          push(issues, i + 2, 'error', col, '(spaces only)',
            `Column "${col}" contains only whitespace — treated as blank by FreshBooks.`,
            'Clear the cell or enter a real value.');
      }
    }
  }

  // Date sanity: flag dates before 2000 or more than 1 year in the future
  const DATE_COLS: Record<string, string[]> = {
    'expenses':         ['date'],
    'income':           ['date'],
    'invoices':         ['create_date'],
    'bills':            ['date'],
    'credit-notes':     ['date'],
    'invoice-payments': ['date'],
    'bill-payments':    ['paid_date', 'issue_date'],
    'journal-entries':  ['date'],
  };
  const dateCols = DATE_COLS[id] || [];
  if (dateCols.length) {
    const now      = Date.now();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const year2000  = new Date('2000-01-01').getTime();
    for (let i = 0; i < rows.length; i++) {
      for (const col of dateCols) {
        const raw = String(rows[i][col] || '').trim();
        if (!raw) continue;
        const d = new Date(raw);
        if (isNaN(d.getTime()))
          push(issues, i + 2, 'error', col, raw, `"${raw}" is not a valid date.`, 'Use YYYY-MM-DD format.');
        else if (d.getTime() < year2000)
          push(issues, i + 2, 'warning', col, raw,
            `Date "${raw}" is before year 2000 — looks like a formatting error.`,
            'Expected format: YYYY-MM-DD.');
        else if (d.getTime() > now + oneYearMs)
          push(issues, i + 2, 'warning', col, raw,
            `Date "${raw}" is more than 1 year in the future — verify this is intentional.`,
            'Check the date is correct.');
      }
    }
  }

  // Negative amounts
  const AMOUNT_COLS: Record<string, string[]> = {
    'expenses':         ['amount'],
    'income':           ['amount'],
    'invoices':         ['line_unit_cost'],
    'bills':            ['amount'],
    'credit-notes':     ['amt'],
    'invoice-payments': ['amount'],
    'bill-payments':    ['amount'],
  };
  for (let i = 0; i < rows.length; i++) {
    for (const col of (AMOUNT_COLS[id] || [])) {
      const raw = String(rows[i][col] ?? '').trim();
      if (!raw) continue;
      const val = parseFloat(raw);
      if (!isNaN(val) && val < 0)
        push(issues, i + 2, 'warning', col, raw,
          `Amount "${raw}" is negative — FreshBooks may record this as a credit or reject it.`,
          'Confirm this is intentional.');
    }
  }

  // Currency code must be a known ISO 4217 code
  const CURRENCY_ENTITIES = new Set([
    'clients','vendors','items','services','expenses','income',
    'invoices','bills','credit-notes','invoice-payments','bill-payments','journal-entries',
  ]);
  if (CURRENCY_ENTITIES.has(id)) {
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const raw = String(rows[i].currency_code || '').trim().toUpperCase();
      if (!raw || seen.has(raw)) continue;
      if (!ISO_CURRENCIES.has(raw)) {
        seen.add(raw);
        push(issues, i + 2, 'error', 'currency_code', raw,
          `"${raw}" is not a recognised ISO 4217 currency code.`,
          'Use a standard 3-letter code like USD, EUR, GBP, CAD.');
      }
    }
  }
}

// ─── Inspect an already-loaded set of rows ────────────────────────────────────
async function inspectEntity(entity: EntityFile, rows: Row[], tokenId: number | null) {
  const issues: DryRunIssue[] = [];
  const columns = rows.length ? Object.keys(rows[0]) : [];

  for (const req of entity.required) {
    if (!hasAnyColumn(columns, req))
      issues.push({ row: 1, sev: 'error', field: colLabel(req), value: '(missing column)',
        msg: `Required column "${colLabel(req)}" is missing.`,
        fix: 'Add the required column to the uploaded template.' });
  }

  for (let i = 0; i < rows.length && issues.length < 80; i++) {
    for (const req of entity.required) {
      if (!hasAnyColumn(columns, req)) continue;
      if (!rowValue(rows[i], req))
        issues.push({ row: i + 2, sev: 'error', field: colLabel(req), value: '(blank)',
          msg: `Required value "${colLabel(req)}" is blank.`,
          fix: 'Fill the value or remove the empty row before pushing.' });
    }
  }

  runBatch1(entity, rows, issues);
  await runBatch2(entity, rows, issues, tokenId);

  return { entityId: entity.id, name: entity.name, file: entity.id, total: rows.length, columns, issues };
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
// Parse the Excel file in memory, store normalized rows in DB (no disk).
// Upserts so re-uploading replaces the previous data.
// Rows expire after 3 days.
router.post('/upload/:entityId', async (req, res, next) => {
  try {
    const entity = EXCEL_FILES[req.params.entityId];
    if (!entity) return res.status(404).json({ message: 'Unknown Excel entity.' });

    const { filename, contentBase64 } = req.body || {};
    if (!filename || !contentBase64)
      return res.status(400).json({ message: 'filename and contentBase64 are required.' });

    const rows      = parseExcelBuffer(decodeBase64(contentBase64));
    const tokenId   = getCurrentTokenId(req);
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // find-then-update/create to avoid upsert issues with nullable tokenId unique key
    const existing = await prisma.uploadedSheet.findFirst({
      where: { entity: entity.id, tokenId },
    });
    if (existing) {
      await prisma.uploadedSheet.update({
        where: { id: existing.id },
        data: { filename, rowCount: rows.length, rows: rows as any, uploadedAt: now, expiresAt },
      });
    } else {
      await prisma.uploadedSheet.create({
        data: { tokenId, entity: entity.id, filename, rowCount: rows.length, rows: rows as any, expiresAt },
      });
    }

    const inspection = await inspectEntity(entity, rows, tokenId);
    res.json({ ...inspection, savedAs: filename });
  } catch (err) {
    next(err);
  }
});

// ─── DRY-RUN ──────────────────────────────────────────────────────────────────
// Loads rows from DB and re-validates. Works for single entity or batch.
router.post('/dry-run', async (req, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : Object.keys(EXCEL_FILES);
    const tokenId = await getCurrentTokenId();

    const reports = await Promise.all(
      ids
        .map(id => EXCEL_FILES[id])
        .filter(Boolean)
        .map(async entity => {
          const sheet = await prisma.uploadedSheet.findFirst({
            where: { entity: entity.id, tokenId },
            orderBy: { uploadedAt: 'desc' },
          });
          if (!sheet) {
            return {
              entityId: entity.id, name: entity.name, file: entity.id,
              total: 0, columns: [], issues: [{
                row: 0, sev: 'error' as const, field: 'file', value: '',
                msg: 'No uploaded file found for this entity.',
                fix: 'Upload the Excel or CSV template first, then run validation.',
              }],
            };
          }
          return inspectEntity(entity, sheet.rows as Row[], tokenId);
        })
    );

    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

export default router;
