import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE  = path.resolve(__dirname, '../QBD Sheets/qbd raw.xlsx');
const OUTPUT_FILE = path.resolve(__dirname, '../QBD Parsed/parsed_output_v2.xlsx');

// ─── Column indices (headers alternate with empty cols) ───────────────────────
const C = {
  TRANS_NUM:    1,
  TYPE:         3,
  DATE:         5,
  NUM:          7,   // check number / journal number
  NAME:         9,
  SOURCE_NAME:  11,
  MEMO:         13,
  ACCOUNT:      21,
  DEBIT:        29,
  CREDIT:       31,
  AMOUNT:       33,
  ACCOUNT_TYPE: 35,
};

type Row = any[];

function formatDate(val: any): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().split('T')[0];
  if (typeof val === 'string' && val.includes('T')) return val.split('T')[0];
  return String(val);
}

function isMainRow(row: Row): boolean {
  return row[C.TRANS_NUM] !== '' && row[C.TRANS_NUM] !== null && row[C.TRANS_NUM] !== undefined;
}

function isTotalsRow(row: Row): boolean {
  return String(row[0]).trim() === '' && String(row[C.DEBIT]).trim() !== '' && row[C.TRANS_NUM] === '';
}

// ─── Parse raw rows into transaction groups ───────────────────────────────────
function groupTransactions(rows: Row[]): { main: Row; splits: Row[] }[] {
  const groups: { main: Row; splits: Row[] }[] = [];
  let current: { main: Row; splits: Row[] } | null = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    // Skip totals rows (first col is space " ")
    if (String(row[0]) === ' ') continue;

    if (isMainRow(row)) {
      if (current) groups.push(current);
      current = { main: row, splits: [] };
    } else if (current && row[C.ACCOUNT] !== '') {
      current.splits.push(row);
    }
  }
  if (current) groups.push(current);
  return groups;
}

// ─── Parse each group into typed records ─────────────────────────────────────

function parseExpenses(groups: { main: Row; splits: Row[] }[]) {
  const results: Record<string, any>[] = [];

  for (const { main, splits } of groups) {
    const type = main[C.TYPE];
    if (type !== 'Check' && type !== 'Credit Card Charge') continue;

    const date     = formatDate(main[C.DATE]);
    const vendor   = main[C.NAME] || main[C.SOURCE_NAME] || '';
    const amount   = main[C.CREDIT] || Math.abs(main[C.AMOUNT]) || 0;
    const checkNum = main[C.NUM] || '';
    const memo     = main[C.MEMO] || '';
    const transNum = main[C.TRANS_NUM];

    const expenseSplits = splits.filter(s =>
      s[C.ACCOUNT_TYPE] === 'Cost of Goods Sold' ||
      s[C.ACCOUNT_TYPE] === 'Expense' ||
      s[C.ACCOUNT_TYPE] === 'Other Current Asset'
    );

    const lines = expenseSplits.length > 0 ? expenseSplits : [splits[0]].filter(Boolean);

    for (const split of lines) {
      results.push({
        amount:       split?.[C.DEBIT] || amount,
        categoriesid: '',                              // FreshBooks ID — to be mapped
        Vender:       vendor,
        TaxName1:     '',
        TaxName2:     '',
        TaxPercent1:  0,
        TaxPercent2:  0,
        description:  memo || checkNum,
        date,
        taxamount1:   0,
        taxamount2:   0,
        Code:         'USD',
        COGS:         split?.[C.ACCOUNT_TYPE] === 'Cost of Goods Sold' ? split?.[C.ACCOUNT] : '',
        Type:         type,
        'Trans #':    transNum,
        Date:         date,
        Name:         vendor,
        Num:          checkNum,
        Memo:         memo,
        Account:      split?.[C.ACCOUNT] || '',
        Debit:        split?.[C.DEBIT] || '',
        Credit:       '',
        'Dr-Cr':      split?.[C.DEBIT] || '',
        'Account Type': split?.[C.ACCOUNT_TYPE] || '',
      });
    }
  }
  return results;
}

function parseIncome(groups: { main: Row; splits: Row[] }[]) {
  const results: Record<string, any>[] = [];

  for (const { main, splits } of groups) {
    if (main[C.TYPE] !== 'Deposit') continue;

    const date     = formatDate(main[C.DATE]);
    const amount   = main[C.DEBIT] || main[C.AMOUNT] || 0;
    const memo     = main[C.MEMO] || 'Deposit';
    const transNum = main[C.TRANS_NUM];

    const incomeSplits = splits.filter(s =>
      s[C.ACCOUNT_TYPE] === 'Income' || s[C.ACCOUNT_TYPE] === 'Other Current Asset'
    );

    const lines = incomeSplits.length > 0 ? incomeSplits : [splits[0]].filter(Boolean);

    for (const split of lines) {
      results.push({
        amount:       split?.[C.CREDIT] || amount,
        Code:         'USD',
        'Company Name': split?.[C.NAME] || 'Other',
        date,
        Note:         memo,
        Type:         main[C.TYPE],
        Sourse:       'Unknown',
        TaxAmount1:   0,
        'Tax Name1':  '',
        TaxAmount2:   0,
        'Tax Name2':  '',
        'User Id':    '',
        'Trans #':    transNum,
        Date:         date,
        Name:         split?.[C.NAME] || '',
        Num:          main[C.NUM] || '',
        Memo:         memo,
        Account:      split?.[C.ACCOUNT] || '',
        Debit:        '',
        Credit:       split?.[C.CREDIT] || amount,
        'Dr-Cr':      split?.[C.CREDIT] || amount,
        'Account Type': split?.[C.ACCOUNT_TYPE] || '',
      });
    }
  }
  return results;
}

function parseJournalEntries(groups: { main: Row; splits: Row[] }[]) {
  const results: Record<string, any>[] = [];

  for (const { main, splits } of groups) {
    const type = main[C.TYPE];
    if (type !== 'Transfer' && type !== 'General Journal') continue;

    const date        = formatDate(main[C.DATE]);
    const transNum    = main[C.TRANS_NUM];
    const jNo         = `F-${transNum}`;
    const description = main[C.MEMO] || type;

    const allLines = [main, ...splits].filter(r => r[C.ACCOUNT] !== '');

    for (const line of allLines) {
      const debit  = line[C.DEBIT]  || 0;
      const credit = line[C.CREDIT] || 0;
      if (debit === 0 && credit === 0) continue;

      const amount = debit > 0 ? debit : -credit;

      results.push({
        JNo:            jNo,
        Date:           date,
        Description:    description,
        'Account Id':   '',            // FreshBooks UUID — to be mapped
        Amount:         amount,
        Name:           line[C.NAME] || main[C.NAME] || '',
        currency_code:  'USD',
        Type:           type,
        'Trans #':      transNum,
        'Date ':        date,
        'Name ':        line[C.NAME] || '',
        Num:            main[C.NUM] || '',
        Memo:           main[C.MEMO] || '',
        Account:        line[C.ACCOUNT],
        Debit:          debit  || '',
        Credit:         credit || '',
        'Dr-Cr':        amount,
        'Account Type': line[C.ACCOUNT_TYPE],
      });
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log('Reading QBD raw file...');
  const wb    = XLSX.readFile(INPUT_FILE, { cellDates: true });
  const ws    = wb.Sheets['Sheet1'];
  const rows: Row[] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  console.log(`Total rows: ${rows.length}`);

  const groups = groupTransactions(rows);
  console.log(`Grouped into ${groups.length} transactions`);

  const expenses = parseExpenses(groups);
  const income   = parseIncome(groups);
  const journals = parseJournalEntries(groups);

  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const g of groups) {
    const t = g.main[C.TYPE];
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  console.log('\nTransaction counts:', typeCounts);
  console.log(`Expenses parsed:        ${expenses.length} rows`);
  console.log(`Income parsed:          ${income.length} rows`);
  console.log(`Journal entries parsed: ${journals.length} rows`);

  // ─── Write output Excel ───────────────────────────────────────────────────
  const outWb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(expenses), 'Expenses');
  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(income),   'Income');
  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(journals), 'Journal Entries');
  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(
    Object.entries(typeCounts).map(([type, count]) => ({ type, count }))
  ), 'Summary');

  XLSX.writeFile(outWb, OUTPUT_FILE);
  console.log(`\nOutput written to: ${OUTPUT_FILE}`);
}

main();
