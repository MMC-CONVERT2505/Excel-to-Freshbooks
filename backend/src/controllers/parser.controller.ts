import { Request, Response, NextFunction } from 'express';
import { parseQBDCOA, parseQBDClients, parseQBDVendors, parseQBDItems, parseQBDServices, parseQBDInvoices, parseQBDExpenses, parseQBDIncome, parseQBDBills, parseQBDCreditNotes, parseQBDJournalEntries, parseQBDInvoicePayments, parseQBDBillPayments, parseQBDAll } from '../services/parser.service.js';
import prisma from '../lib/prisma.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

export const runParseCOA = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDCOA();
  res.json({ message: `Parsed ${result.output.length} accounts → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseClients = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDClients();
  res.json({ message: `Parsed ${result.output.length} clients → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseVendors = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDVendors();
  res.json({ message: `Parsed ${result.output.length} vendors → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseItems = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDItems();
  res.json({ message: `Parsed ${result.output.length} items → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseInvoices = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDInvoices();
  res.json({ message: `Parsed ${result.output.length} invoice lines → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseExpenses = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDExpenses();
  res.json({ message: `Parsed ${result.output.length} expenses → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseServices = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDServices();
  res.json({ message: `Parsed ${result.output.length} services → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseIncome = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDIncome();
  res.json({ message: `Parsed ${result.output.length} income entries → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseBills = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDBills();
  res.json({ message: `Parsed ${result.output.length} bill lines → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseCreditNotes = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDCreditNotes();
  res.json({ message: `Parsed ${result.output.length} credit notes → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseJournalEntries = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDJournalEntries();
  res.json({ message: `Parsed ${result.output.length} journal entry lines → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseInvoicePayments = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDInvoicePayments();
  res.json({ message: `Parsed ${result.output.length} invoice payments → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseBillPayments = wrap(async (_req: Request, res: Response) => {
  const result = await parseQBDBillPayments();
  res.json({ message: `Parsed ${result.output.length} bill payments → saved to ${result.file}`, preview: result.output.slice(0, 5), total: result.output.length });
});

export const runParseAll = wrap(async (_req: Request, res: Response) => {
  const results = await parseQBDAll();
  const totalRecords = results.reduce((sum, r) => sum + r.total, 0);
  res.json({ message: `Parsed all ${results.length} entities — ${totalRecords} total records saved to database`, summary: results });
});

// POST /parse/upload/:filename  — store a QBD export file (base64) in the database
export const uploadQBDFile = wrap(async (req: Request, res: Response) => {
  const filename = String(req.params['filename']);
  const { contentBase64 } = req.body as { contentBase64: string };
  if (!contentBase64) {
    res.status(400).json({ error: 'contentBase64 is required' });
    return;
  }
  const raw = Buffer.from(contentBase64, 'base64');
  const content = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) as Uint8Array<ArrayBuffer>;
  const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  await prisma.storedFile.upsert({
    where:  { filename_fileType: { filename, fileType: 'QBD_EXPORT' } },
    create: { filename, content, fileType: 'QBD_EXPORT', expiresAt },
    update: { content, expiresAt },
  });
  res.json({ message: `File "${filename}" stored successfully`, expiresAt });
});

// GET /parse/template/:filename  — download a parsed Excel template from the database
export const downloadTemplate = wrap(async (req: Request, res: Response) => {
  const filename = String(req.params['filename']);
  const record = await prisma.storedFile.findUnique({
    where: { filename_fileType: { filename, fileType: 'EXCEL_TEMPLATE' } },
  });
  if (!record) {
    res.status(404).json({ error: `Template "${filename}" not found — run the parser first.` });
    return;
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(record.content));
});

// GET /parse/files  — list all stored QBD export and template files
export const listStoredFiles = wrap(async (_req: Request, res: Response) => {
  const files = await prisma.storedFile.findMany({
    select: { id: true, filename: true, fileType: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ files });
});
