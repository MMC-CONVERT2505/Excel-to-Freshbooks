import axios from 'axios';
import { AsyncLocalStorage } from 'async_hooks';
import prisma from '../lib/prisma.js';

const BASE = 'https://api.freshbooks.com';

// ── Per-request session context ─────────────────────────────────────────────
// Each migration runs inside runWithToken(), which stores the session's account
// details in AsyncLocalStorage. This prevents concurrent users from overwriting
// each other's globals (_accountId etc.) and sending data to the wrong account.
interface SessionCtx {
  tokenId:      number;
  accountId:    string;
  businessUuid: string;
  businessId:   string;
}
const sessionCtx = new AsyncLocalStorage<SessionCtx>();

export async function runWithToken<T>(tokenId: number, fn: () => Promise<T>): Promise<T> {
  const token = await prisma.freshbooksToken.findUnique({ where: { id: tokenId } });
  if (!token) throw new Error(`Token ${tokenId} not found in DB`);
  const ctx: SessionCtx = {
    tokenId,
    accountId:    token.accountId    || _accountId,
    businessUuid: token.businessUuid || _businessUuid,
    businessId:   token.businessId   || _businessId,
  };
  return sessionCtx.run(ctx, fn);
}

// Returns the tokenId for the current async execution context (set by runWithToken).
// Used by migration.service.ts to scope liveProgress / cancelledEntities per user.
export function getSessionTokenId(): number | null {
  return sessionCtx.getStore()?.tokenId ?? null;
}

// Legacy module-level globals — used as fallback when no session context is set
// (e.g., startup, OAuth flow, non-migration routes).
let _accountId:    string = process.env.FRESHBOOKS_ACCOUNT_ID    || '';
let _businessUuid: string = process.env.FRESHBOOKS_BUSINESS_UUID || '';
let _businessId:   string = process.env.FRESHBOOKS_BUSINESS_ID   || '';

export function setBusinessConfig(accountId: string, businessUuid: string, businessId: string) {
  _accountId    = accountId;
  _businessUuid = businessUuid;
  _businessId   = businessId;
}

export async function loadBusinessConfigFromDB() {
  const token = await prisma.freshbooksToken.findFirst({ where: { isCurrent: true } })
    ?? await prisma.freshbooksToken.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
  if (token?.accountId)    _accountId    = token.accountId;
  if (token?.businessUuid) _businessUuid = token.businessUuid;
  if (token?.businessId)   _businessId   = token.businessId;
  console.log(`[CONFIG] accountId=${_accountId} businessUuid=${_businessUuid}`);
}

// Load business config for a specific session token — must be called before any migration
// to ensure the global config points to the right FreshBooks account.
export async function loadBusinessConfigForToken(tokenId: number): Promise<void> {
  const token = await prisma.freshbooksToken.findUnique({ where: { id: tokenId } });
  if (!token) throw new Error(`Token ID ${tokenId} not found in DB`);
  if (token.accountId)    _accountId    = token.accountId;
  if (token.businessUuid) _businessUuid = token.businessUuid;
  if (token.businessId)   _businessId   = token.businessId;
  // Ensure getToken() returns THIS token's access token for all subsequent API calls
  await prisma.freshbooksToken.updateMany({ where: { isActive: true }, data: { isCurrent: false } });
  await prisma.freshbooksToken.update({ where: { id: tokenId }, data: { isCurrent: true } });
}

async function getToken() {
  const ctx = sessionCtx.getStore();
  let token = ctx?.tokenId
    ? await prisma.freshbooksToken.findUnique({ where: { id: ctx.tokenId } })
    : null;

  // Fallback for OAuth flow / non-migration routes (no session context)
  if (!token) {
    token = await prisma.freshbooksToken.findFirst({ where: { isCurrent: true } })
      ?? await prisma.freshbooksToken.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
  }
  if (!token) throw new Error('No token found. Complete OAuth flow first.');

  // Auto-refresh if expired or expiring within 5 minutes
  if (token.expiresAt <= new Date(Date.now() + 5 * 60 * 1000)) {
    console.log('[TOKEN] Expired or expiring soon — refreshing...');
    token = await refreshToken(token);
  }

  return token;
}

async function refreshToken(token: any) {
  const response = await axios.post('https://api.freshbooks.com/auth/oauth/token', {
    grant_type:    'refresh_token',
    client_id:     process.env.FRESHBOOKS_CLIENT_ID,
    client_secret: process.env.FRESHBOOKS_CLIENT_SECRET,
    refresh_token: token.refreshToken,
  });

  const t = response.data;
  const expiresAt = new Date((t.created_at + t.expires_in) * 1000);

  // On refresh: keep the same company active; deselect old token but keep it for audit
  await prisma.freshbooksToken.update({ where: { id: token.id }, data: { isCurrent: false } });

  const newToken = await prisma.freshbooksToken.create({
    data: {
      accessToken:  t.access_token,
      refreshToken: t.refresh_token,
      tokenType:    t.token_type || 'Bearer',
      scope:        t.scope,
      expiresAt,
      isActive:     true,
      isCurrent:    true,
      companyLabel: token.companyLabel,
      accountId:    token.accountId,
      businessUuid: token.businessUuid,
      businessId:   token.businessId,
    },
  });

  await prisma.tokenRefreshLog.create({
    data: {
      tokenId:     newToken.id,
      status:      'SUCCESS',
      oldExpiresAt: token.expiresAt,
      newExpiresAt: expiresAt,
    },
  });

  // Update the session context so subsequent getToken() calls use the new token ID,
  // not the old (now-expired) one that was stored when runWithToken() started.
  const ctx = sessionCtx.getStore();
  if (ctx) {
    ctx.tokenId = newToken.id;
    if (newToken.accountId)    ctx.accountId    = newToken.accountId;
    if (newToken.businessUuid) ctx.businessUuid = newToken.businessUuid;
    if (newToken.businessId)   ctx.businessId   = newToken.businessId;
  }

  console.log(`[TOKEN] Refreshed — new expiry: ${expiresAt.toISOString()}`);
  return newToken;
}

function accountId()    { return sessionCtx.getStore()?.accountId    ?? _accountId; }
function businessUuid() { return sessionCtx.getStore()?.businessUuid ?? _businessUuid; }
function businessId()   { return sessionCtx.getStore()?.businessId   ?? _businessId; }

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function getFreshbooksToken() {
  return getToken();
}

export async function getFreshBooksIdentity() {
  const token = await getToken();
  const res = await axios.get(`${BASE}/auth/api/v1/users/me`, {
    headers: authHeader(token.accessToken),
  });
  return res.data;
}

export async function getClients() {
  const token = await getToken();
  const allClients: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/users/clients?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allClients.push(...(result?.clients || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { clients: allClients, total: allClients.length } } };
}

export async function createClient(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/users/clients`,
    { client: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/users/clients/{clientId}
// Updatable: fname, lname, email, bus_phone, mob_phone, home_phone, fax,
//   p_street, p_city, p_province, p_code, p_country, organization,
//   currency_code, language, note, vat_number, company_industry, company_size
export async function updateClient(clientId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/users/clients/${clientId}`,
    { client: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// Soft-delete a client: vis_state 1 = deleted
export async function deleteClient(clientId: number) {
  return updateClient(clientId, { vis_state: 1 });
}

export async function getInvoices() {
  const token = await getToken();
  const allInvoices: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/invoices/invoices?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allInvoices.push(...(result?.invoices || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  console.log(`[INVOICES] Fetched ${allInvoices.length} invoices from FreshBooks (account ${accountId()})`);
  return { response: { result: { invoices: allInvoices, total: allInvoices.length } } };
}

export async function searchInvoiceByNumber(invoiceNumber: string): Promise<any | null> {
  const token = await getToken();
  try {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/invoices/invoices?search[invoice_number]=${encodeURIComponent(invoiceNumber)}&per_page=10`,
      { headers: authHeader(token.accessToken) }
    );
    const invoices: any[] = res.data?.response?.result?.invoices || [];
    return invoices[0] ?? null;
  } catch {
    return null;
  }
}

export async function createInvoice(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/invoices/invoices`,
    { invoice: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/invoices/invoices/{invoiceId}
// Updatable: invoice_number, customerid, create_date, due_offset_days, discount_value,
//   discount_description, po_number, currency_code, language, terms, notes,
//   organization, fname, lname, vat_name, vat_number, lines (MUST include all lines),
//   template, auto_bill, status, v3_status, estimateid, ownerid
// Action params: action_mark_as_sent, action_email
export async function updateInvoice(invoiceId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/invoices/invoices/${invoiceId}`,
    { invoice: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// Soft-delete an invoice: vis_state 1 = deleted
export async function deleteInvoice(invoiceId: number) {
  return updateInvoice(invoiceId, { vis_state: 1 });
}

export async function getItems() {
  const token = await getToken();
  const allItems: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/items/items?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allItems.push(...(result?.items || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  console.log(`[getItems] fetched ${allItems.length} items across ${page - 1} page(s)`);
  return { response: { result: { items: allItems, total: allItems.length } } };
}

export async function getArchivedItems() {
  const token = await getToken();
  // Try both FreshBooks filter formats for archived items
  for (const params of ['search[vis_state]=1', 'vis_state=1', 'search[vis_state]=99']) {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/items/items?${params}`,
      { headers: authHeader(token.accessToken) }
    );
    const items: any[] = res.data?.response?.result?.items || [];
    console.log(`[getArchivedItems] ${params} → ${items.length} items`);
    if (items.length > 0) return items;
  }
  return [];
}

// PUT /accounting/account/{accountId}/items/items/{itemId}
// Updatable: name, description, unit_cost, tax1, tax2, inventory, vis_state
export async function updateItem(itemId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/items/items/${itemId}`,
    { item: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function createItem(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/items/items`,
    { item: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteItem(itemId: number) {
  return updateItem(itemId, { vis_state: 1 });
}

export async function getChartOfAccounts() {
  const token = await getToken();
  const res = await axios.get(
    `${BASE}/accounting/businesses/${businessUuid()}/reports/chart_of_accounts?user_ledger_entries=true`,
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function createChartOfAccount(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/businesses/${businessUuid()}/ledger_accounts/accounts`,
    body,
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// GET list of user-created ledger accounts (for bulk operations)
export async function getLedgerAccounts() {
  const token = await getToken();
  const allAccounts: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/businesses/${businessUuid()}/ledger_accounts/accounts?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const data = res.data;
    const batch = data?.accounts || data?.ledgerAccounts || data?.response?.result?.accounts || [];
    allAccounts.push(...batch);
    const total = data?.total ?? data?.meta?.total ?? 0;
    pages = data?.pages || data?.meta?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { accounts: allAccounts, total: allAccounts.length };
}

// PUT /accounting/businesses/{businessUuid}/ledger_accounts/accounts/{accountId}
// Updatable: account_name, account_number, account_type, sub_account_type,
//   currency_code, description, is_contractor, parent_id
export async function updateChartOfAccount(ledgerAccountId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/businesses/${businessUuid()}/ledger_accounts/accounts/${ledgerAccountId}`,
    body,
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// Soft-delete via vis_state (HTTP DELETE returns 405 on this endpoint)
export async function deleteChartOfAccount(ledgerAccountId: number) {
  return updateChartOfAccount(ledgerAccountId, { vis_state: 1 });
}

export async function createAccountGroup(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/businesses/${businessUuid()}/ledger_accounts/accounts`,
    { ...body, parent_account: null },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}


export async function getExpenseCategories() {
  const token = await getToken();
  const allCategories: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/expenses/categories?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allCategories.push(...(result?.categories || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { categories: allCategories, total: allCategories.length } } };
}

export async function getExpenses() {
  const token = await getToken();
  const allExpenses: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/expenses/expenses?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allExpenses.push(...(result?.expenses || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { expenses: allExpenses, total: allExpenses.length } } };
}

function flattenObject(obj: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of Object.keys(obj || {})) {
    const val = obj[key];
    const fullKey = prefix ? `${prefix}_${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenObject(val, fullKey));
    } else if (Array.isArray(val)) {
      result[fullKey] = JSON.stringify(val);
    } else {
      result[fullKey] = val ?? '';
    }
  }
  return result;
}

export async function exportExpensesExcel(): Promise<Buffer> {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  const data = await getExpenses();
  const expenses: any[] = data?.response?.result?.expenses || [];

  if (expenses.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No expenses found']]), 'Expenses');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // Flatten all expenses and collect every unique key across all records
  const flatRows = expenses.map(e => flattenObject(e));
  const allKeys = [...new Set(flatRows.flatMap(r => Object.keys(r)))].sort();

  // Build rows with all keys in A-Z order
  const rows = flatRows.map(r => {
    const row: Record<string, any> = {};
    for (const k of allKeys) row[k] = r[k] ?? '';
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: allKeys });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function createExpense(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/expenses/expenses`,
    { expense: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/expenses/expenses/{expenseId}
// Updatable: categoryid, vendor, amount, date, notes, staffid, clientid,
//   projectid, invoiceid, markup_percent, taxName1, taxAmount1, taxName2,
//   taxAmount2, currency_code, is_cogs, account_name
// Soft-delete: vis_state 1 = deleted
export async function updateExpense(expenseId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/expenses/expenses/${expenseId}`,
    { expense: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteExpense(expenseId: number) {
  return updateExpense(expenseId, { vis_state: 1 });
}

export async function createPayment(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/payments/payments`,
    { payment: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/payments/payments/{paymentId}
// Updatable: invoiceid, amount, date, type, note, vis_state
// Soft-delete: vis_state 1 = deleted
export async function updatePayment(paymentId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/payments/payments/${paymentId}`,
    { payment: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deletePayment(paymentId: number) {
  return updatePayment(paymentId, { vis_state: 1 });
}

export async function getVendors() {
  const token = await getToken();
  const allVendors: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/bill_vendors/bill_vendors?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allVendors.push(...(result?.bill_vendors || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { bill_vendors: allVendors, total: allVendors.length } } };
}

export async function createVendor(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/bill_vendors/bill_vendors`,
    { bill_vendor: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}


// PUT /accounting/account/{accountId}/bill_vendors/bill_vendors/{vendorId}
// Updatable: vendor_name, primary_contact_first_name, primary_contact_last_name,
//   primary_contact_email, street, city, province, postal_code, country,
//   account_number, phone, website, currency_code, language, is_1099
// Soft-delete: vis_state 1 = deleted
export async function updateVendor(vendorId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/bill_vendors/bill_vendors/${vendorId}`,
    { bill_vendor: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteVendor(vendorId: number) {
  return updateVendor(vendorId, { vis_state: 1 });
}

export async function getBills() {
  const token = await getToken();
  const allBills: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/bills/bills?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allBills.push(...(result?.bills || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { bills: allBills, total: allBills.length } } };
}

export async function createBills(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/bills/bills`,
    { bill: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/bills/bills/{billId}
// Updatable: vendor_id, status, due_date, issue_date, currency_code,
//   lines (line_id, description, unit_cost, quantity, category_id), notes
// Soft-delete: vis_state 1 = deleted, vis_state 2 = archived
export async function updateBill(billId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/bills/bills/${billId}`,
    { bill: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteBill(billId: number) {
  return updateBill(billId, { vis_state: 1 });
}

export async function archiveBill(billId: number) {
  return updateBill(billId, { vis_state: 2 });
}

export async function getServices() {
  const token = await getToken();
  const allServices: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/comments/business/${businessId()}/services?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const data = res.data;
    allServices.push(...(data?.services || []));
    const total = data?.total ?? data?.meta?.total ?? 0;
    pages = data?.pages ?? data?.meta?.pages ?? (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { services: allServices, total: allServices.length } } };
}

export async function createService(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(`${BASE}/comments/business/${businessId()}/service`, { service: body }, { headers: authHeader(token.accessToken) });
  return res.data;
}

// PUT /comments/business/{businessId}/service/{serviceId}
// Updatable: name, income_account_id, billable, etc.
export async function updateService(serviceId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/comments/business/${businessId()}/service/${serviceId}`,
    { service: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /comments/business/{businessId}/service/{serviceId}/rate
// Only updatable field: rate (string, e.g. "150.00")
export async function updateServiceRate(serviceId: number, rate: string) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/comments/business/${businessId()}/service/${serviceId}/rate`,
    { service_rate: { rate } },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function setServiceRate(serviceId: number, rate: string) {
  const token = await getToken();
  const res = await axios.post(`${BASE}/comments/business/${businessId()}/service/${serviceId}/rate`, { service_rate: { rate } }, { headers: authHeader(token.accessToken) });
  return res.data;
}

export async function getIncome() {
  const token = await getToken();
  const allIncome: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/other_incomes/other_incomes?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allIncome.push(...(result?.other_incomes || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { other_incomes: allIncome, total: allIncome.length } } };
}

export async function createIncome(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/other_incomes/other_incomes`,
    { other_income: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/other_incomes/other_incomes/{incomeId}
// Updatable: income_type, amount, date, description, currency_code, category_id, vis_state
// Soft-delete: vis_state 1 = deleted
export async function updateIncome(incomeId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/other_incomes/other_incomes/${incomeId}`,
    { other_income: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteIncome(incomeId: number) {
  const token = await getToken();
  const res = await axios.delete(
    `${BASE}/accounting/account/${accountId()}/other_incomes/other_incomes/${incomeId}`,
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function getCreditNotes() {
  const token = await getToken();
  const allNotes: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/credit_notes/credit_notes?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allNotes.push(...(result?.credit_notes || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { credit_notes: allNotes, total: allNotes.length } } };
}

export async function createCreditNote(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/credit_notes/credit_notes`,
    { credit_note: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/credit_notes/credit_notes/{creditNoteId}
// Updatable: clientid, create_date, currency_code, discount_value, notes,
//   lines (line items), vis_state
// Soft-delete: vis_state 1 = deleted
export async function updateCreditNote(creditNoteId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/credit_notes/credit_notes/${creditNoteId}`,
    { credit_note: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteCreditNote(creditNoteId: number) {
  return updateCreditNote(creditNoteId, { vis_state: 1 });
}

export async function getPayments() {
  const token = await getToken();
  const allPayments: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/payments/payments?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allPayments.push(...(result?.payments || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { payments: allPayments, total: allPayments.length } } };
}

export async function getBillPayments() {
  const token = await getToken();
  const allBillPayments: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/bill_payments/bill_payments?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allBillPayments.push(...(result?.bill_payments || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { bill_payments: allBillPayments, total: allBillPayments.length } } };
}

export async function createBillPayment(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/bill_payments/bill_payments`,
    { bill_payment: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /accounting/account/{accountId}/bill_payments/bill_payments/{billPaymentId}
// Updatable: billid, amount, date, paid_with_merchantid, vis_state
// Soft-delete: vis_state 1 = deleted
export async function updateBillPayment(billPaymentId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/account/${accountId()}/bill_payments/bill_payments/${billPaymentId}`,
    { bill_payment: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteBillPayment(billPaymentId: number) {
  return updateBillPayment(billPaymentId, { vis_state: 1 });
}

export async function getJournalEntries() {
  const token = await getToken();
  const allEntries: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/businesses/${businessUuid()}/journal_entries?page=${page}&per_page=100`,
      { headers: { ...authHeader(token.accessToken), 'x-api-version': '2023-09-25' } }
    );
    const data = res.data;
    allEntries.push(...(data?.manualJournalEntries || []));
    const total = data?.total ?? data?.meta?.total ?? 0;
    pages = data?.pages ?? data?.meta?.pages ?? (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { manualJournalEntries: allEntries, total: allEntries.length };
}

export async function createExpenseCategory(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/account/${accountId()}/expenses/categories`,
    { category: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function createJournalEntry(body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.post(
    `${BASE}/accounting/businesses/${businessUuid()}/journal_entries`,
    { manualJournalEntry: body },
    { headers: { ...authHeader(token.accessToken), 'x-api-version': '2023-09-25' } }
  );
  return res.data;
}

// PUT /accounting/businesses/{businessUuid}/journal_entries/{entryId}
// Requires header: x-api-version: 2023-09-25
// Updatable: narration, reference, journal_entry_date, entry_lines
// No vis_state — use DELETE endpoint to remove
export async function updateJournalEntry(entryId: string, body: Record<string, any>) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/accounting/businesses/${businessUuid()}/journal_entries/${entryId}`,
    { manualJournalEntry: body },
    { headers: { ...authHeader(token.accessToken), 'x-api-version': '2023-09-25' } }
  );
  return res.data;
}

export async function deleteJournalEntry(entryId: string) {
  const token = await getToken();
  const res = await axios.delete(
    `${BASE}/accounting/businesses/${businessUuid()}/journal_entries/${entryId}`,
    { headers: { ...authHeader(token.accessToken), 'x-api-version': '2023-09-25' } }
  );
  return res.data;
}

// ── INVOICE BULK UPDATE (groups rows by freshbooks_id, builds lines array) ───────
// The export sheet has one row per line item. To update, rows are grouped by
// freshbooks_id, invoice-level fields are taken from the first row in each group,
// and line fields (line_name, line_qty, line_unit_cost, etc.) become the lines[].
async function bulkUpdateInvoices(rows: Array<Record<string, any>>): Promise<{ updated: number; failed: number; errors: string[] }> {
  // Group rows by freshbooks_id
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const rawId = String(row['freshbooks_id'] ?? row['id'] ?? row['ID'] ?? '').trim();
    if (!rawId) continue;
    if (!groups.has(rawId)) groups.set(rawId, []);
    groups.get(rawId)!.push(row);
  }

  let updated = 0, failed = 0;
  const errors: string[] = [];

  for (const [rawId, lineRows] of groups) {
    try {
      const header = lineRows[0];
      const invoiceId = Number(rawId);
      if (isNaN(invoiceId)) { failed++; errors.push(`ID "${rawId}": not a valid number`); continue; }

      // Invoice-level fields from first row
      const invoiceBody: Record<string, any> = {};
      const invoiceFields = ['notes', 'terms', 'due_offset_days', 'po_number', 'language', 'currency_code'];
      for (const f of invoiceFields) {
        if (header[f] !== undefined && header[f] !== '') invoiceBody[f] = header[f];
      }

      // Build lines array — only include rows that have at least a qty or unit_cost
      const lines = lineRows
        .filter(r => r['line_qty'] !== '' || r['line_unit_cost'] !== '')
        .map(r => {
          const lineObj: Record<string, any> = {
            name:        r['line_name']        ?? '',
            description: r['line_description'] ?? '',
            qty:         Number(r['line_qty'])  || 1,
            unit_cost: {
              amount: String(r['line_unit_cost'] ?? 0),
              code:   header['currency_code'] || 'USD',
            },
          };
          if (r['tax_name1']) { lineObj.taxName1 = r['tax_name1']; lineObj.taxAmount1 = Number(r['tax_amount1']) || 0; }
          if (r['tax_name2']) { lineObj.taxName2 = r['tax_name2']; lineObj.taxAmount2 = Number(r['tax_amount2']) || 0; }
          return lineObj;
        });

      if (lines.length > 0) invoiceBody.lines = lines;

      await updateInvoice(invoiceId, invoiceBody);
      updated++;
    } catch (err: any) {
      failed++;
      errors.push(`ID ${rawId}: ${err?.response?.data?.message || err.message}`);
    }
  }

  return { updated, failed, errors };
}

// ── SERVICES EXPORT (resolves income_account_id UUID → account_number) ──────────
// The raw service list from FreshBooks has income_account_id as a UUID. This export
// builds a reverse map (UUID → account_number) so the sheet is human-readable and
// can be re-uploaded directly for bulk updates.
async function exportServicesExcel(): Promise<Buffer> {
  const [servicesRes, coaRes, ledgerRes] = await Promise.all([
    getServices(),
    getChartOfAccounts(),
    getLedgerAccounts(),
  ]);

  const services: any[] = servicesRes?.response?.result?.services || [];

  // Build UUID → account_number reverse map from both endpoints
  const uuidToNumber: Record<string, string> = {};
  function indexAccounts(items: any[]) {
    for (const a of items) {
      if (a.account_uuid && a.account_number) uuidToNumber[a.account_uuid] = a.account_number;
      if (a.sub_accounts?.length) indexAccounts(a.sub_accounts);
    }
  }
  indexAccounts(coaRes?.response?.result?.journal_entry_accounts || []);
  indexAccounts(ledgerRes?.accounts || []);

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  if (services.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', '(no records found)']]), 'services');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const rows = services.map((s: any) => ({
    id:                    s.id ?? '',
    name:                  s.name ?? '',
    rate:                  s.rate?.amount ?? s.rate ?? '',
    billable:              s.billable ?? '',
    income_account_number: s.income_account_id ? (uuidToNumber[s.income_account_id] ?? s.income_account_id) : '',
  }));

  const keys = Object.keys(rows[0]);
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  if (ws['A1']) ws['A1'].s = { font: { bold: true } };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'services');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── INVOICE FULL EXPORT (with line items, matches upload template format) ────────
// Fetches all invoices with include[]=lines so each line item becomes a separate row.
async function exportInvoicesExcel(): Promise<Buffer> {
  const token = await getToken();
  const allInvoices: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/invoices/invoices?page=${page}&per_page=100&include[]=lines`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allInvoices.push(...(result?.invoices || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  if (allInvoices.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['invoice_number', '(no records found)']]), 'invoices');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // One row per line item — invoice header fields repeated on every row
  const rows: Record<string, any>[] = [];
  for (const inv of allInvoices) {
    const lines: any[] = Array.isArray(inv.lines) && inv.lines.length > 0 ? inv.lines : [{}];
    for (const line of lines) {
      rows.push({
        freshbooks_id:   inv.id ?? '',
        invoice_number:  inv.invoice_number ?? '',
        customer_name:   inv.current_organization || `${inv.fname || ''} ${inv.lname || ''}`.trim() || '',
        customer_email:  inv.email ?? '',
        create_date:     inv.create_date ?? '',
        due_offset_days: inv.due_offset_days ?? 30,
        currency_code:   inv.currency_code ?? 'USD',
        language:        inv.language ?? 'en',
        status:          inv.status ?? '',
        notes:           inv.notes ?? '',
        terms:           inv.terms ?? '',
        po_number:       inv.po_number ?? '',
        line_name:       line.name ?? '',
        line_description: line.description ?? '',
        line_qty:        line.qty ?? '',
        line_unit_cost:  line.unit_cost?.amount ?? '',
        tax_name1:       line.taxName1 ?? '',
        tax_amount1:     line.taxAmount1 ?? '',
        tax_name2:       line.taxName2 ?? '',
        tax_amount2:     line.taxAmount2 ?? '',
      });
    }
  }

  const keys = Object.keys(rows[0]);
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  if (ws['A1']) ws['A1'].s = { font: { bold: true } };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'invoices');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── ENTITY-LEVEL OPERATIONS (delete by ID, bulk delete, update by ID, bulk update) ──

type AnyDeleteFn = (id: any) => Promise<any>;
type AnyUpdateFn = (id: any, body: Record<string, any>) => Promise<any>;

interface EntityCfg {
  getAll: () => Promise<any>;
  extractRecords: (data: any) => Array<{ id: any }>;
  deleteOne: AnyDeleteFn;
  updateOne: AnyUpdateFn;
  stringId?: boolean;  // journal entries use string IDs
  exportFn?: () => Promise<Buffer>;  // custom export override (e.g. invoices with line items)
  bulkUpdateFn?: (rows: Array<Record<string, any>>) => Promise<{ updated: number; failed: number; errors: string[] }>;
}

const ENTITY_CFG: Record<string, EntityCfg> = {
  'clients':           { getAll: getClients,        extractRecords: d => d.response?.result?.clients || [],         deleteOne: deleteClient,        updateOne: updateClient },
  'vendors':           { getAll: getVendors,         extractRecords: d => d.response?.result?.bill_vendors || [],    deleteOne: deleteVendor,        updateOne: updateVendor },
  'items':             { getAll: getItems,           extractRecords: d => d.response?.result?.items || [],           deleteOne: deleteItem,          updateOne: updateItem },
  'expenses':          { getAll: getExpenses,        extractRecords: d => d.response?.result?.expenses || [],        deleteOne: deleteExpense,       updateOne: updateExpense },
  'income':            { getAll: getIncome,          extractRecords: d => d.response?.result?.other_incomes || [],   deleteOne: deleteIncome,        updateOne: updateIncome },
  'invoices':          { getAll: getInvoices,        extractRecords: d => d.response?.result?.invoices || [],        deleteOne: deleteInvoice,       updateOne: updateInvoice, exportFn: exportInvoicesExcel, bulkUpdateFn: bulkUpdateInvoices },
  'bills':             { getAll: getBills,           extractRecords: d => d.response?.result?.bills || [],           deleteOne: deleteBill,          updateOne: updateBill },
  'credit-notes':      { getAll: getCreditNotes,     extractRecords: d => d.response?.result?.credit_notes || [],    deleteOne: deleteCreditNote,    updateOne: updateCreditNote },
  'invoice-payments':  { getAll: getPayments,        extractRecords: d => d.response?.result?.payments || [],        deleteOne: deletePayment,       updateOne: updatePayment },
  'bill-payments':     { getAll: getBillPayments,    extractRecords: d => d.response?.result?.bill_payments || [],   deleteOne: deleteBillPayment,   updateOne: updateBillPayment },
  'journal-entries':   { getAll: getJournalEntries,  extractRecords: d => d.manualJournalEntries || [],              deleteOne: deleteJournalEntry,  updateOne: updateJournalEntry, stringId: true },
  'chart-of-accounts': {
    getAll: getLedgerAccounts,
    extractRecords: (d: any) => d?.accounts || [],
    deleteOne: deleteChartOfAccount,
    updateOne: updateChartOfAccount,
  },
  'services': {
    getAll: getServices,
    extractRecords: (d: any) => d.response?.result?.services || [],
    exportFn: exportServicesExcel,
    deleteOne: async () => { throw Object.assign(new Error('Services cannot be deleted via this API'), { statusCode: 400 }); },
    updateOne: async (id: number, body: Record<string, any>) => {
      // Resolve income_account_number → UUID before sending to FreshBooks
      if (body.income_account_number) {
        const coaRes = await getChartOfAccounts();
        const coaAccounts: any[] = coaRes?.response?.result?.journal_entry_accounts || [];
        const ledgerRes = await getLedgerAccounts();
        const ledgerAccounts: any[] = ledgerRes?.accounts || [];
        const allAccounts = [...coaAccounts, ...ledgerAccounts];
        const numMap: Record<string, string> = {};
        function indexAccounts(items: any[]) {
          for (const a of items) {
            if (a.account_number && a.account_uuid) numMap[a.account_number] = a.account_uuid;
            if (a.sub_accounts?.length) indexAccounts(a.sub_accounts);
          }
        }
        indexAccounts(allAccounts);
        const uuid = numMap[body.income_account_number];
        if (uuid) body = { ...body, income_account_id: uuid };
        delete body.income_account_number;
      }
      // Update rate separately if provided (rate lives on a different sub-endpoint)
      if (body.rate) {
        await updateServiceRate(id, String(body.rate));
        const { rate: _r, ...rest } = body;
        body = rest;
      }
      if (Object.keys(body).length === 0) return;
      return updateService(id, body);
    },
  },
};

export async function exportEntityExcel(entityId: string): Promise<Buffer> {
  const cfg = ENTITY_CFG[entityId];
  if (!cfg) throw Object.assign(new Error(`Unknown entity: ${entityId}`), { statusCode: 400 });
  if (cfg.exportFn) return cfg.exportFn();

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  const data = await cfg.getAll();
  const records = cfg.extractRecords(data);

  if (records.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', '(no records found)']]), entityId);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const flatRows = records.map((r: any) => flattenObject(r));
  const allKeys = [...new Set(flatRows.flatMap((r: any) => Object.keys(r)))] as string[];
  // Put id first so users see it immediately
  const keys = ['id', ...allKeys.filter(k => k !== 'id').sort()];

  const rows = flatRows.map((r: any) => {
    const row: Record<string, any> = {};
    for (const k of keys) row[k] = r[k] ?? '';
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  // Bold the id column header
  if (ws['A1']) ws['A1'].s = { font: { bold: true } };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, entityId.replace(/-/g, '_'));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function deleteEntityById(entityId: string, recordId: string): Promise<any> {
  const cfg = ENTITY_CFG[entityId];
  if (!cfg) throw Object.assign(new Error(`Unknown entity: ${entityId}`), { statusCode: 400 });
  const id = cfg.stringId ? recordId : Number(recordId);
  return cfg.deleteOne(id);
}

export async function bulkDeleteEntity(entityId: string): Promise<{ deleted: number; failed: number; errors: string[] }> {
  const cfg = ENTITY_CFG[entityId];
  if (!cfg) throw Object.assign(new Error(`Unknown entity: ${entityId}`), { statusCode: 400 });
  const data     = await cfg.getAll();
  const records  = cfg.extractRecords(data);
  let deleted = 0, failed = 0;
  const errors: string[] = [];
  for (const rec of records) {
    try {
      await cfg.deleteOne(rec.id);
      deleted++;
    } catch (err: any) {
      failed++;
      errors.push(`ID ${rec.id}: ${err?.response?.data?.message || err.message}`);
    }
  }
  return { deleted, failed, errors };
}

export async function updateEntityById(entityId: string, recordId: string, body: Record<string, any>): Promise<any> {
  const cfg = ENTITY_CFG[entityId];
  if (!cfg) throw Object.assign(new Error(`Unknown entity: ${entityId}`), { statusCode: 400 });
  const id = cfg.stringId ? recordId : Number(recordId);
  return cfg.updateOne(id, body);
}

export async function bulkUpdateEntity(entityId: string): Promise<{ updated: number; failed: number; errors: string[] }> {
  const cfg = ENTITY_CFG[entityId];
  if (!cfg) throw Object.assign(new Error(`Unknown entity: ${entityId}`), { statusCode: 400 });
  const ctxTokenId = sessionCtx.getStore()?.tokenId
    ?? (await prisma.freshbooksToken.findFirst({ where: { isCurrent: true } }))?.id
    ?? null;
  const sheet = await prisma.uploadedSheet.findFirst({
    where: { entity: entityId, tokenId: ctxTokenId, expiresAt: { gt: new Date() } },
    orderBy: { uploadedAt: 'desc' },
  });
  if (!sheet) throw Object.assign(new Error(`No uploaded sheet found for "${entityId}" — upload the file first`), { statusCode: 400 });
  const rows = sheet.rows as Array<Record<string, any>>;
  if (cfg.bulkUpdateFn) return cfg.bulkUpdateFn(rows);
  let updated = 0, failed = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawId = row['id'] ?? row['freshbooks_id'] ?? row['ID'];
    if (rawId == null) { failed++; errors.push(`Row ${i + 1}: missing "id" column`); continue; }
    try {
      const { id: _a, freshbooks_id: _b, ID: _c, ...body } = row;
      const id = cfg.stringId ? String(rawId) : Number(rawId);
      await cfg.updateOne(id, body);
      updated++;
    } catch (err: any) {
      failed++;
      errors.push(`Row ${i + 1} (ID ${rawId}): ${err?.response?.data?.message || err.message}`);
    }
  }
  return { updated, failed, errors };
}

export async function getEstimates() {
  const token = await getToken();
  const allEstimates: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/estimates/estimates?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allEstimates.push(...(result?.estimates || []));
    pages = result?.pages || 1;
    page++;
  } while (page <= pages);
  return { response: { result: { estimates: allEstimates, total: allEstimates.length } } };
}

export async function getEstimateLines() {
  const token = await getToken();
  const allEstimates: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/estimates/estimates?page=${page}&per_page=100&include[]=lines`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allEstimates.push(...(result?.estimates || []));
    pages = result?.pages || 1;
    page++;
  } while (page <= pages);

  const lines = allEstimates.flatMap((est: any) =>
    (est.lines || []).map((line: any) => ({
      estimate_id:     est.estimateid,
      estimate_number: est.estimatenum,
      client_id:       est.clientid,
      organization:    est.organization,
      status:          est.status,
      estimate_date:   est.create_date,
      line_id:         line.lineid,
      item_name:       line.name,
      description:     line.description,
      qty:             line.qty,
      unit_cost:       line.unit_cost?.amount ?? line.unit_cost,
      currency:        line.unit_cost?.code   ?? est.currency_code,
      total_amount:    line.amount?.amount    ?? line.amount,
    }))
  );

  return { lines, total: lines.length };
}

export async function getCreditMemos() {
  const token = await getToken();
  const allMemos: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/accounting/account/${accountId()}/credit_notes/credit_notes?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allMemos.push(...(result?.credit_notes || []));
    pages = result?.pages || 1;
    page++;
  } while (page <= pages);
  return { response: { result: { credit_notes: allMemos, total: allMemos.length } } };
}

export async function getProjects() {
  const token = await getToken();
  const allProjects: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await axios.get(
      `${BASE}/projects/business/${businessId()}/projects?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const data = res.data;
    allProjects.push(...(data?.projects || []));
    pages = data?.meta?.pages ?? 1;
    page++;
  } while (page <= pages);
  return { projects: allProjects, total: allProjects.length };
}

