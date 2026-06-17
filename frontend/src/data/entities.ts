export type Cat = 'accounts' | 'people' | 'catalog' | 'money' | 'docs' | 'payments';
export type Status = 'done' | 'testing' | 'idle' | 'running' | 'error';

export interface Entity {
  id: string;
  parseId?: string;
  name: string;
  cat: Cat;
  status: Status;
  pushed: number;
  skipped: number;
  failed: number;
  dur: string;
  last: string;
  qbdFile: string;
  csv: string;
  parseable: boolean;
  progress: number;
}

export interface Issue {
  row: number;
  sev: 'error' | 'warning';
  field: string;
  value: string;
  msg: string;
  fix: string;
}

export interface TplCol {
  col: string;
  req: boolean;
  ds: string;
  ex: string;
}

// Expense Categories intentionally excluded — FreshBooks handles them automatically
// when expenses are pushed (categories are auto-matched or created on the fly).
export const ENTITIES: Entity[] = [
  { id:'chart-of-accounts', parseId:'coa', name:'Chart of Accounts', cat:'accounts', status:'done', pushed:142, skipped:3, failed:0, dur:'2.1s', last:'09:41 AM', qbdFile:'COA.IIF', csv:'coa.csv', parseable:true, progress:100 },
  { id:'clients', parseId:'clients', name:'Clients', cat:'people', status:'done', pushed:264, skipped:7, failed:0, dur:'5.8s', last:'09:42 AM', qbdFile:'Customer.IIF', csv:'clients.csv', parseable:true, progress:100 },
  { id:'vendors', parseId:'vendors', name:'Vendors', cat:'people', status:'done', pushed:118, skipped:12, failed:2, dur:'3.2s', last:'09:42 AM', qbdFile:'Vendor.IIF', csv:'vendors.csv', parseable:true, progress:92 },
  { id:'items', parseId:'items', name:'Items', cat:'catalog', status:'done', pushed:89, skipped:5, failed:1, dur:'2.7s', last:'09:43 AM', qbdFile:'Item.IIF', csv:'items.csv', parseable:true, progress:96 },
  { id:'services', parseId:'services', name:'Services', cat:'catalog', status:'done', pushed:54, skipped:0, failed:0, dur:'1.9s', last:'09:43 AM', qbdFile:'Service.IIF', csv:'services.csv', parseable:true, progress:100 },
  { id:'expenses', parseId:'expenses', name:'Expenses', cat:'money', status:'done', pushed:612, skipped:18, failed:3, dur:'14.6s', last:'09:44 AM', qbdFile:'Expense.IIF', csv:'expenses.csv', parseable:true, progress:98 },
  { id:'income', parseId:'income', name:'Income', cat:'money', status:'done', pushed:431, skipped:9, failed:0, dur:'9.1s', last:'09:45 AM', qbdFile:'Income.IIF', csv:'income.csv', parseable:true, progress:100 },
  { id:'invoices', parseId:'invoices', name:'Invoices', cat:'docs', status:'done', pushed:387, skipped:11, failed:2, dur:'18.2s', last:'09:48 AM', qbdFile:'Invoice.IIF', csv:'invoices.csv', parseable:true, progress:95 },
  { id:'bills', parseId:'bills', name:'Bills', cat:'docs', status:'done', pushed:156, skipped:6, failed:0, dur:'6.9s', last:'09:49 AM', qbdFile:'Bill.IIF', csv:'bills.csv', parseable:true, progress:100 },
  { id:'credit-notes', parseId:'credit-notes', name:'Credit Notes', cat:'docs', status:'done', pushed:43, skipped:2, failed:0, dur:'2.3s', last:'09:49 AM', qbdFile:'CreditMemo.IIF', csv:'credit_notes.csv', parseable:true, progress:100 },
  { id:'invoice-payments', name:'Invoice Payments', cat:'payments', status:'testing', pushed:0, skipped:0, failed:0, dur:'–', last:'–', qbdFile:'(derived)', csv:'invoice_payments.csv', parseable:false, progress:70 },
  { id:'bill-payments', name:'Bill Payments', cat:'payments', status:'testing', pushed:0, skipped:0, failed:0, dur:'–', last:'–', qbdFile:'(derived)', csv:'bill_payments.csv', parseable:false, progress:65 },
  { id:'journal-entries', parseId:'journal-entries', name:'Journal Entries', cat:'money', status:'done', pushed:203, skipped:4, failed:1, dur:'7.4s', last:'09:46 AM', qbdFile:'JournalEntry.IIF', csv:'journal_entries.csv', parseable:true, progress:97 },
];

export const ISSUES: Record<string, Issue[]> = {
  'clients': [
    { row:24,  sev:'error',   field:'clientName', value:'(empty)',   msg:'Client Name is required but is empty.',         fix:'Add a value in the Client Name column for this row, then re-run.' },
    { row:88,  sev:'error',   field:'clientName', value:'(empty)',   msg:'Client Name is required but is empty.',         fix:'Add a value in the Client Name column for this row, then re-run.' },
    { row:131, sev:'error',   field:'email',      value:'milan@@co', msg:'Email address is not a valid format.',          fix:'Correct the email so it follows name@domain.com.' },
    { row:152, sev:'warning', field:'clientName', value:'Acme Inc',  msg:'Duplicate of an existing FreshBooks client.',  fix:'Merge manually in FreshBooks if this is a distinct client.' },
    { row:203, sev:'warning', field:'currency',   value:'(blank)',   msg:'Currency missing – defaulting to USD.',        fix:'Set a currency code if this client should not use USD.' },
  ],
  'vendors': [
    { row:12, sev:'error',   field:'vendorName', value:'N/A',        msg:'Vendor name is the literal text "N/A".',       fix:'Replace "N/A" with the real vendor name or a placeholder.' },
    { row:47, sev:'error',   field:'vendorName', value:'N/A',        msg:'Vendor name is the literal text "N/A".',       fix:'Replace "N/A" with the real vendor name or a placeholder.' },
    { row:61, sev:'warning', field:'phone',      value:'555-12',     msg:'Phone number looks incomplete.',               fix:'Verify the phone number; record will still migrate.' },
    { row:90, sev:'warning', field:'vendorName', value:'Office Depot',msg:'Possible duplicate vendor.',                  fix:'Confirm in FreshBooks before merging.' },
  ],
  'items': [
    { row:8,  sev:'error',   field:'unitPrice', value:'0.00',         msg:'Unit price is 0.00 – FreshBooks rejects zero-priced items.', fix:'Set a price > 0, or mark as free/zero-rated.' },
    { row:34, sev:'warning', field:'sku',       value:'(blank)',       msg:'SKU missing – item will migrate without a SKU.',             fix:'Add a SKU if you track inventory codes.' },
    { row:55, sev:'warning', field:'category',  value:'Uncategorized', msg:'No category mapped – placed in Uncategorized.',             fix:'Map a FreshBooks category if needed.' },
  ],
  'journal-entries': [
    { row:35096, sev:'error',   field:'account',    value:'First Community Bank Checking', msg:'Account referenced is not present in the Chart of Accounts.', fix:'Create this account in FreshBooks COA, then re-run.' },
    { row:35140, sev:'error',   field:'debitCredit', value:'unbalanced', msg:'Entry does not balance – debits ≠ credits.',   fix:'Adjust line amounts so total debits equal total credits.' },
    { row:35201, sev:'warning', field:'memo',        value:'(blank)',    msg:'Memo is empty.',                                fix:'Optional – add a memo for clarity.' },
  ],
  'invoices': [
    { row:1042, sev:'error',   field:'clientName', value:'(unmatched)', msg:'Invoice references a client that was not migrated.', fix:'Migrate the Clients entity first, or fix the client name.' },
    { row:1090, sev:'error',   field:'dueDate',    value:'2026-13-02',  msg:'Due date is not a valid calendar date.',            fix:'Use a real date in YYYY-MM-DD format.' },
    { row:1155, sev:'warning', field:'lineItem',   value:'qty 0',       msg:'Line item has quantity 0.',                         fix:'Remove the line or set a quantity.' },
  ],
  'expenses': [
    { row:402, sev:'error',   field:'category', value:'(unmapped)',  msg:'Expense category could not be mapped to FreshBooks.', fix:'Map this category on the Expense Categories step first.' },
    { row:511, sev:'warning', field:'amount',   value:'-12.00',     msg:'Negative amount – will be recorded as a credit.',     fix:'Confirm this should be a credit, not an expense.' },
    { row:560, sev:'warning', field:'vendor',   value:'(blank)',    msg:'No vendor on expense.',                               fix:'Optional – attach a vendor for reporting.' },
  ],
};

export const TEMPLATES: Record<string, TplCol[]> = {
  'chart-of-accounts': [
    { col:'name',                  req:true,  ds:'Account display name', ex:'Operating Checking' },
    { col:'type',                  req:true,  ds:'asset | liability | income | expense | equity', ex:'asset' },
    { col:'sub_type',              req:true,  ds:'FreshBooks sub-type e.g. Cash & Bank, Income', ex:'Cash & Bank' },
    { col:'number',                req:false, ds:'Account number/code', ex:'1010' },
    { col:'parent_account_number', req:false, ds:'Parent account number (leave blank for top-level accounts)', ex:'1000' },
    { col:'state',                 req:false, ds:'active or archived (defaults to active)', ex:'active' },
  ],
  'expense-categories': [
    { col:'category_name', req:true, ds:'Name of the expense category', ex:'Travel' },
  ],
  'clients': [
    { col:'fname',         req:false, ds:'First name', ex:'Jane' },
    { col:'lname',         req:false, ds:'Last name', ex:'Smith' },
    { col:'organization',  req:true,  ds:'Company name – required', ex:'Acme Inc' },
    { col:'email',         req:false, ds:'Primary contact email', ex:'jane@acme.com' },
    { col:'currency_code', req:false, ds:'3-letter ISO code, defaults to USD', ex:'USD' },
    { col:'bus_phone',     req:false, ds:'Business phone', ex:'555-0142' },
    { col:'mob_phone',     req:false, ds:'Mobile phone', ex:'555-0199' },
    { col:'p_street',      req:false, ds:'Street address line 1', ex:'12 Main St' },
    { col:'p_city',        req:false, ds:'City', ex:'New York' },
    { col:'p_province',    req:false, ds:'State / Province', ex:'NY' },
    { col:'p_code',        req:false, ds:'ZIP / Postal code', ex:'10001' },
    { col:'p_country',     req:false, ds:'Country code', ex:'US' },
    { col:'note',          req:false, ds:'Internal note', ex:'Migrated from QBD' },
  ],
  'vendors': [
    { col:'vendor_name',                req:true,  ds:'Vendor name – must not be empty or "N/A"', ex:'Office Depot' },
    { col:'primary_contact_first_name', req:false, ds:'Contact first name', ex:'John' },
    { col:'primary_contact_last_name',  req:false, ds:'Contact last name', ex:'Doe' },
    { col:'primary_contact_email',      req:false, ds:'Contact email', ex:'billing@od.com' },
    { col:'phone',                      req:false, ds:'Phone number', ex:'555-0199' },
    { col:'street',                     req:false, ds:'Street address', ex:'100 Office Blvd' },
    { col:'city',                       req:false, ds:'City', ex:'Boston' },
    { col:'province',                   req:false, ds:'State / Province', ex:'MA' },
    { col:'postal_code',                req:false, ds:'ZIP / Postal code', ex:'02101' },
    { col:'country',                    req:false, ds:'Country code', ex:'US' },
    { col:'currency_code',              req:false, ds:'3-letter ISO code, defaults to USD', ex:'USD' },
    { col:'note',                       req:false, ds:'Internal note', ex:'Preferred supplier' },
  ],
  'items': [
    { col:'name',                  req:true,  ds:'Item name', ex:'Widget A' },
    { col:'unit_cost',             req:true,  ds:'Unit price – must be greater than 0.00', ex:'19.99' },
    { col:'income_account_number', req:true,  ds:'COA account number to link income', ex:'4000' },
    { col:'currency_code',         req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'description',           req:false, ds:'Item description', ex:'Standard widget' },
    { col:'sku',                   req:false, ds:'Stock keeping unit', ex:'WID-A-01' },
    { col:'qty',                   req:false, ds:'Default quantity (defaults to 1)', ex:'1' },
  ],
  'services': [
    { col:'name',                  req:true,  ds:'Service name', ex:'Consulting' },
    { col:'rate',                  req:true,  ds:'Hourly / flat rate', ex:'120.00' },
    { col:'income_account_number', req:true,  ds:'COA account number to link income', ex:'4000' },
    { col:'billable',              req:false, ds:'true or false', ex:'true' },
  ],
  'expenses': [
    { col:'date',          req:true,  ds:'YYYY-MM-DD', ex:'2026-05-01' },
    { col:'amount',        req:true,  ds:'Expense amount (base, before tax)', ex:'45.00' },
    { col:'category_name', req:true,  ds:'Must match an Expense Category name exactly', ex:'Travel' },
    { col:'vendor',        req:true,  ds:'Vendor name', ex:'Delta Airlines' },
    { col:'currency_code', req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'notes',         req:false, ds:'Expense note', ex:'Client meeting travel' },
    { col:'tax_name1',     req:false, ds:'Tax label 1', ex:'GST' },
    { col:'tax_amount1',   req:false, ds:'Tax amount 1', ex:'2.25' },
    { col:'tax_name2',     req:false, ds:'Tax label 2', ex:'PST' },
    { col:'tax_amount2',   req:false, ds:'Tax amount 2', ex:'1.80' },
  ],
  'income': [
    { col:'date',          req:true,  ds:'YYYY-MM-DD', ex:'2026-05-02' },
    { col:'amount',        req:true,  ds:'Income amount', ex:'500.00' },
    { col:'category_name', req:true,  ds:'QBD category (stored as note in FreshBooks)', ex:'Sales Revenue' },
    { col:'currency_code', req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'source',        req:false, ds:'Income source label', ex:'Product sales' },
    { col:'payment_type',  req:false, ds:'Check | Cash | Credit | ACH | Wire | Online', ex:'Check' },
    { col:'note',          req:false, ds:'Free-text note', ex:'Q1 product revenue' },
  ],
  // One row per debit/credit line, grouped by entry_number
  'journal-entries': [
    { col:'entry_number',   req:true,  ds:'Groups lines into one entry – all rows with same number = one JE', ex:'JE-001' },
    { col:'date',           req:true,  ds:'YYYY-MM-DD (same for all lines of one entry)', ex:'2026-05-03' },
    { col:'account_number', req:true,  ds:'COA account number (use this OR account_name)', ex:'1010' },
    { col:'account_name',   req:true,  ds:'COA account name (used if account_number not found)', ex:'Operating Checking' },
    { col:'debit',          req:true,  ds:'Debit amount (0 for credit lines)', ex:'1000.00' },
    { col:'credit',         req:true,  ds:'Credit amount (0 for debit lines)', ex:'0.00' },
    { col:'name',           req:true,  ds:'Entry title shown in FreshBooks', ex:'Monthly accrual' },
    { col:'currency_code',  req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'description',    req:false, ds:'Entry description', ex:'Accrued expense adjustment' },
  ],
  // One row per line item, grouped by invoice_number
  'invoices': [
    { col:'invoice_number',   req:true,  ds:'Groups line items – all rows with same number = one invoice', ex:'INV-1042' },
    { col:'customer_name',    req:true,  ds:'Must match a migrated client name or organization', ex:'Acme Inc' },
    { col:'create_date',      req:true,  ds:'Invoice date YYYY-MM-DD', ex:'2026-05-15' },
    { col:'line_name',        req:true,  ds:'Line item description', ex:'Widget A' },
    { col:'line_qty',         req:true,  ds:'Quantity (must be > 0)', ex:'2' },
    { col:'line_unit_cost',   req:true,  ds:'Price per unit', ex:'19.99' },
    { col:'customer_email',   req:false, ds:'Used to look up client if name does not match', ex:'ar@acme.com' },
    { col:'due_offset_days',  req:false, ds:'Days until due from invoice date (default 30)', ex:'30' },
    { col:'currency_code',    req:false, ds:'3-letter ISO code, defaults to USD', ex:'USD' },
    { col:'line_description', req:false, ds:'Extended line description', ex:'Standard widget unit' },
    { col:'notes',            req:false, ds:'Invoice-level notes', ex:'Thank you for your business' },
    { col:'terms',            req:false, ds:'Payment terms text', ex:'Net 30' },
    { col:'tax_name1',        req:false, ds:'Tax label 1', ex:'GST' },
    { col:'tax_amount1',      req:false, ds:'Tax amount 1 for this line', ex:'2.00' },
    { col:'tax_name2',        req:false, ds:'Tax label 2', ex:'PST' },
    { col:'tax_amount2',      req:false, ds:'Tax amount 2 for this line', ex:'1.60' },
  ],
  // One row per line item, grouped by bill_number
  'bills': [
    { col:'bill_number',     req:true,  ds:'Groups line items – all rows with same number = one bill', ex:'B-5001' },
    { col:'vendor_name',     req:true,  ds:'Must match a migrated vendor name exactly', ex:'Office Depot' },
    { col:'date',            req:true,  ds:'Bill issue date YYYY-MM-DD', ex:'2026-05-10' },
    { col:'category_name',   req:true,  ds:'Must match an Expense Category name exactly', ex:'Office Supplies' },
    { col:'amount',          req:true,  ds:'Line item amount', ex:'250.00' },
    { col:'quantity',        req:true,  ds:'Line quantity', ex:'1' },
    { col:'currency_code',   req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'due_offset_days', req:true,  ds:'Days until due from bill date', ex:'30' },
    { col:'desc',            req:false, ds:'Line description', ex:'Printer paper x 10 reams' },
    { col:'tax_name1',       req:false, ds:'Tax label 1', ex:'GST' },
    { col:'tax_amount1',     req:false, ds:'Tax amount 1', ex:'12.50' },
    { col:'tax_name2',       req:false, ds:'Tax label 2', ex:'PST' },
    { col:'tax_amount2',     req:false, ds:'Tax amount 2', ex:'10.00' },
  ],
  // One row per line item, grouped by credit_note_number
  'credit-notes': [
    { col:'credit_note_number', req:true,  ds:'Groups lines – all rows with same number = one credit note', ex:'CN-001' },
    { col:'customer_name',      req:true,  ds:'Must match a migrated client name or organization', ex:'Acme Inc' },
    { col:'date',               req:true,  ds:'Credit note date YYYY-MM-DD', ex:'2026-05-20' },
    { col:'amt',                req:true,  ds:'Line item amount', ex:'50.00' },
    { col:'line_name',          req:true,  ds:'Line description', ex:'Refund – Widget A' },
    { col:'customer_email',     req:true,  ds:'Used to look up client if name does not match', ex:'ar@acme.com' },
    { col:'currency_code',      req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'credit_type',        req:true,  ds:'goodwill | overpayment | credit', ex:'goodwill' },
    { col:'qun',                req:false, ds:'Line quantity (default 1)', ex:'1' },
    { col:'des',                req:false, ds:'Extended line description', ex:'Returned damaged unit' },
    { col:'notes',              req:false, ds:'Credit note notes', ex:'Refund approved by manager' },
    { col:'tax',                req:false, ds:'Tax name 1', ex:'GST' },
    { col:'taxq',               req:false, ds:'Tax amount 1', ex:'2.50' },
    { col:'tax2',               req:false, ds:'Tax name 2', ex:'PST' },
    { col:'taxq2',              req:false, ds:'Tax amount 2', ex:'2.00' },
  ],
  'invoice-payments': [
    { col:'invoice_number',      req:true,  ds:'Invoice number to pay', ex:'INV-1042' },
    { col:'amount',              req:true,  ds:'Payment amount', ex:'39.98' },
    { col:'date',                req:true,  ds:'Payment date YYYY-MM-DD', ex:'2026-05-22' },
    { col:'payment_type',        req:true,  ds:'Check | Cash | Credit | ACH | Wire | Online', ex:'Check' },
    { col:'currency_code',       req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'bank_account_number', req:true,  ds:'COA account number for the bank account — used to create an offsetting JE that nullifies Petty Cash', ex:'1010' },
    { col:'customer_name',       req:false, ds:'Fallback if invoice_number not found', ex:'Acme Inc' },
    { col:'note',                req:false, ds:'Payment note', ex:'Bank transfer ref #12345' },
  ],
  'bill-payments': [
    { col:'bill_number',         req:true,  ds:'Bill number to pay', ex:'B-5001' },
    { col:'amount',              req:true,  ds:'Payment amount', ex:'250.00' },
    { col:'paid_date',           req:true,  ds:'Payment date YYYY-MM-DD', ex:'2026-05-23' },
    { col:'payment_type',        req:true,  ds:'Check | Cash | Credit | ACH | Wire | Online', ex:'Check' },
    { col:'currency_code',       req:true,  ds:'3-letter ISO code e.g. USD', ex:'USD' },
    { col:'bank_account_number', req:true,  ds:'COA account number for the bank account — used to create an offsetting JE that nullifies Petty Cash', ex:'1010' },
    { col:'vendor_name',         req:false, ds:'Fallback if bill_number not found', ex:'Office Depot' },
    { col:'issue_date',          req:false, ds:'Original bill date – used for fallback matching', ex:'2026-05-10' },
    { col:'note',                req:false, ds:'Payment note', ex:'Wire ref #98765' },
  ],
};

export function issuesFor(id: string): Issue[] { return ISSUES[id] || []; }
export function countIssues(id: string) {
  const list = issuesFor(id);
  return { err: list.filter(i => i.sev === 'error').length, warn: list.filter(i => i.sev === 'warning').length };
}
export function templateFor(id: string): TplCol[] {
  const alias: Record<string, string> = { 'coa': 'chart-of-accounts', 'all-data': 'items' };
  return TEMPLATES[alias[id] || id] || [{ col: 'name', req: true, ds: 'Record name', ex: 'Example' }];
}
