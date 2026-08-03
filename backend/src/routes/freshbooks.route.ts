import { Router } from 'express';
import {
  getIdentity,
  listChartOfAccounts, addChartOfAccount,
  listClients, addClient,
  listVendors, addVendor,
  listItems, addItem,
  listServices, addService,
  listExpenseCategories, listExpenses, addExpense, downloadExpensesExcel,
  listIncome, addIncome,
  listInvoices, addInvoice,
  listBills, addBills,
  listCreditNotes, addCreditNote,
  addPayment,
  addBillPayment,
  listJournalEntries, addJournalEntry,
  listEstimates,
  listEstimateLines,
  listCreditMemos,
  listProjects,
  runDeleteById, runBulkDelete,
  runUpdateById, runBulkUpdate,
  exportEntity, exportAll, getEntityCounts,
} from '../controllers/freshbooks.controller.js';

const router = Router();

router.get('/me', getIdentity);
router.get('/chart-of-accounts', listChartOfAccounts);
router.post('/chart-of-accounts', addChartOfAccount);
router.get('/clients', listClients);
router.post('/clients', addClient);
router.get('/vendors', listVendors);
router.post('/vendors', addVendor);
router.get('/items', listItems);
router.post('/items', addItem);
router.get('/services', listServices);
router.post('/services', addService);
router.get('/expense-categories', listExpenseCategories);
router.get('/expenses', listExpenses);
router.get('/expenses/export', downloadExpensesExcel);
router.post('/expenses', addExpense);
router.get('/income', listIncome);
router.post('/income', addIncome);
router.get('/invoices', listInvoices);
router.post('/invoices', addInvoice);
router.get('/bills', listBills);
router.post('/bills', addBills);
router.get('/credit-notes', listCreditNotes);
router.post('/credit-notes', addCreditNote);
router.post('/payments', addPayment);
router.post('/bill-payments', addBillPayment);
router.get('/journal-entries', listJournalEntries);
router.post('/journal-entries', addJournalEntry);
router.get('/estimates', listEstimates);
router.get('/estimates/lines', listEstimateLines);
router.get('/credit-memos', listCreditMemos);
router.get('/projects', listProjects);

// Entity-level export / delete / update
router.get('/counts',     getEntityCounts);
router.get('/export-all', exportAll);
router.get('/export/:entity', exportEntity);
router.delete('/record/:entity/:id', runDeleteById);
router.post('/record/bulk-delete/:entity', runBulkDelete);
router.put('/record/:entity/:id', runUpdateById);
router.post('/record/bulk-update/:entity', runBulkUpdate);

export default router;