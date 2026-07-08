import { Router } from 'express';
import { requireAppAuth } from '../middleware/requireAppAuth.js';
import {
  runMigrateClients,
  runMigrateItems,
  runMigrateVendors,
  runMigrateExpenses,
  runMigrateExpenseCategories,
  runMigrateInvoices,
  runMigrateSalesReceipts,
  runMigrateIncome,
  runMigrateCreditNotes,
  runMigrateBills,
  runMigrateBillPayments,
  runMigrateInvoicePayments,
  runMigrateChartOfAccounts,
  runMigrateServices,
  runMigrateJournalEntries,
  runMigrateAll,
  runDeleteAllItems,
  runGetMigrationStatus,
  runCancelMigration,
} from '../controllers/migration.controller.js';

const router = Router();
router.use(requireAppAuth);

router.get('/status',            runGetMigrationStatus);
router.post('/cancel/:entity',   runCancelMigration);
router.post('/clients',          runMigrateClients);
router.post('/items',            runMigrateItems);
router.delete('/items',          runDeleteAllItems);
router.post('/vendors',          runMigrateVendors);
router.post('/expenses',            runMigrateExpenses);
router.post('/expense-categories', runMigrateExpenseCategories);
router.post('/invoices',         runMigrateInvoices);
router.post('/sales-receipts',   runMigrateSalesReceipts);
router.post('/income',           runMigrateIncome);
router.post('/credit-notes',     runMigrateCreditNotes);
router.post('/bills',            runMigrateBills);
router.post('/bill-payments',    runMigrateBillPayments);
router.post('/invoice-payments', runMigrateInvoicePayments);
router.post('/chart-of-accounts', runMigrateChartOfAccounts);
router.post('/services',         runMigrateServices);
router.post('/journal-entries',  runMigrateJournalEntries);
router.post('/all',              runMigrateAll);

export default router;
