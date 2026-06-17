import { Request, Response, NextFunction } from 'express';
import {
  getFreshBooksIdentity,
  getChartOfAccounts, createChartOfAccount,
  getClients, createClient,
  getInvoices, createInvoice,
  getItems, createItem,
  getExpenseCategories, getExpenses, createExpense, exportExpensesExcel,
  createPayment,
  getVendors, createVendor,
  getBills, createBills,
  getServices, createService,
  getIncome, createIncome,
  getCreditNotes, createCreditNote,
  createBillPayment,
  getJournalEntries, createJournalEntry,
  getEstimates,
  getEstimateLines,
  getCreditMemos,
  getProjects,
  deleteEntityById, bulkDeleteEntity,
  updateEntityById, bulkUpdateEntity,
  exportEntityExcel,
} from '../services/freshbooks.service.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

export const getIdentity = wrap(async (_req: Request, res: Response) => {
  res.json(await getFreshBooksIdentity());
});

export const listChartOfAccounts = wrap(async (_req: Request, res: Response) => {
  res.json(await getChartOfAccounts());
});
export const addChartOfAccount = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createChartOfAccount(req.body));
});

export const listClients = wrap(async (_req: Request, res: Response) => {
  res.json(await getClients());
});
export const addClient = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createClient(req.body));
});

export const listVendors = wrap(async (_req: Request, res: Response) => {
  res.json(await getVendors());
});
export const addVendor = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createVendor(req.body));
});

export const listItems = wrap(async (_req: Request, res: Response) => {
  res.json(await getItems());
});
export const addItem = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createItem(req.body));
});

export const listServices = wrap(async (_req: Request, res: Response) => {
  res.json(await getServices());
});
export const addService = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createService(req.body));
});

export const listExpenseCategories = wrap(async (_req: Request, res: Response) => {
  res.json(await getExpenseCategories());
});
export const listExpenses = wrap(async (_req: Request, res: Response) => {
  res.json(await getExpenses());
});
export const addExpense = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createExpense(req.body));
});
export const downloadExpensesExcel = wrap(async (_req: Request, res: Response) => {
  const buffer = await exportExpensesExcel();
  res.setHeader('Content-Disposition', 'attachment; filename="freshbooks_expenses.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

export const listIncome = wrap(async (_req: Request, res: Response) => {
  res.json(await getIncome());
});
export const addIncome = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createIncome(req.body));
});

export const listInvoices = wrap(async (_req: Request, res: Response) => {
  res.json(await getInvoices());
});
export const addInvoice = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createInvoice(req.body));
});

export const listBills = wrap(async (_req: Request, res: Response) => {
  res.json(await getBills());
});
export const addBills = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createBills(req.body));
});

export const listCreditNotes = wrap(async (_req: Request, res: Response) => {
  res.json(await getCreditNotes());
});
export const addCreditNote = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createCreditNote(req.body));
});

export const addPayment = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createPayment(req.body));
});

export const addBillPayment = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createBillPayment(req.body));
});

export const listJournalEntries = wrap(async (_req: Request, res: Response) => {
  res.json(await getJournalEntries());
});
export const addJournalEntry = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await createJournalEntry(req.body));
});

export const listEstimates = wrap(async (_req: Request, res: Response) => {
  res.json(await getEstimates());
});

export const listEstimateLines = wrap(async (_req: Request, res: Response) => {
  res.json(await getEstimateLines());
});

export const listCreditMemos = wrap(async (_req: Request, res: Response) => {
  res.json(await getCreditMemos());
});

export const listProjects = wrap(async (_req: Request, res: Response) => {
  res.json(await getProjects());
});

export const runDeleteById = wrap(async (req: Request, res: Response) => {
  res.json(await deleteEntityById(String(req.params.entity), String(req.params.id)));
});

export const runBulkDelete = wrap(async (req: Request, res: Response) => {
  res.json(await bulkDeleteEntity(String(req.params.entity)));
});

export const runUpdateById = wrap(async (req: Request, res: Response) => {
  res.json(await updateEntityById(String(req.params.entity), String(req.params.id), req.body));
});

export const runBulkUpdate = wrap(async (req: Request, res: Response) => {
  res.json(await bulkUpdateEntity(String(req.params.entity)));
});

export const exportEntity = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  const buffer = await exportEntityExcel(entityId);
  res.setHeader('Content-Disposition', `attachment; filename="freshbooks_${entityId}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});
