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
  exportEntityExcel, exportAllExcel,
  getAllEntityCounts,
  runWithToken,
} from '../services/freshbooks.service.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

const tid = (req: Request) => (req as any).sessionTokenId as number | null ?? null;

// Every FreshBooks API call runs inside runWithToken() so it uses the requesting
// session's account — not the shared isCurrent global which could belong to anyone.
async function ws<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const tokenId = tid(req);
  return tokenId ? runWithToken(tokenId, fn) : fn();
}

export const getIdentity = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getFreshBooksIdentity()));
});

export const listChartOfAccounts = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getChartOfAccounts()));
});
export const addChartOfAccount = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createChartOfAccount(req.body)));
});

export const listClients = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getClients()));
});
export const addClient = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createClient(req.body)));
});

export const listVendors = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getVendors()));
});
export const addVendor = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createVendor(req.body)));
});

export const listItems = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getItems()));
});
export const addItem = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createItem(req.body)));
});

export const listServices = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getServices()));
});
export const addService = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createService(req.body)));
});

export const listExpenseCategories = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getExpenseCategories()));
});
export const listExpenses = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getExpenses()));
});
export const addExpense = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createExpense(req.body)));
});
export const downloadExpensesExcel = wrap(async (req: Request, res: Response) => {
  const buffer = await ws(req, () => exportExpensesExcel());
  res.setHeader('Content-Disposition', 'attachment; filename="freshbooks_expenses.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

export const listIncome = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getIncome()));
});
export const addIncome = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createIncome(req.body)));
});

export const listInvoices = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getInvoices()));
});
export const addInvoice = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createInvoice(req.body)));
});

export const listBills = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getBills()));
});
export const addBills = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createBills(req.body)));
});

export const listCreditNotes = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getCreditNotes()));
});
export const addCreditNote = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createCreditNote(req.body)));
});

export const addPayment = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createPayment(req.body)));
});

export const addBillPayment = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createBillPayment(req.body)));
});

export const listJournalEntries = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getJournalEntries()));
});
export const addJournalEntry = wrap(async (req: Request, res: Response) => {
  res.status(201).json(await ws(req, () => createJournalEntry(req.body)));
});

export const listEstimates = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getEstimates()));
});

export const listEstimateLines = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getEstimateLines()));
});

export const listCreditMemos = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getCreditMemos()));
});

export const listProjects = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getProjects()));
});

export const runDeleteById = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => deleteEntityById(String(req.params.entity), String(req.params.id))));
});

export const runBulkDelete = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => bulkDeleteEntity(String(req.params.entity))));
});

export const runUpdateById = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => updateEntityById(String(req.params.entity), String(req.params.id), req.body)));
});

export const runBulkUpdate = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => bulkUpdateEntity(String(req.params.entity))));
});

export const exportEntity = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  const buffer = await ws(req, () => exportEntityExcel(entityId));
  res.setHeader('Content-Disposition', `attachment; filename="freshbooks_${entityId}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

export const getEntityCounts = wrap(async (req: Request, res: Response) => {
  res.json(await ws(req, () => getAllEntityCounts()));
});

export const exportAll = wrap(async (req: Request, res: Response) => {
  const buffer = await ws(req, () => exportAllExcel());
  res.setHeader('Content-Disposition', 'attachment; filename="freshbooks_all.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});
