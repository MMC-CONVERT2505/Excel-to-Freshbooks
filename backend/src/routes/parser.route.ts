import { Router } from 'express';
import { runParseCOA, runParseClients, runParseVendors, runParseItems, runParseServices, runParseInvoices, runParseExpenses, runParseIncome, runParseBills, runParseCreditNotes, runParseJournalEntries, runParseInvoicePayments, runParseBillPayments, runParseAll } from '../controllers/parser.controller.js';

const router = Router();

router.post('/all',              runParseAll);
router.post('/coa',              runParseCOA);
router.post('/clients',          runParseClients);
router.post('/vendors',          runParseVendors);
router.post('/items',            runParseItems);
router.post('/services',         runParseServices);
router.post('/invoices',         runParseInvoices);
router.post('/expenses',         runParseExpenses);
router.post('/income',           runParseIncome);
router.post('/bills',            runParseBills);
router.post('/credit-notes',     runParseCreditNotes);
router.post('/journal-entries',  runParseJournalEntries);
router.post('/invoice-payments', runParseInvoicePayments);
router.post('/bill-payments',    runParseBillPayments);

export default router;
