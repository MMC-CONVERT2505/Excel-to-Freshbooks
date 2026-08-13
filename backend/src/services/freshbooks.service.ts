import axios from 'axios';
import { AsyncLocalStorage } from 'async_hooks';
import prisma from '../lib/prisma.js';

const BASE = 'https://api.freshbooks.com';

const fbAxios = axios.create();

// ── Per-request session context ─────────────────────────────────────────────
// Each migration runs inside runWithToken(), which stores the session's account
// details in AsyncLocalStorage. This prevents concurrent users from overwriting
// each other's globals (_accountId etc.) and sending data to the wrong account.
interface SessionCtx {
  tokenId:      number;
  accountId:    string;
  businessUuid: string;
  businessId:   string;
  companyLabel: string;
  triggeredBy?: string | null;
}
const sessionCtx = new AsyncLocalStorage<SessionCtx>();

export async function runWithToken<T>(tokenId: number, fn: () => Promise<T>, triggeredBy?: string | null): Promise<T> {
  const token = await prisma.freshbooksToken.findUnique({ where: { id: tokenId } });
  if (!token) throw new Error(`Token ${tokenId} not found in DB`);

  // Never inherit _accountId here. Those globals are overwritten by whichever company
  // connected most recently, so a token whose business was never resolved (multi-business
  // account where the user has not picked one yet) would silently target someone else's
  // account — accountId is the company segment of every FreshBooks URL.
  if (!token.accountId) {
    const err = new Error(
      'This FreshBooks connection has no business selected yet. Choose the company on the Connect page before continuing.'
    );
    (err as any).statusCode = 409;
    throw err;
  }

  const ctx: SessionCtx = {
    tokenId,
    accountId:    token.accountId,
    businessUuid: token.businessUuid || '',
    businessId:   token.businessId   || '',
    companyLabel: token.companyLabel || '(unnamed)',
    triggeredBy:  triggeredBy ?? null,
  };
  return sessionCtx.run(ctx, fn);
}

export function getSessionTokenId(): number | null {
  return sessionCtx.getStore()?.tokenId ?? null;
}

// The company this request is bound to. Null outside a session.
export function getSessionCompany(): { accountId: string; label: string } | null {
  const s = sessionCtx.getStore();
  return s ? { accountId: s.accountId, label: s.companyLabel } : null;
}

export function getSessionTriggeredBy(): string | null {
  return sessionCtx.getStore()?.triggeredBy ?? null;
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

// NOTE: loadBusinessConfigForToken() was removed here deliberately. It mutated the
// process-wide globals and flipped isCurrent across every token, so two users calling
// it concurrently would clobber each other's account and send one customer's data into
// the other's company. Per-session isolation is handled by runWithToken() instead —
// do not reintroduce a "set the current company globally" helper.

async function getToken() {
  const ctx = sessionCtx.getStore();
  let token = ctx?.tokenId
    ? await prisma.freshbooksToken.findUnique({ where: { id: ctx.tokenId } })
    : null;

  // No session context means we cannot know which company this call belongs to.
  // Previously this fell through to "isCurrent, else newest active token" — i.e.
  // whichever company connected last, possibly another client's — which silently
  // sent one customer's data into another customer's account. Refuse instead.
  if (!token) {
    const err = new Error(
      'No FreshBooks session for this request. Reconnect on the Connect page — ' +
      'refusing to guess which company this belongs to.'
    );
    (err as any).statusCode = 401;
    throw err;
  }

  // Auto-refresh if expired or expiring within 5 minutes
  if (token.expiresAt <= new Date(Date.now() + 5 * 60 * 1000)) {
    console.log('[TOKEN] Expired or expiring soon — refreshing...');
    token = await refreshToken(token);
  }

  return token;
}

async function refreshToken(token: any) {
  const response = await fbAxios.post('https://api.freshbooks.com/auth/oauth/token', {
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

// Inside a session the context is authoritative and the globals are never blended in —
// they belong to whichever company connected last. The bare globals remain only for the
// OAuth bootstrap, which runs before any session exists.
function accountId()    { const s = sessionCtx.getStore(); return s ? s.accountId    : _accountId; }
function businessUuid() { const s = sessionCtx.getStore(); return s ? s.businessUuid : _businessUuid; }
function businessId()   { const s = sessionCtx.getStore(); return s ? s.businessId   : _businessId; }

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function getFreshbooksToken() {
  return getToken();
}

export async function getFreshBooksIdentity() {
  const token = await getToken();
  const res = await fbAxios.get(`${BASE}/auth/api/v1/users/me`, {
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.put(
    `${BASE}/accounting/account/${accountId()}/items/items/${itemId}`,
    { item: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function createItem(body: Record<string, any>) {
  const token = await getToken();
  const res = await fbAxios.post(
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
  const res = await fbAxios.get(
    `${BASE}/accounting/businesses/${businessUuid()}/reports/chart_of_accounts?use_ledger_entries=true`,
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

function flattenCoaTree(accounts: any[], parentName = ''): any[] {
  const rows: any[] = [];
  for (const a of accounts || []) {
    const { sub_accounts, ...rest } = a;
    rows.push({ ...rest, parent_account_name: parentName });
    if (Array.isArray(sub_accounts) && sub_accounts.length > 0) {
      rows.push(...flattenCoaTree(sub_accounts, a.account_name || ''));
    }
  }
  return rows;
}

export async function createChartOfAccount(body: Record<string, any>) {
  const token = await getToken();
  const res = await fbAxios.post(
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
    const res = await fbAxios.get(
      `${BASE}/accounting/businesses/${businessUuid()}/ledger_accounts/accounts?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const data = res.data;
    const batch = data?.ledger_accounts || data?.accounts || data?.ledgerAccounts || data?.response?.result?.accounts || [];
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
  const res = await fbAxios.put(
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
  const res = await fbAxios.post(
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
    const res = await fbAxios.get(
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
    const res = await fbAxios.get(
      `${BASE}/accounting/account/${accountId()}/expenses/expenses?page=${page}&per_page=100&include[]=category`,
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

  const [data, catData] = await Promise.all([getExpenses(), getExpenseCategories()]);
  const expenses: any[]   = data?.response?.result?.expenses || [];
  const categories: any[] = catData?.response?.result?.categories || [];

  if (expenses.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No expenses found']]), 'Expenses');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // Build categoryid→name map from categories list as fallback
  // FreshBooks category objects use the field "category" (not "name") for the display name
  const catMap: Record<number, string> = {};
  for (const c of categories) {
    const cid = c.id ?? c.categoryid;
    const cname = c.category ?? c.name ?? c.category_name ?? '';
    if (cid) catMap[Number(cid)] = cname;
  }

  // Flatten expenses; category_name comes from embedded category object (include[]=category)
  // FreshBooks embeds category as { category: "...", categoryid: N, ... } — field is "category" not "name"
  const flatRows = expenses.map(e => {
    const flat = flattenObject(e);
    flat.category_name = e.category?.category ?? e.category?.name ?? catMap[e.categoryid] ?? catMap[e.category?.categoryid] ?? '';
    return flat;
  });
  const allKeys = ['id', 'category_name', ...new Set(flatRows.flatMap(r => Object.keys(r)).filter(k => k !== 'id' && k !== 'category_name'))].filter(
    (k, i, a) => a.indexOf(k) === i
  );

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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(`${BASE}/comments/business/${businessId()}/service`, { service: body }, { headers: authHeader(token.accessToken) });
  return res.data;
}

// PUT /comments/business/{businessId}/service/{serviceId}
// Updatable: name, billable, etc. (NOT income account — use updateTask for that)
export async function updateService(serviceId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await fbAxios.put(
    `${BASE}/comments/business/${businessId()}/service/${serviceId}`,
    { service: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// GET /accounting/account/{accountId}/projects/tasks — fetch all tasks (income account lives here)
export async function getTasks() {
  const token = await getToken();
  const allTasks: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
      `${BASE}/accounting/account/${accountId()}/projects/tasks?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const data = res.data?.response?.result;
    allTasks.push(...(data?.tasks || []));
    pages = data?.pages ?? 1;
    page++;
  } while (page <= pages);
  return allTasks;
}

// PUT /accounting/account/{accountId}/projects/tasks/{taskId}
// field: account_uuid = income account UUID
export async function updateTask(taskId: number, body: Record<string, any>) {
  const token = await getToken();
  const res = await fbAxios.put(
    `${BASE}/accounting/account/${accountId()}/projects/tasks/${taskId}`,
    { task: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

// PUT /comments/business/{businessId}/service/{serviceId}/rate
// Only updatable field: rate (string, e.g. "150.00")
export async function updateServiceRate(serviceId: number, rate: string, incomeAccountId?: string) {
  const token = await getToken();
  const body: Record<string, any> = { rate };
  if (incomeAccountId) body.income_account_id = incomeAccountId;
  const res = await fbAxios.put(
    `${BASE}/comments/business/${businessId()}/service/${serviceId}/rate`,
    { service_rate: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function setServiceRate(serviceId: number, rate: string) {
  const token = await getToken();
  const res = await fbAxios.post(`${BASE}/comments/business/${businessId()}/service/${serviceId}/rate`, { service_rate: { rate } }, { headers: authHeader(token.accessToken) });
  return res.data;
}

export async function getIncome() {
  const token = await getToken();
  const allIncome: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
      `${BASE}/accounting/account/${accountId()}/other_incomes/other_incomes?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allIncome.push(...(result?.other_income || result?.other_incomes || []));
    const total = result?.total ?? 0;
    pages = result?.pages || (total > 0 ? Math.ceil(total / 100) : 1);
    page++;
  } while (page <= pages);
  return { response: { result: { other_incomes: allIncome, total: allIncome.length } } };
}

export async function createIncome(body: Record<string, any>) {
  const token = await getToken();
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
    `${BASE}/accounting/account/${accountId()}/other_incomes/other_incomes/${incomeId}`,
    { other_income: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function deleteIncome(incomeId: number) {
  const token = await getToken();
  const res = await fbAxios.delete(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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

async function exportInvoicePaymentsExcel(): Promise<Buffer> {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  // Fetch payments and all invoices in parallel; build invoiceId → invoice lookup
  const [payData, invData] = await Promise.all([getPayments(), getInvoices()]);
  const payments: any[] = payData?.response?.result?.payments || [];
  const invoices: any[] = invData?.response?.result?.invoices || [];

  // Map FreshBooks invoice id → { invoice_number, client_name }
  const invMap: Record<number, { invoice_number: string; client_name: string }> = {};
  for (const inv of invoices) {
    invMap[inv.id] = {
      invoice_number: inv.invoice_number ?? '',
      client_name:    inv.current_organization || `${inv.fname || ''} ${inv.lname || ''}`.trim() || '',
    };
  }

  if (payments.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', '(no records found)']]), 'invoice_payments');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const rows = payments.map(p => ({
    id:             p.id ?? '',
    invoice_number: invMap[p.invoiceid]?.invoice_number ?? '',
    client_name:    invMap[p.invoiceid]?.client_name ?? '',
    invoice_id:     p.invoiceid ?? '',
    amount:         p.amount?.amount ?? '',
    currency_code:  p.amount?.code ?? '',
    date:           p.date ?? '',
    type:           p.type ?? '',
    note:           p.note ?? '',
  }));

  const keys = Object.keys(rows[0]);
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'invoice_payments');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function getBillPayments() {
  const token = await getToken();
  const allBillPayments: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
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
    const res = await fbAxios.get(
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
  const res = await fbAxios.post(
    `${BASE}/accounting/account/${accountId()}/expenses/categories`,
    { category: body },
    { headers: authHeader(token.accessToken) }
  );
  return res.data;
}

export async function createJournalEntry(body: Record<string, any>) {
  const token = await getToken();
  const res = await fbAxios.post(
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
  const res = await fbAxios.put(
    `${BASE}/accounting/businesses/${businessUuid()}/journal_entries/${entryId}`,
    { manualJournalEntry: body },
    { headers: { ...authHeader(token.accessToken), 'x-api-version': '2023-09-25' } }
  );
  return res.data;
}

export async function deleteJournalEntry(entryId: string) {
  const token = await getToken();
  const res = await fbAxios.delete(
    `${BASE}/accounting/businesses/${businessUuid()}/journal_entries/${entryId}`,
    { headers: { ...authHeader(token.accessToken), 'x-api-version': '2023-09-25' } }
  );
  return res.data;
}

// ── EXPENSE BULK UPDATE ───────────────────────────────────────────────────────────
// The export sheet is flattened (amount_amount, amount_code, vendor_name, etc.)
// We reconstruct only the fields FreshBooks accepts in a PUT and skip read-only ones.
// Convert Excel date serial (e.g. 44201) or string to YYYY-MM-DD
function toDateString(val: any): string | undefined {
  if (!val && val !== 0) return undefined;
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  if (typeof val === 'string' && /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(val)) return val; // normalizeDate handles it
  if (typeof val === 'number' && val > 40000 && val < 60000) {
    // Excel serial: days since 1900-01-01 (with leap year bug offset)
    const d = new Date((val - 25569) * 86400 * 1000);
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return undefined;
}

async function bulkUpdateExpenses(rows: Array<Record<string, any>>): Promise<{ updated: number; failed: number; errors: string[] }> {
  let updated = 0, failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawId = row['id'] ?? row['freshbooks_id'] ?? row['ID'];
    if (rawId == null) { failed++; errors.push(`Row ${i + 1}: missing "id" column`); continue; }

    const body: Record<string, any> = {};

    // Amount — supports full export (amount_amount/amount_code) and simple sheet (amount/currency)
    const amtVal  = row['amount_amount'] ?? row['amount'];
    const amtCode = row['amount_code']   ?? row['currency_code'] ?? row['currency'] ?? 'USD';
    if (amtVal !== '' && amtVal != null) body.amount = { amount: String(amtVal), code: amtCode };

    // Date — may be an Excel serial number
    const dateVal = toDateString(row['date']);
    if (dateVal) body.date = dateVal;

    // Scalar fields — skip zero/empty FK values to avoid permission errors
    if (row['categoryid'] && Number(row['categoryid']) > 0)    body.categoryid    = row['categoryid'];
    if (row['notes']      && String(row['notes']).trim())       body.notes         = row['notes'];
    if (row['clientid']   && Number(row['clientid'])  > 0)     body.clientid      = row['clientid'];
    if (row['projectid']  && Number(row['projectid']) > 0)     body.projectid     = row['projectid'];
    if (row['invoiceid']  && Number(row['invoiceid']) > 0)     body.invoiceid     = row['invoiceid'];
    if (row['markup_percent'] !== '' && row['markup_percent'] != null) body.markup_percent = row['markup_percent'];
    if (row['taxName1'])   body.taxName1   = row['taxName1'];
    if (row['taxAmount1']) body.taxAmount1 = row['taxAmount1'];
    if (row['taxName2'])   body.taxName2   = row['taxName2'];
    if (row['taxAmount2']) body.taxAmount2 = row['taxAmount2'];
    if (row['is_cogs'] != null && row['is_cogs'] !== '') body.is_cogs = row['is_cogs'];
    // staffid intentionally excluded — causes 403 if token doesn't match that staff member

    // Vendor — string field in FreshBooks
    const vendorVal = row['vendor_name'] ?? row['vendor'];
    if (vendorVal && typeof vendorVal === 'string' && vendorVal.trim()) body.vendor = vendorVal.trim();

    try {
      await updateExpense(Number(rawId), body);
      updated++;
    } catch (err: any) {
      failed++;
      const status = err?.response?.status;
      const detail = err?.response?.data;
      // Extract FreshBooks-specific error message from nested structure
      const fbErrors = detail?.response?.errors ?? detail?.errors;
      const fbMsg = Array.isArray(fbErrors)
        ? fbErrors.map((e: any) => e.message ?? e.errno ?? JSON.stringify(e)).join('; ')
        : null;
      const errMsg = fbMsg
        ? `HTTP ${status} — ${fbMsg}`
        : detail
          ? `HTTP ${status} — ${JSON.stringify(detail)}`
          : `HTTP ${status} — ${err.message}`;
      console.error(`[EXPENSE-UPDATE] ID=${rawId} status=${status} body=${JSON.stringify(body)} fb_response=${JSON.stringify(detail)}`);
      errors.push(`Row ${i + 1} (ID ${rawId}): ${errMsg}`);
    }
  }

  return { updated, failed, errors };
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
  const total = groups.size;
  let i = 0;
  console.log(`[INVOICES UPDATE] Starting — ${total} invoices`);

  for (const [rawId, lineRows] of groups) {
    i++;
    try {
      const header = lineRows[0];
      const invoiceId = Number(rawId);
      if (isNaN(invoiceId)) {
        failed++;
        errors.push(`ID "${rawId}": not a valid number`);
        console.log(`[INVOICES UPDATE] (${i}/${total}) ID "${rawId}" → ❌ not a valid number`);
        continue;
      }

      const invoiceBody: Record<string, any> = {};
      const invoiceFields = ['notes', 'terms', 'due_offset_days', 'po_number', 'language', 'currency_code'];
      for (const f of invoiceFields) {
        if (header[f] !== undefined && header[f] !== '') invoiceBody[f] = header[f];
      }

      // Only build lines if unit_cost is explicitly provided — otherwise skip lines
      // to avoid zeroing out amounts when user only updates invoice-level fields or line_name.
      const hasUnitCost = lineRows.some(
        r => r['line_unit_cost'] !== undefined && r['line_unit_cost'] !== ''
      );

      if (hasUnitCost) {
        const lines = lineRows
          .filter(r => r['line_name'] || r['line_qty'] !== '' || r['line_unit_cost'] !== '')
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
      }

      const invNum = header['invoice_number'] ?? rawId;
      await updateInvoice(invoiceId, invoiceBody);
      updated++;
      console.log(`[INVOICES UPDATE] (${i}/${total}) #${invNum} (ID ${invoiceId}) → ✓ updated`);
    } catch (err: any) {
      failed++;
      const msg = err?.response?.data?.message || err.message;
      errors.push(`ID ${rawId}: ${msg}`);
      console.log(`[INVOICES UPDATE] (${i}/${total}) ID ${rawId} → ❌ ${msg}`);
    }
  }
  console.log(`[INVOICES UPDATE] Done — updated: ${updated}, failed: ${failed}`);
  return { updated, failed, errors };
}

// ── SERVICES BULK UPDATE ─────────────────────────────────────────────────────────
// Fetches the account number→UUID map ONCE, then updates each service.
// Only sends income_account_id (not name/billable) to avoid FreshBooks rejections.
async function bulkUpdateServices(rows: Array<Record<string, any>>): Promise<{ updated: number; failed: number; errors: string[] }> {
  // Build account number → UUID map and fetch tasks (income account lives on accounting tasks)
  const [coaRes, ledgerRes, allTasks] = await Promise.all([getChartOfAccounts(), getLedgerAccounts(), getTasks()]);
  const numMap: Record<string, string> = {};
  function indexAccounts(items: any[]) {
    for (const a of items) {
      const num  = a.account_number || a.number;
      const uuid = a.account_uuid   || a.uuid;
      if (num && uuid) numMap[String(num)] = uuid;
      // Also index by name so users can supply name instead of number
      const name = a.account_name || a.name;
      if (name && uuid) numMap[`name::${name.toLowerCase()}`] = uuid;
      if (a.sub_accounts?.length) indexAccounts(a.sub_accounts);
      if (a.children?.length) indexAccounts(a.children);
    }
  }
  indexAccounts(coaRes?.response?.result?.journal_entry_accounts || []);
  indexAccounts(ledgerRes?.accounts || []);

  // Build name (lowercase) → task map so we can find task ID by service name
  const taskByName: Record<string, any> = {};
  for (const t of allTasks) {
    if (t.name) taskByName[t.name.toLowerCase().trim()] = t;
  }
  console.log(`[SERVICES UPDATE] Loaded ${allTasks.length} tasks from accounting API`);

  let updated = 0, failed = 0;
  const errors: string[] = [];
  console.log(`[SERVICES UPDATE] Starting — ${rows.length} rows`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawId = row['id'] ?? row['freshbooks_id'] ?? row['ID'];
    if (rawId == null || rawId === '') {
      failed++;
      errors.push(`Row ${i + 2}: missing id`);
      console.log(`[SERVICES UPDATE] (${i + 1}/${rows.length}) Row ${i + 2} → ❌ missing id`);
      continue;
    }
    const serviceId = Number(rawId);
    if (isNaN(serviceId)) {
      failed++;
      errors.push(`Row ${i + 2}: invalid id "${rawId}"`);
      console.log(`[SERVICES UPDATE] (${i + 1}/${rows.length}) Row ${i + 2} → ❌ invalid id "${rawId}"`);
      continue;
    }

    const name = String(row['name'] ?? serviceId);
    try {
      const acctNum = String(row['income_account_number'] ?? '').trim();
      const rateVal = row['rate'] !== undefined && row['rate'] !== '' ? String(row['rate']) : undefined;

      if (acctNum) {
        // Try by number, then by name
        const uuid = numMap[acctNum] ?? numMap[`name::${acctNum.toLowerCase()}`];
        if (!uuid) {
          failed++;
          errors.push(`Row ${i + 2} (ID ${serviceId}): account "${acctNum}" not found in FreshBooks chart of accounts`);
          console.log(`[SERVICES UPDATE] (${i + 1}/${rows.length}) ${name} → ❌ account "${acctNum}" not found`);
          continue;
        }
        // Income account lives on the accounting tasks API as account_uuid — match task by name
        const task = taskByName[name.toLowerCase().trim()];
        if (!task) {
          failed++;
          errors.push(`Row ${i + 2} (ID ${serviceId}): task not found for service "${name}"`);
          console.log(`[SERVICES UPDATE] (${i + 1}/${rows.length}) ${name} → ❌ no matching task found`);
          continue;
        }
        await updateTask(task.id, {
          name:         task.name,
          billable:     task.billable ?? true,
          account_uuid: uuid,
          rate:         task.rate ?? { amount: rateVal ?? '0.00', code: 'USD' },
        });
      } else if (rateVal) {
        await updateServiceRate(serviceId, rateVal);
      }
      updated++;
      console.log(`[SERVICES UPDATE] (${i + 1}/${rows.length}) ${name} → ✓ updated`);
    } catch (err: any) {
      failed++;
      const raw = err?.response?.data;
      const msg = raw ? JSON.stringify(raw) : err.message;
      errors.push(`Row ${i + 2} (ID ${serviceId}): ${msg}`);
      console.log(`[SERVICES UPDATE] (${i + 1}/${rows.length}) ${name} → ❌ ${msg}`);
    }
  }
  console.log(`[SERVICES UPDATE] Done — updated: ${updated}, failed: ${failed}`);
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

// ── ITEMS EXPORT (shows income_account_number resolved from UUID) ─────────────────
async function exportItemsExcel(): Promise<Buffer> {
  const [itemsRes, coaRes, ledgerRes] = await Promise.all([
    getItems(),
    getChartOfAccounts(),
    getLedgerAccounts(),
  ]);

  const items: any[] = itemsRes?.response?.result?.items || [];

  // Build UUID → account_number reverse map from both endpoints
  const uuidToNumber: Record<string, string> = {};
  function indexAccounts(accts: any[]) {
    for (const a of accts) {
      const uuid = a.account_uuid || a.uuid;
      const num  = a.account_number || a.number;
      if (uuid && num) uuidToNumber[uuid] = String(num);
      if (a.sub_accounts?.length) indexAccounts(a.sub_accounts);
      if (a.children?.length) indexAccounts(a.children);
    }
  }
  indexAccounts(coaRes?.response?.result?.journal_entry_accounts || []);
  indexAccounts(ledgerRes?.accounts || []);

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  if (items.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', '(no records found)']]), 'items');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const rows = items.map((it: any) => ({
    id:                    it.id ?? '',
    name:                  it.name ?? '',
    unit_cost:             it.unit_cost?.amount ?? '',
    currency_code:         it.unit_cost?.code ?? 'USD',
    description:           it.description ?? '',
    sku:                   it.sku ?? '',
    income_account_number: it.income_account_id
      ? (uuidToNumber[it.income_account_id] ?? it.income_account_id)
      : '',
  }));

  const keys = Object.keys(rows[0]);
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'items');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── INVOICE FULL EXPORT (with line items, matches upload template format) ────────
// Fetches all invoices with include[]=lines so each line item becomes a separate row.
async function exportInvoicesExcel(): Promise<Buffer> {
  const token = await getToken();
  const allInvoices: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
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
        invoice_total:    inv.amount?.amount ?? '',
        line_name:        line.name ?? '',
        line_description: line.description ?? '',
        line_qty:         line.qty ?? '',
        line_unit_cost:   line.unit_cost?.amount ?? '',
        line_subtotal:    line.amount?.amount ?? '',
        tax_name1:        line.taxName1 ?? '',
        tax_rate1:        line.taxAmount1 ?? '',
        tax_amount1:      line.amount?.amount && line.taxAmount1
                            ? (parseFloat(line.amount.amount) * parseFloat(line.taxAmount1) / 100).toFixed(2)
                            : '',
        tax_name2:        line.taxName2 ?? '',
        tax_rate2:        line.taxAmount2 ?? '',
        tax_amount2:      line.amount?.amount && line.taxAmount2
                            ? (parseFloat(line.amount.amount) * parseFloat(line.taxAmount2) / 100).toFixed(2)
                            : '',
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

// ── RECURRING INVOICES EXPORT (with line items) ───────────────────────────────────────
async function exportRecurringInvoicesExcel(): Promise<Buffer> {
  const token = await getToken();
  const allProfiles: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
      `${BASE}/accounting/account/${accountId()}/invoice_profiles/invoice_profiles?page=${page}&per_page=100&include[]=lines`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allProfiles.push(...(result?.invoice_profiles || []));
    pages = result?.pages || 1;
    page++;
  } while (page <= pages);

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  if (allProfiles.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', '(no records found)']]), 'recurring_invoices');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const rows: Record<string, any>[] = [];
  for (const prof of allProfiles) {
    const lines: any[] = Array.isArray(prof.lines) && prof.lines.length > 0 ? prof.lines : [{}];
    for (const line of lines) {
      rows.push({
        freshbooks_id:    prof.id ?? '',
        profileid:        prof.profileid ?? '',
        profile_code:     prof.code ?? '',
        customer_id:      prof.customerid ?? '',
        customer_name:    prof.organization || `${prof.fname || ''} ${prof.lname || ''}`.trim() || '',
        frequency:        prof.frequency ?? '',
        create_date:      prof.create_date ?? '',
        due_offset_days:  prof.due_offset_days ?? '',
        currency_code:    prof.currency_code ?? '',
        total_amount:     prof.amount?.amount ?? '',
        description:      prof.description ?? '',
        po_number:        prof.po_number ?? '',
        notes:            prof.notes ?? '',
        send_email:       prof.send_email ?? '',
        auto_bill:        prof.autobill ?? prof.auto_bill ?? '',
        language:         prof.language ?? '',
        line_name:        line.name ?? '',
        line_description: line.description ?? '',
        line_qty:         line.qty ?? '',
        line_unit_cost:   line.unit_cost?.amount ?? '',
        tax_name1:        line.taxName1 ?? '',
        tax_amount1:      line.taxAmount1 ?? '',
        tax_name2:        line.taxName2 ?? '',
        tax_amount2:      line.taxAmount2 ?? '',
      });
    }
  }

  const keys = Object.keys(rows[0]);
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'recurring_invoices');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── ITEMS BULK UPDATE ────────────────────────────────────────────────────────────────
async function bulkUpdateItems(rows: Array<Record<string, any>>): Promise<{ updated: number; failed: number; errors: string[] }> {
  // Build integer-ID, UUID, and name maps for income_account_number lookup
  const [coaRes, ledgerRes] = await Promise.all([getChartOfAccounts(), getLedgerAccounts()]);
  const intIdByNumber: Record<string, number> = {};
  const uuidByNumber:  Record<string, string>  = {};
  const nameByNumber:  Record<string, string>  = {};
  function indexAccounts(items: any[]) {
    for (const a of items) {
      const num  = String(a.account_number || a.number || '');
      const acctName = a.account_name || a.name || '';
      if (num) {
        if (typeof a.id === 'number') intIdByNumber[num] = a.id;
        const uuid = a.account_uuid || a.uuid;
        if (uuid) uuidByNumber[num] = uuid;
        if (acctName) nameByNumber[num] = acctName;
        // index by name too so user can supply account name as income_account_number
        const nameLower = acctName.toLowerCase();
        if (nameLower) {
          if (typeof a.id === 'number') intIdByNumber[`name::${nameLower}`] = a.id;
          if (uuid) uuidByNumber[`name::${nameLower}`] = uuid;
          nameByNumber[`name::${nameLower}`] = acctName;
        }
      }
      if (a.sub_accounts?.length) indexAccounts(a.sub_accounts);
      if (a.children?.length)     indexAccounts(a.children);
    }
  }
  indexAccounts(coaRes?.response?.result?.journal_entry_accounts || []);
  indexAccounts(ledgerRes?.accounts || []);

  let updated = 0, failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawId = row['id'] ?? row['ID'];
    if (rawId == null) { failed++; errors.push(`Row ${i + 1}: missing "id" column`); continue; }

    const body: Record<string, any> = {};

    if (row['name']        && String(row['name']).trim())        body.name        = String(row['name']).trim();
    if (row['description'] && String(row['description']).trim()) body.description = String(row['description']).trim();
    if (row['sku']         && String(row['sku']).trim())         body.sku         = String(row['sku']).trim();

    const costVal  = row['unit_cost'] ?? row['unit_cost_amount'];
    const costCode = row['currency_code'] ?? row['unit_cost_code'] ?? 'USD';
    if (costVal !== '' && costVal != null) body.unit_cost = { amount: String(costVal), code: costCode };

    // income_account_number → account_uuid (confirmed via browser inspect: FreshBooks uses account_uuid, not income_account_id)
    const acctRaw = row['income_account_number'] ? String(row['income_account_number']).trim() : '';
    if (acctRaw) {
      const uuid = uuidByNumber[acctRaw] ?? uuidByNumber[`name::${acctRaw.toLowerCase()}`];
      if (uuid) {
        body.account_uuid = uuid;
      } else {
        errors.push(`Row ${i + 1} (ID ${rawId}): income_account_number "${acctRaw}" not found in COA`);
      }
      console.log(`[ITEMS UPDATE] Row ${i+1} ID=${rawId} acct="${acctRaw}" → account_uuid=${uuid ?? 'NOT FOUND'}`);
    }

    if (Object.keys(body).length === 0) { updated++; continue; }

    try {
      const res = await updateItem(Number(rawId), body);
      const stored = res?.response?.result?.item?.account_uuid ?? res?.response?.result?.item?.income_account_id;
      console.log(`[ITEMS UPDATE] ID=${rawId} → stored account_uuid=${stored ?? 'null'}`);
      updated++;
    } catch (err: any) {
      failed++;
      const status = err?.response?.status;
      const detail = err?.response?.data;
      const fbErrors = detail?.response?.errors ?? detail?.errors;
      const fbMsg = Array.isArray(fbErrors)
        ? fbErrors.map((e: any) => e.message ?? e.errno ?? JSON.stringify(e)).join('; ')
        : null;
      const errMsg = fbMsg
        ? `HTTP ${status} — ${fbMsg}`
        : detail ? `HTTP ${status} — ${JSON.stringify(detail)}` : `HTTP ${status} — ${err.message}`;
      errors.push(`Row ${i + 1} (ID ${rawId}): ${errMsg}`);
    }
  }

  console.log(`[ITEMS UPDATE] Done — updated: ${updated}, failed: ${failed}`);
  return { updated, failed, errors };
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
  'items':             { getAll: getItems,           extractRecords: d => d.response?.result?.items || [],           deleteOne: deleteItem,          updateOne: updateItem,  exportFn: exportItemsExcel, bulkUpdateFn: bulkUpdateItems },
  'expenses':          { getAll: getExpenses,        extractRecords: d => d.response?.result?.expenses || [],        deleteOne: deleteExpense,       updateOne: updateExpense,  exportFn: exportExpensesExcel, bulkUpdateFn: bulkUpdateExpenses },
  'income':            { getAll: getIncome,          extractRecords: d => d.response?.result?.other_incomes || [],   deleteOne: deleteIncome,        updateOne: updateIncome },
  'invoices':          { getAll: getInvoices,        extractRecords: d => d.response?.result?.invoices || [],        deleteOne: deleteInvoice,       updateOne: updateInvoice, exportFn: exportInvoicesExcel, bulkUpdateFn: bulkUpdateInvoices },
  'bills':             { getAll: getBills,           extractRecords: d => d.response?.result?.bills || [],           deleteOne: deleteBill,          updateOne: updateBill },
  'credit-notes':      { getAll: getCreditNotes,     extractRecords: d => d.response?.result?.credit_notes || [],    deleteOne: deleteCreditNote,    updateOne: updateCreditNote },
  'invoice-payments':  { getAll: getPayments,        extractRecords: d => d.response?.result?.payments || [],        deleteOne: deletePayment,       updateOne: updatePayment,  exportFn: exportInvoicePaymentsExcel },
  'bill-payments':     { getAll: getBillPayments,    extractRecords: d => d.response?.result?.bill_payments || [],   deleteOne: deleteBillPayment,   updateOne: updateBillPayment },
  'journal-entries':   { getAll: getJournalEntries,  extractRecords: d => d.manualJournalEntries || [],              deleteOne: deleteJournalEntry,  updateOne: updateJournalEntry, stringId: true },
  'chart-of-accounts': {
    getAll: getChartOfAccounts,
    extractRecords: (d: any) => flattenCoaTree(d?.response?.result?.journal_entry_accounts || []),
    deleteOne: deleteChartOfAccount,
    updateOne: updateChartOfAccount,
  },
  'services': {
    getAll: getServices,
    extractRecords: (d: any) => d.response?.result?.services || [],
    exportFn: exportServicesExcel,
    bulkUpdateFn: bulkUpdateServices,
    deleteOne: async () => { throw Object.assign(new Error('Services cannot be deleted via this API'), { statusCode: 400 }); },
    updateOne: async (id: number, body: Record<string, any>) => {
      if (body.rate) await updateServiceRate(id, String(body.rate));
    },
  },
  'estimates': {
    getAll: getEstimates,
    extractRecords: (d: any) => d.response?.result?.estimates || [],
    exportFn: exportEstimatesExcel,
    deleteOne: async () => { throw Object.assign(new Error('Estimates cannot be deleted via this API'), { statusCode: 400 }); },
    updateOne: async () => { throw Object.assign(new Error('Estimates cannot be updated via this API'), { statusCode: 400 }); },
  },
  'recurring-invoices': {
    getAll: getRecurringInvoices,
    extractRecords: (d: any) => d.response?.result?.invoice_profiles || [],
    exportFn: exportRecurringInvoicesExcel,
    deleteOne: async () => { throw Object.assign(new Error('Recurring invoices cannot be deleted via this API'), { statusCode: 400 }); },
    updateOne: async () => { throw Object.assign(new Error('Recurring invoices cannot be updated via this API'), { statusCode: 400 }); },
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

export async function getAllEntityCounts(): Promise<Record<string, number | null>> {
  const token  = await getToken();
  const h      = authHeader(token.accessToken);
  const acctId = accountId();
  const bizId  = businessId();
  const bizUuid = businessUuid();

  const tasks: Array<{ id: string; url: string; extract: (d: any) => number | null }> = [
    { id: 'clients',          url: `${BASE}/accounting/account/${acctId}/users/clients?per_page=1`,                  extract: d => d?.response?.result?.total ?? null },
    { id: 'vendors',          url: `${BASE}/accounting/account/${acctId}/bill_vendors/bill_vendors?per_page=1`,      extract: d => d?.response?.result?.total ?? null },
    { id: 'items',            url: `${BASE}/accounting/account/${acctId}/items/items?per_page=1`,                    extract: d => d?.response?.result?.total ?? null },
    { id: 'expenses',         url: `${BASE}/accounting/account/${acctId}/expenses/expenses?per_page=1`,              extract: d => d?.response?.result?.total ?? null },
    { id: 'income',           url: `${BASE}/accounting/account/${acctId}/other_incomes/other_incomes?per_page=1`,   extract: d => d?.response?.result?.total ?? null },
    { id: 'invoices',         url: `${BASE}/accounting/account/${acctId}/invoices/invoices?per_page=1`,              extract: d => d?.response?.result?.total ?? null },
    { id: 'bills',            url: `${BASE}/accounting/account/${acctId}/bills/bills?per_page=1`,                   extract: d => d?.response?.result?.total ?? null },
    { id: 'credit-notes',     url: `${BASE}/accounting/account/${acctId}/credit_notes/credit_notes?per_page=1`,     extract: d => d?.response?.result?.total ?? null },
    { id: 'invoice-payments', url: `${BASE}/accounting/account/${acctId}/payments/payments?per_page=1`,             extract: d => d?.response?.result?.total ?? null },
    { id: 'bill-payments',    url: `${BASE}/accounting/account/${acctId}/bill_payments/bill_payments?per_page=1`,   extract: d => d?.response?.result?.total ?? null },
    { id: 'services',         url: `${BASE}/comments/business/${bizId}/services?per_page=1`,                        extract: d => d?.meta?.total ?? null },
    { id: 'journal-entries',    url: `${BASE}/accounting/businesses/${bizUuid}/journal_entries?page_size=1`,          extract: d => d?.page?.total ?? null },
    { id: 'chart-of-accounts',  url: `${BASE}/accounting/businesses/${bizUuid}/reports/chart_of_accounts?use_ledger_entries=true`, extract: d => d?.response?.result?.journal_entry_accounts?.length ?? null },
    { id: 'estimates',          url: `${BASE}/accounting/account/${acctId}/estimates/estimates?per_page=1`,           extract: d => d?.response?.result?.total ?? null },
    { id: 'recurring-invoices', url: `${BASE}/accounting/account/${acctId}/invoice_profiles/invoice_profiles?per_page=1`, extract: d => d?.response?.result?.total ?? null },
  ];

  const counts: Record<string, number | null> = {};
  await Promise.allSettled(tasks.map(async ({ id, url, extract }) => {
    try {
      const res = await fbAxios.get(url, { headers: h });
      counts[id] = extract(res.data);
    } catch {
      counts[id] = null;
    }
  }));
  return counts;
}

export async function exportAllExcel(): Promise<Buffer> {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  const ORDER = [
    'chart-of-accounts', 'clients', 'vendors', 'items', 'services',
    'expenses', 'income', 'invoices', 'recurring-invoices', 'bills', 'credit-notes',
    'invoice-payments', 'bill-payments', 'estimates', 'journal-entries',
  ];

  const wb = XLSX.utils.book_new();

  for (const entityId of ORDER) {
    const cfg = ENTITY_CFG[entityId];
    if (!cfg) continue;
    const sheetName = entityId.replace(/-/g, '_');
    try {
      // Entities with a custom exportFn (invoices, expenses, etc.) produce
      // better output (expanded rows, joined fields). Re-use that buffer.
      if (cfg.exportFn) {
        const buf    = await cfg.exportFn();
        const tmpWb  = XLSX.read(buf, { type: 'buffer' });
        const sheet  = tmpWb.Sheets[tmpWb.SheetNames[0]];
        XLSX.utils.book_append_sheet(wb, sheet, sheetName);
        continue;
      }

      const data    = await cfg.getAll();
      const records = cfg.extractRecords(data);

      if (records.length === 0) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', '(no records found)']]), sheetName);
        continue;
      }

      const flatRows = records.map((r: any) => flattenObject(r));
      const allKeys  = [...new Set(flatRows.flatMap((r: any) => Object.keys(r)))] as string[];
      const keys     = ['id', ...allKeys.filter(k => k !== 'id').sort()];
      const rows     = flatRows.map((r: any) => {
        const row: Record<string, any> = {};
        for (const k of keys) row[k] = r[k] ?? '';
        return row;
      });

      const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    } catch (err: any) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['error', err?.message || String(err)]]),
        sheetName,
      );
    }
  }

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

export async function getRecurringInvoices() {
  const token = await getToken();
  const allProfiles: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
      `${BASE}/accounting/account/${accountId()}/invoice_profiles/invoice_profiles?page=${page}&per_page=100`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allProfiles.push(...(result?.invoice_profiles || []));
    pages = result?.pages || 1;
    page++;
  } while (page <= pages);
  return { response: { result: { invoice_profiles: allProfiles, total: allProfiles.length } } };
}

async function exportEstimatesExcel(): Promise<Buffer> {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');

  const token = await getToken();
  const allEstimates: any[] = [];
  let page = 1, pages = 1;
  do {
    const res = await fbAxios.get(
      `${BASE}/accounting/account/${accountId()}/estimates/estimates?page=${page}&per_page=100&include[]=lines`,
      { headers: authHeader(token.accessToken) }
    );
    const result = res.data?.response?.result;
    allEstimates.push(...(result?.estimates || []));
    pages = result?.pages || 1;
    page++;
  } while (page <= pages);

  if (allEstimates.length === 0) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['estimate_number', '(no records found)']]), 'estimates');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // One row per line item — estimate header fields repeated on every row
  const rows: Record<string, any>[] = [];
  for (const est of allEstimates) {
    const lines: any[] = Array.isArray(est.lines) && est.lines.length > 0 ? est.lines : [{}];
    for (const line of lines) {
      rows.push({
        estimate_id:      est.estimateid ?? '',
        estimate_number:  est.estimatenum ?? '',
        client_id:        est.clientid ?? '',
        client_name:      est.current_organization || est.organization || `${est.fname || ''} ${est.lname || ''}`.trim() || '',
        client_email:     est.email ?? '',
        create_date:      est.create_date ?? '',
        expiry_date:      est.expiry_date ?? '',
        currency_code:    est.currency_code ?? '',
        language:         est.language ?? '',
        status:           est.status ?? '',
        notes:            est.notes ?? '',
        terms:            est.terms ?? '',
        po_number:        est.po_number ?? '',
        estimate_total:   est.amount?.amount ?? '',
        line_name:        line.name ?? '',
        line_description: line.description ?? '',
        line_qty:         line.qty ?? '',
        line_unit_cost:   line.unit_cost?.amount ?? '',
        line_subtotal:    line.amount?.amount ?? '',
        tax_name1:        line.taxName1 ?? '',
        tax_rate1:        line.taxAmount1 ?? '',
        tax_amount1:      line.amount?.amount && line.taxAmount1
                            ? (parseFloat(line.amount.amount) * parseFloat(line.taxAmount1) / 100).toFixed(2)
                            : '',
        tax_name2:        line.taxName2 ?? '',
        tax_rate2:        line.taxAmount2 ?? '',
        tax_amount2:      line.amount?.amount && line.taxAmount2
                            ? (parseFloat(line.amount.amount) * parseFloat(line.taxAmount2) / 100).toFixed(2)
                            : '',
      });
    }
  }

  const keys = Object.keys(rows[0]);
  const ws = XLSX.utils.json_to_sheet(rows, { header: keys });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'estimates');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function getEstimates() {
  const token = await getToken();
  const allEstimates: any[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await fbAxios.get(
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
    const res = await fbAxios.get(
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
    const res = await fbAxios.get(
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
    const res = await fbAxios.get(
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

