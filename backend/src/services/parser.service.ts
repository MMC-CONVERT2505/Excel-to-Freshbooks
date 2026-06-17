import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QBD_DIR       = path.resolve(__dirname, '../../../QBD Exports');
const TEMPLATES_DIR = path.resolve(__dirname, '../../../Excel Templates');

type Row = Record<string, string>;

function readQBD(filename: string): Row[] {
  const filePath = path.join(QBD_DIR, filename);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }) as any[];
  return rows.map(row => {
    const out: Row = {};
    for (const key of Object.keys(row)) {
      const val = row[key];
      out[key] = val instanceof Date ? val.toISOString().split('T')[0] : String(val);
    }
    return out;
  });
}

function writeTemplate(filename: string, rows: Row[]): void {
  const filePath = path.join(TEMPLATES_DIR, filename);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filePath);
}

// ─── TYPE MAP: QBD → FreshBooks ──────────────────────────────────────────────

const TYPE_MAP: Record<string, { type: string; sub_type: string }> = {
  'bank':                    { type: 'asset',     sub_type: 'Cash & Bank' },
  'accounts receivable':     { type: 'asset',     sub_type: 'Current Asset' },
  'other current asset':     { type: 'asset',     sub_type: 'Current Asset' },
  'fixed asset':             { type: 'asset',     sub_type: 'Property, Plant, and Equipment' },
  'other asset':             { type: 'asset',     sub_type: 'Current Asset' },
  'accounts payable':        { type: 'liability', sub_type: 'Current Liability' },
  'credit card':             { type: 'liability', sub_type: 'Current Liability' },
  'other current liability': { type: 'liability', sub_type: 'Current Liability' },
  'long term liability':     { type: 'liability', sub_type: 'Current Liability' },
  'equity':                  { type: 'equity',    sub_type: 'Equity' },
  'income':                  { type: 'income',    sub_type: 'Income' },
  'other income':            { type: 'income',    sub_type: 'Income' },
  'cost of goods sold':      { type: 'expense',   sub_type: 'Cost of Goods Sold' },
  'expense':                 { type: 'expense',   sub_type: 'Operating Expense' },
  'other expense':           { type: 'expense',   sub_type: 'Operating Expense' },
};

function mapType(qbdType: string): { type: string; sub_type: string } {
  return TYPE_MAP[qbdType.toLowerCase()] || { type: 'asset', sub_type: 'Other Current Asset' };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function extractNumberAndName(part: string, fallbackNumber = ''): { number: string; name: string } {
  const dashIndex = part.indexOf(' - ');
  if (dashIndex !== -1) {
    return {
      number: part.substring(0, dashIndex).trim(),
      name:   part.substring(dashIndex + 3).trim(),
    };
  }
  return { number: fallbackNumber, name: part.trim() };
}

function extractNumber(part: string): string {
  const dashIndex = part.indexOf(' - ');
  return dashIndex !== -1 ? part.substring(0, dashIndex).trim() : part.trim();
}

// ─── NAME HELPERS ────────────────────────────────────────────────────────────

function isPersonName(s: string): boolean {
  const commaIdx = s.indexOf(', ');
  if (commaIdx === -1) return false;
  const left  = s.substring(0, commaIdx).trim();
  const right = s.substring(commaIdx + 2).trim();
  return left.length > 0 && right.length > 0 && !/\d/.test(left) && !/\d/.test(right);
}

function splitPersonName(s: string): { fname: string; lname: string } {
  const commaIdx = s.indexOf(', ');
  return {
    lname: s.substring(0, commaIdx).trim(),
    fname: s.substring(commaIdx + 2).trim(),
  };
}

function firstEmail(raw: string): string {
  const candidate = raw.split(/[;,]/)[0].trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : '';
}

// ─── COA PARSER ──────────────────────────────────────────────────────────────

export function parseQBDCOA(): { output: Row[]; file: string } {
  const rows = readQBD('Charts of accounting.xlsx');

  // Pass 1: build name → number map from top-level accounts (no colon in Account field)
  const nameToNumber: Record<string, string> = {};
  for (const row of rows) {
    const accountField = row['Account'] || '';
    const acctNum      = row['Accnt. #'] || '';
    if (accountField.indexOf(':') === -1) {
      const { name, number } = extractNumberAndName(accountField, acctNum);
      // Only register numeric account numbers — skip N/P, blank, or text-only values
      if (name && number && /^\d/.test(number) && !nameToNumber[name.toLowerCase()]) {
        nameToNumber[name.toLowerCase()] = number;
      }
    }
  }

  const parents: Row[] = [];
  const children: Row[] = [];

  // Pass 2: parse all rows, resolve parent number by number then name
  for (const row of rows) {
    const accountField = row['Account'] || '';
    const qbdType      = row['Type'] || '';
    const acctNum      = row['Accnt. #'] || '';

    if (qbdType.toLowerCase() === 'non-posting') continue;

    const { type, sub_type } = mapType(qbdType);
    const colonIndex = accountField.indexOf(':');

    if (colonIndex !== -1) {
      const parentPart = accountField.substring(0, colonIndex).trim();
      const childPart  = accountField.substring(colonIndex + 1).trim();

      const { number, name } = extractNumberAndName(childPart, acctNum);

      // Try to get parent number: either it has a "1475 - Name" prefix, or look up by name
      let parent_account_number = extractNumber(parentPart);
      if (!parent_account_number.match(/^\d/)) {
        // parentPart was just a name — look it up in the name map
        parent_account_number = nameToNumber[parentPart.toLowerCase()] || parentPart;
      }

      const safeNumber = /^\d/.test(number) ? number : '';
      children.push({ name, number: safeNumber, type, sub_type, state: 'active', parent_account_number });
    } else {
      const { number, name } = extractNumberAndName(accountField, acctNum);
      const safeNumber = /^\d/.test(number) ? number : '';
      parents.push({ name, number: safeNumber, type, sub_type, state: 'active', parent_account_number: '' });
    }
  }

  // Parents first — migration requires parents to exist before sub-accounts
  const output = [...parents, ...children];

  writeTemplate('11_chart_of_accounts.csv', output);

  return { output, file: '11_chart_of_accounts.csv' };
}

// ─── CLIENT PARSER ───────────────────────────────────────────────────────────

export function parseQBDClients(): { output: Row[]; file: string } {
  const rows = readQBD('Client.xlsx');
  const output: Row[] = [];

  for (const row of rows) {
    const customerField = row['Customer'] || '';

    // First row in new file is a placeholder with Customer="0"
    if (customerField === '0') continue;

    const rawEmail      = row['Main Email'] || '';
    const firstNameCol  = row['First Name'] || '';
    const lastNameCol   = row['Last Name'] || '';
    const phone         = row['Mobile'] || '';
    const street1       = row['Street1'] || '';
    const street2       = row['Street2'] || '';
    const city          = row['City'] || '';
    const province      = row['State'] || '';
    const zip           = row['Zip'] || '';
    const country       = row['Country'] || '';
    const note          = row['Note'] || '';

    const email = firstEmail(rawEmail);

    let fname        = firstNameCol;
    let lname        = lastNameCol;
    let organization = '';

    const colonIndex = customerField.indexOf(':');

    if (colonIndex !== -1) {
      const parentPart = customerField.substring(0, colonIndex).trim();
      const childPart  = customerField.substring(colonIndex + 1).trim();

      // Skip job/address sub-customers — only keep real people (Last, First)
      if (!isPersonName(childPart) && !firstNameCol && !lastNameCol) continue;

      organization = parentPart;

      if (!fname && !lname && isPersonName(childPart)) {
        const parsed = splitPersonName(childPart);
        fname = parsed.fname;
        lname = parsed.lname;
      }
    } else {
      if (!fname && !lname && isPersonName(customerField)) {
        const parsed = splitPersonName(customerField);
        fname = parsed.fname;
        lname = parsed.lname;
      } else {
        organization = customerField;
      }
    }

    // Skip if no person name at all (e.g. bare parent like "IND. CUSTOMERS")
    if (!fname && !lname) continue;

    output.push({
      fname,
      lname,
      email,
      organization,
      bus_phone:    phone,
      mob_phone:    '',
      p_street:     street1,
      p_street2:    street2,
      p_city:       city,
      p_province:   province,
      p_code:       zip,
      p_country:    country,
      currency_code: 'USD',
      language:     'en',
      note,
    });
  }

  writeTemplate('01_clients.csv', output);
  return { output, file: '01_clients.csv' };
}

// ─── VENDOR PARSER ───────────────────────────────────────────────────────────

export function parseQBDVendors(): { output: Row[]; file: string } {
  const rows = readQBD('Vendior.xlsx');
  const output: Row[] = [];

  for (const row of rows) {
    const vendorName   = row['Vendor'] || '';
    const rawEmail     = row['Main Email'] || '';
    const firstNameCol = row['First Name'] || '';
    const lastNameCol  = row['Last Name'] || '';
    const phone        = row['Mobile'] || '';
    const street       = row['Bill from Street 1'] || '';
    const city         = row['Bill from City'] || '';
    const province     = row['Bill from State'] || '';
    const postalCode   = row['Bill from Zip'] || '';
    const country      = row['Bill from Country'] || '';
    const website      = row['Website'] || '';
    const accountNo    = row['Account No.'] || '';

    const email = firstEmail(rawEmail);
    const fname = firstNameCol || 'N/A';
    const lname = lastNameCol  || 'N/A';

    output.push({
      vendor_name:                   vendorName,
      primary_contact_first_name:    fname,
      primary_contact_last_name:     lname,
      primary_contact_email:         email,
      phone,
      street,
      city,
      province,
      postal_code:  postalCode,
      country,
      currency_code: 'USD',
      language:      'en',
      website,
      note:          accountNo ? `Account No: ${accountNo}` : '',
    });
  }

  writeTemplate('03_vendors.csv', output);
  return { output, file: '03_vendors.csv' };
}

// ─── ITEM / SERVICE PARSER ───────────────────────────────────────────────────

const ITEM_TYPES    = new Set(['group', 'sales tax group', 'sales tax item']);
const SERVICE_TYPES = new Set(['service', 'non-inventory part', 'other charge']);

function parsePrice(raw: string): number {
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned.includes('%') || cleaned === '') return 0;
  return parseFloat(cleaned) || 0;
}

function extractAccountNumber(accountField: string): string {
  // QBD uses "Parent:Child" hierarchy — take only the child (most specific) part
  const colonIndex = accountField.lastIndexOf(':');
  const base = colonIndex !== -1 ? accountField.substring(colonIndex + 1).trim() : accountField.trim();
  // If it has a number prefix like "4100 - Crane Service", extract just the number
  const dashIndex = base.indexOf(' - ');
  return dashIndex !== -1 ? base.substring(0, dashIndex).trim() : base;
}

export function parseQBDItems(): { output: Row[]; file: string } {
  const rows = readQBD('item.xlsx');
  const output: Row[] = [];

  for (const row of rows) {
    const itemField    = row['Item'] || '';
    const description  = row['Description'] || '';
    const type         = row['Type'] || '';
    const priceRaw     = row['Price'] || '';
    const accountField = row['Account'] || '';

    if (!ITEM_TYPES.has(type.toLowerCase())) continue;

    const price = parsePrice(priceRaw);
    const name  = itemField.replace(':', ' - ');
    const income_account_number = extractAccountNumber(accountField);

    output.push({
      name,
      description,
      sku:                   itemField,
      qty:                   '1',
      unit_cost:             price.toFixed(2),
      currency_code:         'USD',
      income_account_number,
    });
  }

  writeTemplate('02_items.csv', output);
  return { output, file: '02_items.csv' };
}

export function parseQBDServices(): { output: Row[]; file: string } {
  const rows = readQBD('item.xlsx');
  const output: Row[] = [];

  for (const row of rows) {
    const itemField    = row['Item'] || '';
    const description  = row['Description'] || '';
    const type         = row['Type'] || '';
    const priceRaw     = row['Price'] || '';
    const accountField = row['Account'] || '';

    if (!SERVICE_TYPES.has(type.toLowerCase())) continue;

    const price = parsePrice(priceRaw);
    const name  = itemField.replace(':', ' - ');
    const income_account_number = extractAccountNumber(accountField);

    output.push({
      name,
      description,
      rate:                  price.toFixed(2),
      income_account_number,
    });
  }

  writeTemplate('12_services.csv', output);
  return { output, file: '12_services.csv' };
}

// ─── JOURNAL HELPERS ─────────────────────────────────────────────────────────

function excelDateToISO(value: string | number | Date): string {
  if (!value && value !== 0) return '';
  // JS Date object (cellDates: true)
  if (value instanceof Date) return value.toISOString().split('T')[0];
  // Already YYYY-MM-DD or ISO string
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  // MM/DD/YYYY or DD/MM/YYYY string — detect by checking if first part > 12
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(value))) {
    const parts = String(value).split('/');
    const a = parseInt(parts[0], 10);
    const yyyy = parts[2];
    let mm: string, dd: string;
    if (a > 12) {
      // First number can't be a month — must be DD/MM/YYYY
      dd = parts[0].padStart(2, '0');
      mm = parts[1].padStart(2, '0');
    } else {
      // First number ≤ 12 — assume US MM/DD/YYYY (QBD default)
      mm = parts[0].padStart(2, '0');
      dd = parts[1].padStart(2, '0');
    }
    return `${yyyy}-${mm}-${dd}`;
  }
  // Excel serial number
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const date = new Date(Math.round((num - 25569) * 86400 * 1000));
    return date.toISOString().split('T')[0];
  }
  return String(value);
}

function parseAmount(value: any): number {
  if (!value && value !== 0) return 0;
  return parseFloat(String(value).replace(/,/g, '')) || 0;
}

function cleanItemName(raw: string): string {
  return raw
    .replace(/\s*\(.*?\)\s*$/, '')  // strip trailing "(description)"
    .replace(':', ' - ')
    .trim();
}

function extractCustomerName(qbdName: string): string {
  const colonIdx = qbdName.lastIndexOf(':');
  return colonIdx !== -1 ? qbdName.substring(colonIdx + 1).trim() : qbdName.trim();
}

function extractAccountCategory(account: string): string {
  const dashIdx = account.indexOf(' - ');
  return dashIdx !== -1 ? account.substring(dashIdx + 3).trim() : account.trim();
}

function calcDueOffset(createISO: string, dueISO: string): number {
  if (!dueISO || dueISO === createISO) return 30;
  const diff = Math.round(
    (new Date(dueISO).getTime() - new Date(createISO).getTime()) / (1000 * 60 * 60 * 24)
  );
  return diff > 0 ? diff : 30;
}

type JournalTx = { header: Record<string, any>; lines: Record<string, any>[] };

function groupJournalRows(filename: string): JournalTx[] {
  const filePath = path.join(QBD_DIR, filename);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const transactions: JournalTx[] = [];
  let current: JournalTx | null = null;

  for (const row of rows) {
    if (row['Trans #'] !== '') {
      if (current) transactions.push(current);
      current = { header: row, lines: [] };
    } else if (current) {
      current.lines.push(row);
    }
  }
  if (current) transactions.push(current);
  return transactions;
}

// ─── INVOICE PARSER ──────────────────────────────────────────────────────────

export function parseQBDInvoices(): { output: Row[]; file: string } {
  const transactions = groupJournalRows('all data (2).xlsx');
  const output: Row[] = [];

  const invoices = transactions.filter(t => t.header['Type'] === 'Invoice');

  for (const inv of invoices) {
    const h = inv.header;
    const invoiceNum  = String(h['Num'] || '');
    const createDate  = excelDateToISO(h['Date']);
    const dueDate     = excelDateToISO(h['Due Date']);
    const customerName = extractCustomerName(String(h['Name'] || ''));
    const dueOffset   = calcDueOffset(createDate, dueDate);

    // Income lines only — skip AR header row, discount/expense lines, totals row
    const lines = inv.lines.filter(l =>
      l['Account Type'] === 'Income' && parseAmount(l['Credit']) > 0
    );

    if (lines.length === 0) continue;

    for (const line of lines) {
      const credit  = parseAmount(line['Credit']);
      const qty     = Math.abs(parseFloat(String(line['Qty'])) || 0) || 1;
      const unitCost = (credit / qty).toFixed(2);
      const name    = cleanItemName(String(line['Item'] || '')) || 'Service';
      const desc    = String(line['Memo'] || line['Item Description'] || '').trim();

      output.push({
        invoice_number:  invoiceNum,
        customer_name:   customerName,
        create_date:     createDate,
        due_offset_days: String(dueOffset),
        currency_code:   'USD',
        notes:           '',
        terms:           '',
        language:        'en',
        line_name:        name,
        line_description: desc,
        line_qty:         String(qty),
        line_unit_cost:   unitCost,
        tax_name1:        '',
        tax_amount1:      '',
        tax_name2:        '',
        tax_amount2:      '',
      });
    }
  }

  writeTemplate('05_invoices.csv', output);
  return { output, file: '05_invoices.csv' };
}

// ─── EXPENSE PARSER ──────────────────────────────────────────────────────────

const EXPENSE_ACCOUNT_TYPES = new Set(['Expense', 'Cost of Goods Sold', 'Other Expense']);

// These types have their own dedicated parsers — exclude from expenses
const NON_EXPENSE_TYPES = new Set(['Invoice', 'Bill', 'Bill Pmt -Check', 'Bill Pmt -CCard', 'Payment', 'Sales Receipt', 'Credit Memo']);

export function parseQBDExpenses(): { output: Row[]; file: string } {
  const transactions = groupJournalRows('all data (2).xlsx');
  const output: Row[] = [];

  const expenseTxns = transactions.filter(t => !NON_EXPENSE_TYPES.has(t.header['Type']));

  for (const txn of expenseTxns) {
    const h          = txn.header;
    const date       = excelDateToISO(h['Date']);
    const vendor     = String(h['Name'] || '').trim();
    const headerMemo = String(h['Memo'] || '').trim();

    const allLines = [h, ...txn.lines];
    const expenseLines = allLines.filter(l => EXPENSE_ACCOUNT_TYPES.has(l['Account Type']));

    for (const line of expenseLines) {
      const debit  = parseAmount(line['Debit']);
      const credit = parseAmount(line['Credit']);
      const amount = debit > 0 ? debit : credit;
      const categoryName = extractAccountCategory(String(line['Account'] || ''));
      const notes        = String(line['Memo'] || '').trim() || headerMemo;

      output.push({
        date,
        vendor,
        amount:        amount.toFixed(2),
        category_name: categoryName,
        notes,
        currency_code: 'USD',
        tax_name1:     '',
        tax_amount1:   '',
        tax_name2:     '',
        tax_amount2:   '',
      });
    }
  }

  writeTemplate('04_expenses.csv', output);
  return { output, file: '04_expenses.csv' };
}

// ─── INCOME PARSER ───────────────────────────────────────────────────────────

const INCOME_ACCOUNT_TYPES = new Set(['Income', 'Other Income']);

export function parseQBDIncome(): { output: Row[]; file: string } {
  const transactions = groupJournalRows('all data (2).xlsx');
  const output: Row[] = [];

  const deposits = transactions.filter(t => t.header['Type'] === 'Deposit');

  for (const dep of deposits) {
    const h    = dep.header;
    const date = excelDateToISO(h['Date']);
    const headerMemo = String(h['Memo'] || '').trim();

    const incomeLines = dep.lines.filter(l =>
      INCOME_ACCOUNT_TYPES.has(l['Account Type']) && parseAmount(l['Credit']) > 0
    );

    for (const line of incomeLines) {
      const amount       = parseAmount(line['Credit']);
      const source       = String(line['Name'] || h['Name'] || '').trim();
      const categoryName = extractAccountCategory(String(line['Account'] || ''));
      const note         = String(line['Memo'] || '').trim() || headerMemo;

      output.push({
        date,
        amount:        amount.toFixed(2),
        source,
        category_name: categoryName,
        note,
        currency_code: 'USD',
        payment_type:  String(h['Type'] || 'Deposit'),
      });
    }
  }

  writeTemplate('06_income.csv', output);
  return { output, file: '06_income.csv' };
}

// ─── CREDIT NOTES PARSER ─────────────────────────────────────────────────────

// QBD credit-to-customer transaction types
const CREDIT_NOTE_TYPES = new Set(['Credit Memo']);

export function parseQBDCreditNotes(): { output: Row[]; file: string } {
  const transactions = groupJournalRows('all data (2).xlsx');
  const output: Row[] = [];

  const credits = transactions.filter(t => CREDIT_NOTE_TYPES.has(t.header['Type']));

  for (const cn of credits) {
    const h            = cn.header;
    const creditNumber = String(h['Trans #'] || '');
    const date         = excelDateToISO(h['Date']);
    const memo         = String(h['Memo'] || '').trim();
    const headerName   = extractCustomerName(String(h['Name'] || ''));

    // Find the AR debit line — that's the customer receiving the credit
    const arLine = [h, ...cn.lines].find(l =>
      l['Account Type'] === 'Accounts Receivable' && parseAmount(l['Debit']) > 0
    );

    const amount       = arLine ? parseAmount(arLine['Debit']) : 0;
    const customerName = extractCustomerName(String(arLine?.['Name'] || headerName));

    if (amount <= 0 || !customerName) continue;

    output.push({
      credit_note_number: creditNumber,
      customer_name:      customerName,
      date,
      currency_code:      'USD',
      credit_type:        'goodwill',
      notes:              memo,
      terms:              '',
      line_name:          memo || 'Credit',
      qun:                '1',
      amt:                amount.toFixed(2),
      tax:                '',
      taxq:               '',
      tax2:               '',
      taxq2:              '',
    });
  }

  writeTemplate('07_credit_notes.csv', output);
  return { output, file: '07_credit_notes.csv' };
}

// ─── JOURNAL ENTRIES PARSER ──────────────────────────────────────────────────

function parseJournalLine(
  accountRaw: string,
  debitRaw: any,
  creditRaw: any
): { acctNum: string; acctName: string; amount: number; type: string } | null {
  const debit  = parseAmount(debitRaw);
  const credit = parseAmount(creditRaw);

  // Skip totals rows — QBD adds a row with both debit AND credit filled as running totals
  if (debit > 0 && credit > 0) return null;
  if (debit <= 0 && credit <= 0) return null;

  const raw = String(accountRaw || '').trim();
  if (!raw) return null;

  // Strip Parent:Child hierarchy — keep most specific part
  const colonIdx = raw.lastIndexOf(':');
  const base     = colonIdx !== -1 ? raw.substring(colonIdx + 1).trim() : raw;

  // Extract number and name from "1000 - Cash" format
  // Skip non-numeric "account numbers" like "N/P" — treat as name-only
  const dashIdx = base.indexOf(' - ');
  let acctNum = '';
  let acctName = base;
  if (dashIdx !== -1) {
    const numPart = base.substring(0, dashIdx).trim();
    if (/^\d+/.test(numPart)) {
      acctNum  = numPart;
      acctName = base.substring(dashIdx + 3).trim();
    }
    // Non-numeric prefix (e.g. "N/P") — treat whole base as the account name after the dash
    else {
      acctName = base.substring(dashIdx + 3).trim() || base;
    }
  }

  const amount = debit > 0 ? debit : credit;
  const type   = debit > 0 ? 'TYPE_DEBIT' : 'TYPE_CREDIT';
  return { acctNum, acctName, amount, type };
}

export function parseQBDJournalEntries(): { output: Row[]; file: string } {
  const transactions = groupJournalRows('all data (2).xlsx');
  const output: Row[] = [];

  const journals = transactions.filter(t => t.header['Type'] === 'General Journal');

  for (const je of journals) {
    const h           = je.header;
    const entryNumber = String(h['Trans #'] || '');
    const date        = excelDateToISO(h['Date']);
    const name        = String(h['Num'] || h['Trans #'] || '').trim();
    const description = String(h['Memo'] || '').trim();

    // The header row IS the first journal line in QBD — include it along with subsequent lines
    const allLines = [h, ...je.lines];

    for (const line of allLines) {
      const memo = String(line['Memo'] || '').trim();
      const parsed = parseJournalLine(line['Account'], line['Debit'], line['Credit']);
      if (!parsed) continue;

      output.push({
        entry_number:   entryNumber,
        date,
        name,
        description:    description || memo,
        account_number: parsed.acctNum,
        account_name:   parsed.acctName,
        debit:          parsed.type === 'TYPE_DEBIT'  ? parsed.amount.toFixed(2) : '',
        credit:         parsed.type === 'TYPE_CREDIT' ? parsed.amount.toFixed(2) : '',
        currency_code:  'USD',
      });
    }
  }

  writeTemplate('14_journal_entries.csv', output);
  return { output, file: '14_journal_entries.csv' };
}

// ─── BILLS PARSER ────────────────────────────────────────────────────────────

export function parseQBDBills(): { output: Row[]; file: string } {
  const transactions = groupJournalRows('all data (2).xlsx');
  const output: Row[] = [];

  const bills = transactions.filter(t => t.header['Type'] === 'Bill');

  for (const bill of bills) {
    const h          = bill.header;
    const billNumber = String(h['Trans #'] || '');
    const date       = excelDateToISO(h['Date']);
    const dueDate    = excelDateToISO(h['Due Date']);
    const vendorName = String(h['Name'] || '').trim();
    const dueOffset  = calcDueOffset(date, dueDate);

    const expenseLines = bill.lines.filter(l =>
      EXPENSE_ACCOUNT_TYPES.has(l['Account Type']) && parseAmount(l['Debit']) > 0
    );

    if (expenseLines.length === 0) continue;

    for (const line of expenseLines) {
      const amount       = parseAmount(line['Debit']);
      const categoryName = extractAccountCategory(String(line['Account'] || ''));
      const desc         = String(line['Memo'] || '').trim();

      output.push({
        bill_number:     billNumber,
        vendor_name:     vendorName,
        date,
        due_offset_days: String(dueOffset),
        currency_code:   'USD',
        category_name:   categoryName,
        amount:          amount.toFixed(2),
        quantity:        '1',
        desc,
        tax_name1:       '',
        tax_amount1:     '',
        tax_name2:       '',
        tax_amount2:     '',
      });
    }
  }

  writeTemplate('08_bills.csv', output);
  return { output, file: '08_bills.csv' };
}

// ─── INVOICE PAYMENTS PARSER ────────────────────────────────────────────────
// Source: QBD Exports/Invoice Payment.xlsx  (Sheet1)
// Output: Excel Templates/10_invoice_payments.csv
// Fields per Ronak task #671: amount, currency_code, date, type, note, invoice_number
// Also includes customer_name so migration can resolve the FreshBooks invoice ID

const INVOICE_PAYMENT_TYPE_MAP: Record<string, string> = {
  'e-check':        'Check',
  'check':          'Check',
  'cash':           'Cash',
  'credit card':    'Credit',
  'visa':           'Credit',
  'mastercard':     'Credit',
  'amex':           'Credit',
  'ach':            'ACH',
  'wire':           'Wire',
  'paypal':         'Online',
  'online':         'Online',
};

function mapInvoicePaymentType(raw: string): string {
  return INVOICE_PAYMENT_TYPE_MAP[raw.toLowerCase().trim()] || 'Check';
}

export function parseQBDInvoicePayments(): { output: Row[]; file: string } {
  const filePath = path.join(QBD_DIR, 'Invoice Payment.xlsx');
  const wb = XLSX.readFile(filePath, { cellDates: true });
  // Always Sheet1 only — raw data
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const output: Row[] = [];

  for (const row of rawRows) {
    // AppliedToTxnType must be Invoice — skip credit applications
    if (String(row['AppliedToTxnTxnType'] || '') !== 'Invoice') continue;

    const amount = parseFloat(String(row['AppliedToTxnAmount'] || '0')) || 0;
    if (amount <= 0) continue;

    const rawDate = row['TxnDate'];
    const date = excelDateToISO(rawDate instanceof Date ? rawDate : String(rawDate));

    output.push({
      invoice_number: String(row['AppliedToTxnRefNumber'] || '').trim(),
      customer_name:  String(row['CustomerRefFullName']   || '').trim(),
      amount:         amount.toFixed(2),
      currency_code:  String(row['CurrencyRefFullName']   || 'USD').trim() || 'USD',
      date,
      payment_type:   mapInvoicePaymentType(String(row['PaymentMethodRefFullName'] || '')),
      note:           String(row['Memo'] || '').trim(),
    });
  }

  writeTemplate('10_invoice_payments.csv', output);
  return { output, file: '10_invoice_payments.csv' };
}

// ─── BILL PAYMENTS PARSER ─────────────────────────────────────────────────────
// Source: QBD Exports/Bills Payment.xlsx  (Sheet1)
// Output: Excel Templates/09_bill_payments.csv
// Fields per Ronak task #672: amount, currency_code, date, type, note, bill_number
// Also includes vendor_name so migration can resolve the FreshBooks bill ID

export function parseQBDBillPayments(): { output: Row[]; file: string } {
  const filePath = path.join(QBD_DIR, 'Bills Payment.xlsx');
  const wb = XLSX.readFile(filePath, { cellDates: true });
  // Always Sheet1 only — raw data
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const output: Row[] = [];

  for (const row of rawRows) {
    // AppliedToTxnType must be Bill — skip credit applications
    if (String(row['AppliedToTxnTxnType'] || '') !== 'Bill') continue;

    const amount = parseFloat(String(row['AppliedToTxnAmount'] || '0')) || 0;
    if (amount <= 0) continue;

    const rawDate = row['TxnDate'];
    const date = excelDateToISO(rawDate instanceof Date ? rawDate : String(rawDate));

    output.push({
      bill_number:   String(row['AppliedToTxnRefNumber']    || '').trim(),
      vendor_name:   String(row['PayeeEntityRefFullName']   || '').trim(),
      amount:        amount.toFixed(2),
      currency_code: String(row['CurrencyRefFullName']      || 'USD').trim() || 'USD',
      paid_date:     date,
      payment_type:  'Check',
      note:          String(row['Memo'] || '').trim(),
    });
  }

  writeTemplate('09_bill_payments.csv', output);
  return { output, file: '09_bill_payments.csv' };
}

export function parseQBDAll() {
  const results = [
    { name: 'Chart of Accounts',   ...parseQBDCOA() },
    { name: 'Clients',             ...parseQBDClients() },
    { name: 'Vendors',             ...parseQBDVendors() },
    { name: 'Items',               ...parseQBDItems() },
    { name: 'Services',            ...parseQBDServices() },
    { name: 'Invoices',            ...parseQBDInvoices() },
    { name: 'Expenses',            ...parseQBDExpenses() },
    { name: 'Income',              ...parseQBDIncome() },
    { name: 'Bills',               ...parseQBDBills() },
    { name: 'Credit Notes',        ...parseQBDCreditNotes() },
    { name: 'Journal Entries',     ...parseQBDJournalEntries() },
    { name: 'Invoice Payments',    ...parseQBDInvoicePayments() },
    { name: 'Bill Payments',       ...parseQBDBillPayments() },
  ];
  return results.map(r => ({ name: r.name, file: r.file, total: r.output.length }));
}

