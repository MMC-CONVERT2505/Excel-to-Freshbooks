import { Router } from 'express';
import { runParseCOA, runParseClients, runParseVendors, runParseItems, runParseServices, runParseInvoices, runParseExpenses, runParseIncome, runParseBills, runParseCreditNotes, runParseJournalEntries, runParseInvoicePayments, runParseBillPayments, runParseAll, uploadQBDFile, downloadTemplate, listStoredFiles } from '../controllers/parser.controller.js';

const router = Router();

// File storage
router.post('/upload/:filename',    uploadQBDFile);
router.get('/template/:filename',   downloadTemplate);
router.get('/files',                listStoredFiles);

// Parse triggers
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
