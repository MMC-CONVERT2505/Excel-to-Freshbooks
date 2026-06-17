import { Request, Response, NextFunction } from 'express';
import { parseQBDCOA, parseQBDClients, parseQBDVendors, parseQBDItems, parseQBDServices, parseQBDInvoices, parseQBDExpenses, parseQBDIncome, parseQBDBills, parseQBDCreditNotes, parseQBDJournalEntries, parseQBDInvoicePayments, parseQBDBillPayments, parseQBDAll } from '../services/parser.service.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

export const runParseCOA = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDCOA();
  res.json({
    message: `Parsed ${result.output.length} accounts → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseClients = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDClients();
  res.json({
    message: `Parsed ${result.output.length} clients → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseVendors = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDVendors();
  res.json({
    message: `Parsed ${result.output.length} vendors → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseItems = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDItems();
  res.json({
    message: `Parsed ${result.output.length} items → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseInvoices = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDInvoices();
  res.json({
    message: `Parsed ${result.output.length} invoice lines → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseExpenses = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDExpenses();
  res.json({
    message: `Parsed ${result.output.length} expenses → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseServices = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDServices();
  res.json({
    message: `Parsed ${result.output.length} services → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseIncome = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDIncome();
  res.json({
    message: `Parsed ${result.output.length} income entries → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseBills = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDBills();
  res.json({
    message: `Parsed ${result.output.length} bill lines → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseCreditNotes = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDCreditNotes();
  res.json({
    message: `Parsed ${result.output.length} credit notes → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseJournalEntries = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDJournalEntries();
  res.json({
    message: `Parsed ${result.output.length} journal entry lines → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseInvoicePayments = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDInvoicePayments();
  res.json({
    message: `Parsed ${result.output.length} invoice payments → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseBillPayments = wrap(async (_req: Request, res: Response) => {
  const result = parseQBDBillPayments();
  res.json({
    message: `Parsed ${result.output.length} bill payments → saved to ${result.file}`,
    preview: result.output.slice(0, 5),
    total: result.output.length,
  });
});

export const runParseAll = wrap(async (_req: Request, res: Response) => {
  const results = parseQBDAll();
  const totalRecords = results.reduce((sum, r) => sum + r.total, 0);
  res.json({
    message: `Parsed all ${results.length} entities — ${totalRecords} total records written to Excel Templates`,
    summary: results,
  });
});

