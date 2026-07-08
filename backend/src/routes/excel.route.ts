import { Router } from 'express';
import { createRequire } from 'module';
import prisma from '../lib/prisma.js';
import { requireAppAuth } from '../middleware/requireAppAuth.js';
import { getClients, getInvoices, getBills, loadBusinessConfigForToken } from '../services/freshbooks.service.js';

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
  'sales-receipts': {
    id: 'sales-receipts',
    name: 'Sales Receipts',
    required: ['receipt_number', 'customer_name', 'date', 'line_name', 'line_qty', 'line_unit_cost', 'payment_type', 'currency_code'],
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
router.use(requireAppAuth);

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

  // Invoices + Sales Receipts: line_qty must be > 0
  if (id === 'invoices' || id === 'sales-receipts') {
    for (let i = 0; i < rows.length; i++) {
      const raw = String(rows[i].line_qty ?? '').trim();
      if (!raw) continue;
      const qty = parseFloat(raw);
      if (isNaN(qty) || qty <= 0) {
        push(issues, i + 2, 'error', 'line_qty', raw,
          `Line quantity "${raw}" is zero or negative — FreshBooks rejects this.`,
          'Set a positive quantity (> 0) for every line.');
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

  // Invoices: invoice_number max 30 chars + no invalid special characters
  if (id === 'invoices') {
    const invalidNumChars = /[^a-zA-Z0-9 #,./: _-]/;
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const num = String(rows[i].invoice_number || '').trim();
      if (!num || seen.has(num)) continue;
      seen.add(num);
      if (num.length > 30)
        push(issues, i + 2, 'error', 'invoice_number', num,
          `Invoice number "${num}" exceeds 30 characters (${num.length}).`,
          'Shorten the invoice number to 30 characters or less.');
      const m = num.match(invalidNumChars);
      if (m)
        push(issues, i + 2, 'error', 'invoice_number', num,
          `Invoice number "${num}" contains invalid character "${m[0]}".`,
          'Only letters, numbers, and  # , . / : _ -  are allowed.');
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

// ─── BATCH 2: within-file validations (dates, blanks, currency, etc.) ────────
async function runBatch2(entity: EntityFile, rows: Row[], issues: DryRunIssue[], _tokenId: number | null) {
  const id = entity.id;

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

  // Negative amounts (invoices excluded — FreshBooks accepts negative line amounts)
  const AMOUNT_COLS: Record<string, string[]> = {
    'expenses':         ['amount'],
    'income':           ['amount'],
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
    const tokenId = getCurrentTokenId(req);

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

// ─── ERROR SHEET DOWNLOAD ─────────────────────────────────────────────────────
// Returns an xlsx of only the rows that have validation issues, with an extra
// "Error" column describing what is wrong. Used by the "Download Error Sheet"
// button in the dry-run modal.
router.get('/errors/:entityId', async (req, res, next) => {
  try {
    const entity = EXCEL_FILES[req.params.entityId];
    if (!entity) return res.status(404).json({ message: 'Unknown entity.' });

    const tokenId = getCurrentTokenId(req);
    const sheet = await prisma.uploadedSheet.findFirst({
      where: { entity: entity.id, tokenId },
      orderBy: { uploadedAt: 'desc' },
    });
    if (!sheet) return res.status(404).json({ message: 'No uploaded file found for this entity.' });

    const rows       = sheet.rows as Row[];
    const inspection = await inspectEntity(entity, rows, tokenId);

    // Group error messages by spreadsheet row number (row 2 = first data row)
    const errorsByRow = new Map<number, string[]>();
    for (const issue of inspection.issues) {
      if (issue.row < 2) continue; // skip file-level column errors
      const msgs = errorsByRow.get(issue.row) ?? [];
      msgs.push(`[${issue.sev.toUpperCase()}] ${issue.field}: ${issue.msg}`);
      errorsByRow.set(issue.row, msgs);
    }

    if (errorsByRow.size === 0) {
      res.status(204).end();
      return;
    }

    // Build output: original row data + Error column, sorted by row number
    const errorRows = [...errorsByRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([rowNum, msgs]) => {
        const idx = rowNum - 2;
        if (idx < 0 || idx >= rows.length) return [];
        return [{ ...rows[idx], Error: msgs.join(' | ') }];
      });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(errorRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Errors');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${entity.id}-errors.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ─── FRESHBOOKS COUNTS ────────────────────────────────────────────────────────
// Returns invoice + client + bill counts from FreshBooks for the current session.
// Used by the "Check FreshBooks" button on the invoice-payments / bill-payments pages.
router.get('/fb-counts', async (req, res, next) => {
  try {
    const tokenId = getCurrentTokenId(req);
    if (tokenId != null) await loadBusinessConfigForToken(tokenId);

    const [clientsRes, invoicesRes, billsRes] = await Promise.all([
      getClients(),
      getInvoices(),
      getBills(),
    ]);

    res.json({
      clientCount:  (clientsRes.response.result.clients  as any[]).length,
      invoiceCount: (invoicesRes.response.result.invoices as any[]).length,
      billCount:    (billsRes.response.result.bills       as any[]).length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
