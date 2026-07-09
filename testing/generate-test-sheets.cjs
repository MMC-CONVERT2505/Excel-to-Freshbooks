/**
 * Run from the testing/ folder:
 *   node generate-test-sheets.cjs
 *
 * Generates one .xlsx file per entity, each with:
 *   - Row 1: column headers (bold)
 *   - Rows 2+: realistic sample data
 */

const XLSX = require('../backend/node_modules/xlsx');
const path = require('path');
const fs   = require('fs');

const OUT = __dirname;

/** Build a workbook from { headers, rows } and save it */
function save(filename, headers, rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Widen columns so headers are readable
  ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 4, 18) }));

  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, path.join(OUT, filename));
  console.log('✔', filename);
}

// ── chart-of-accounts ─────────────────────────────────────────────────────────
save('coa.xlsx',
  ['name','type','sub_type','number','parent_account_number','state'],
  [
    ['Operating Checking',    'asset',     'Cash & Bank',                       '1010', '', 'active'],
    ['Savings Account',       'asset',     'Cash & Bank',                       '1020', '', 'active'],
    ['Petty Cash',            'asset',     'Cash & Bank',                       '1030', '', 'active'],
    ['Accounts Receivable',   'asset',     'Current Asset',                     '1200', '', 'active'],
    ['Office Equipment',      'asset',     'Property, Plant, and Equipment',    '1500', '', 'active'],
    ['Accounts Payable',      'liability', 'Current Liability',                 '2000', '', 'active'],
    ['Sales Tax Payable',     'liability', 'Current Liability',                 '2100', '', 'active'],
    ['Owner\'s Equity',       'equity',    'Equity',                            '3000', '', 'active'],
    ['Product Revenue',       'income',    'Income',                            '4000', '', 'active'],
    ['Service Revenue',       'income',    'Income',                            '4100', '', 'active'],
    ['Office Supplies',       'expense',   'Operating Expense',                 '5000', '', 'active'],
    ['Travel & Meals',        'expense',   'Operating Expense',                 '5100', '', 'active'],
    ['Utilities',             'expense',   'Operating Expense',                 '5200', '', 'active'],
    ['Rent Expense',          'expense',   'Operating Expense',                 '5300', '', 'active'],
  ]
);

// ── clients ───────────────────────────────────────────────────────────────────
save('clients.xlsx',
  ['fname','lname','organization','email','currency_code','bus_phone','mob_phone','p_street','p_city','p_province','p_code','p_country','note'],
  [
    ['Jane',   'Smith',   'Acme Inc',           'jane@acme.com',       'USD', '212-555-0101', '212-555-0199', '12 Main St',      'New York',    'NY', '10001', 'US', 'Key account'],
    ['Robert', 'Johnson', 'Global Tech LLC',    'rob@globaltech.com',  'USD', '415-555-0202', '',             '456 Market Ave',  'San Francisco','CA', '94105', 'US', ''],
    ['Maria',  'Garcia',  'Sunrise Retail',     'maria@sunrise.com',   'USD', '305-555-0303', '305-555-0399', '789 Biscayne Blvd','Miami',      'FL', '33101', 'US', 'Net 30'],
    ['',       '',        'BlueSky Consulting', 'info@bluesky.com',    'USD', '312-555-0404', '',             '100 Wacker Dr',   'Chicago',     'IL', '60601', 'US', ''],
    ['David',  'Lee',     'Lee Enterprises',    'david@leeent.com',    'CAD', '416-555-0505', '416-555-0599', '321 King St W',   'Toronto',     'ON', 'M5V1J2','CA', 'Canadian client'],
  ]
);

// ── vendors ───────────────────────────────────────────────────────────────────
save('vendors.xlsx',
  ['vendor_name','primary_contact_first_name','primary_contact_last_name','primary_contact_email','phone','street','city','province','postal_code','country','currency_code','note'],
  [
    ['Office Depot',       'John',  'Doe',     'billing@officedepot.com', '800-555-0101', '100 Office Blvd', 'Boston',      'MA', '02101', 'US', 'USD', 'Preferred supplier'],
    ['Amazon Business',    'Sarah', 'Kim',     'accounts@amazon.com',     '206-555-0202', '410 Terry Ave N', 'Seattle',     'WA', '98109', 'US', 'USD', ''],
    ['FedEx',              '',      '',        'billing@fedex.com',       '800-555-0303', '942 S Shady Grove', 'Memphis',   'TN', '38120', 'US', 'USD', 'Shipping vendor'],
    ['Adobe Systems',      'Chris', 'Martin',  'ar@adobe.com',            '408-555-0404', '345 Park Ave',    'San Jose',    'CA', '95110', 'US', 'USD', 'Software licenses'],
    ['City Electric Co',   '',      '',        'info@cityelectric.com',   '718-555-0505', '55 Water St',     'New York',    'NY', '10041', 'US', 'USD', 'Utilities vendor'],
  ]
);

// ── items ─────────────────────────────────────────────────────────────────────
save('items.xlsx',
  ['name','unit_cost','income_account_number','currency_code','description','sku','qty'],
  [
    ['Widget A',          '19.99',  '4000', 'USD', 'Standard widget unit',    'WID-A-01',  '1'],
    ['Widget B (Pro)',     '49.99',  '4000', 'USD', 'Professional widget',     'WID-B-02',  '1'],
    ['USB Cable 3ft',     '8.99',   '4000', 'USD', 'USB-C to USB-A 3ft',      'USB-3-01',  '1'],
    ['Power Adapter',     '24.95',  '4000', 'USD', 'Universal power adapter', 'PWR-AD-01', '1'],
    ['Software License',  '199.00', '4100', 'USD', 'Annual software license', 'SW-LIC-01', '1'],
  ]
);

// ── services ──────────────────────────────────────────────────────────────────
save('services.xlsx',
  ['name','rate','income_account_number','billable'],
  [
    ['Consulting',          '150.00', '4100', 'true'],
    ['Project Management',  '125.00', '4100', 'true'],
    ['Technical Support',   '95.00',  '4100', 'true'],
    ['Training',            '200.00', '4100', 'true'],
    ['Design Services',     '110.00', '4100', 'true'],
  ]
);

// ── expenses ──────────────────────────────────────────────────────────────────
save('expenses.xlsx',
  ['date','amount','category_name','vendor','currency_code','notes','tax_name1','tax_amount1','tax_name2','tax_amount2'],
  [
    ['2026-05-01', '45.00',  'Travel',           'Delta Airlines',   'USD', 'Client meeting – NYC',      '',    '',      '',    ''],
    ['2026-05-05', '120.00', 'Office Supplies',  'Office Depot',     'USD', 'Printer paper and pens',   '',    '',      '',    ''],
    ['2026-05-10', '350.00', 'Software',         'Adobe Systems',    'USD', 'Creative Cloud renewal',   '',    '',      '',    ''],
    ['2026-05-15', '28.50',  'Meals',            'Local Restaurant', 'USD', 'Team lunch',               'GST', '1.43', 'PST', '1.14'],
    ['2026-05-20', '89.99',  'Utilities',        'City Electric Co', 'USD', 'May electricity bill',     '',    '',      '',    ''],
    ['2026-05-25', '55.00',  'Travel',           'Uber',             'USD', 'Airport transfer',         '',    '',      '',    ''],
  ]
);

// ── income ────────────────────────────────────────────────────────────────────
save('income.xlsx',
  ['date','amount','category_name','currency_code','source','payment_type','note'],
  [
    ['2026-05-02', '500.00',  'Sales Revenue',  'USD', 'Product sales',     'Check',  'Q2 product order'],
    ['2026-05-08', '1200.00', 'Service Income', 'USD', 'Consulting hours',  'Check',  'Project Alpha week 2'],
    ['2026-05-12', '3500.00', 'Sales Revenue',  'USD', 'Bulk widget order', 'ACH',    '50 units Widget A'],
    ['2026-05-18', '800.00',  'Service Income', 'USD', 'Training session',  'Check',  '4-hour on-site training'],
    ['2026-05-28', '250.00',  'Other Income',   'USD', 'Reimbursement',     'Cash',   'Travel reimbursement'],
  ]
);

// ── invoices ──────────────────────────────────────────────────────────────────
save('invoices.xlsx',
  ['invoice_number','customer_name','create_date','line_name','line_qty','line_unit_cost','customer_email','due_offset_days','currency_code','line_description','notes','terms','tax_name1','tax_amount1','tax_name2','tax_amount2'],
  [
    // INV-1042 — 2 line items
    ['INV-1042', 'Acme Inc',           '2026-05-15', 'Widget A',       '2', '19.99', 'ar@acme.com',    '30', 'USD', 'Standard widget unit',    'Thank you for your business', 'Net 30', '',    '',     '',    ''],
    ['INV-1042', 'Acme Inc',           '2026-05-15', 'USB Cable 3ft',  '3', '8.99',  'ar@acme.com',    '30', 'USD', 'USB-C to USB-A 3ft',      '',                            '',       '',    '',     '',    ''],
    // INV-1043 — 1 line item
    ['INV-1043', 'Global Tech LLC',    '2026-05-18', 'Consulting',     '8', '150.00','rob@globaltech.com','30','USD', 'Project consulting hours', 'Invoice for May sprint',    'Net 30', 'GST', '96.00','',    ''],
    // INV-1044 — 1 line item
    ['INV-1044', 'Sunrise Retail',     '2026-05-20', 'Widget B (Pro)', '5', '49.99', 'maria@sunrise.com','30','USD', 'Professional widget',      '',                          'Net 30', '',    '',     '',    ''],
    // INV-1045 — 2 line items
    ['INV-1045', 'BlueSky Consulting', '2026-05-22', 'Training',       '4', '200.00','info@bluesky.com','30','USD', '4-hour training session',  'On-site delivery',          'Net 30', '',    '',     '',    ''],
    ['INV-1045', 'BlueSky Consulting', '2026-05-22', 'Software License','1','199.00','info@bluesky.com','30','USD', 'Annual license',           '',                          '',       '',    '',     '',    ''],
  ]
);

// ── bills ─────────────────────────────────────────────────────────────────────
save('bills.xlsx',
  ['bill_number','vendor_name','date','category_name','amount','quantity','currency_code','due_offset_days','desc','tax_name1','tax_amount1','tax_name2','tax_amount2'],
  [
    // B-5001 — 2 lines
    ['B-5001', 'Office Depot',    '2026-05-10', 'Office Supplies', '45.00',  '10', 'USD', '30', 'Printer paper x 10 reams', '',    '',      '',    ''],
    ['B-5001', 'Office Depot',    '2026-05-10', 'Office Supplies', '24.99',  '2',  'USD', '30', 'Ballpoint pens (box)',      '',    '',      '',    ''],
    // B-5002
    ['B-5002', 'Amazon Business', '2026-05-12', 'Technology',      '199.00', '1',  'USD', '30', 'HDMI cables and adapters', '',    '',      '',    ''],
    // B-5003
    ['B-5003', 'FedEx',           '2026-05-15', 'Shipping',        '38.50',  '1',  'USD', '30', 'Express shipment – NYC',   'GST', '1.93', 'PST', '1.54'],
    // B-5004
    ['B-5004', 'Adobe Systems',   '2026-05-20', 'Software',        '599.00', '1',  'USD', '30', 'Creative Cloud for Teams', '',    '',      '',    ''],
  ]
);

// ── credit-notes ──────────────────────────────────────────────────────────────
save('credit_notes.xlsx',
  ['credit_note_number','customer_name','date','amt','line_name','customer_email','currency_code','credit_type','qun','des','notes','tax','taxq','tax2','taxq2'],
  [
    ['CN-001', 'Acme Inc',           '2026-05-22', '19.99', 'Refund – Widget A',    'ar@acme.com',       'USD', 'goodwill',   '1', 'Returned damaged unit',   'Refund approved by manager', '',    '',     '',    ''],
    ['CN-002', 'Sunrise Retail',     '2026-05-25', '49.99', 'Refund – Widget B',    'maria@sunrise.com', 'USD', 'overpayment','1', 'Customer overpayment',    'Credit applied to account',  '',    '',     '',    ''],
    ['CN-003', 'BlueSky Consulting', '2026-05-28', '200.00','Training credit',       'info@bluesky.com',  'USD', 'credit',     '1', 'Rescheduled session',     'Session moved to June',      'GST', '10.00','',    ''],
  ]
);

// ── journal-entries ───────────────────────────────────────────────────────────
save('journal_entries.xlsx',
  ['entry_number','date','account_number','account_name','debit','credit','name','currency_code','description'],
  [
    // JE-001 — monthly accrual (balanced: 1000 debit / 1000 credit)
    ['JE-001', '2026-05-31', '5000', 'Office Supplies',   '1000.00', '0.00',    'May Accrual',        'USD', 'Accrued office supplies'],
    ['JE-001', '2026-05-31', '2000', 'Accounts Payable',  '0.00',    '1000.00', 'May Accrual',        'USD', 'Accrued office supplies'],
    // JE-002 — depreciation
    ['JE-002', '2026-05-31', '5000', 'Depreciation',      '500.00',  '0.00',    'May Depreciation',   'USD', 'Equipment depreciation'],
    ['JE-002', '2026-05-31', '1500', 'Office Equipment',  '0.00',    '500.00',  'May Depreciation',   'USD', 'Equipment depreciation'],
    // JE-003 — owner draw
    ['JE-003', '2026-06-01', '3000', 'Owner\'s Equity',   '2000.00', '0.00',    'Owner Draw June',    'USD', 'Monthly owner draw'],
    ['JE-003', '2026-06-01', '1010', 'Operating Checking','0.00',    '2000.00', 'Owner Draw June',    'USD', 'Monthly owner draw'],
  ]
);

// ── invoice-payments ──────────────────────────────────────────────────────────
save('invoice_payments.xlsx',
  ['invoice_number','amount','date','payment_type','currency_code','bank_account_number','customer_name','note'],
  [
    ['INV-1042', '66.95',  '2026-06-02', 'Check',  'USD', '1010', 'Acme Inc',           'Check #1042'],
    ['INV-1043', '1296.00','2026-06-05', 'Wire',   'USD', '1010', 'Global Tech LLC',    'Wire ref TXN-9023'],
    ['INV-1044', '249.95', '2026-06-08', 'ACH',    'USD', '1010', 'Sunrise Retail',     'ACH batch 0608'],
    ['INV-1045', '999.00', '2026-06-10', 'Online', 'USD', '1010', 'BlueSky Consulting', 'Online payment portal'],
  ]
);

// ── bill-payments ─────────────────────────────────────────────────────────────
save('bill_payments.xlsx',
  ['bill_number','amount','paid_date','payment_type','currency_code','bank_account_number','vendor_name','issue_date','note'],
  [
    ['B-5001', '69.99',  '2026-06-01', 'Check',  'USD', '1010', 'Office Depot',    '2026-05-10', 'Check #5501'],
    ['B-5002', '199.00', '2026-06-03', 'ACH',    'USD', '1010', 'Amazon Business', '2026-05-12', 'ACH transfer'],
    ['B-5003', '38.50',  '2026-06-05', 'Check',  'USD', '1010', 'FedEx',           '2026-05-15', 'Check #5502'],
    ['B-5004', '599.00', '2026-06-08', 'Wire',   'USD', '1010', 'Adobe Systems',   '2026-05-20', 'Wire TXN-8801'],
  ]
);

console.log('\nAll test sheets generated in testing/');
