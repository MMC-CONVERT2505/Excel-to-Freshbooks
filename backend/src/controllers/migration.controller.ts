import { Request, Response, NextFunction } from 'express';
import {
  migrateClients,
  migrateItems,
  deleteAllItems,
  migrateVendors,
  migrateExpenses,
  migrateExpenseCategories,
  migrateInvoices,
  migrateIncome,
  migrateCreditNotes,
  migrateBills,
  migrateBillPayments,
  migrateInvoicePayments,
  migrateChartOfAccounts,
  migrateServices,
  migrateJournalEntries,
  migrateAll,
  getMigrationStatus,
  cancelMigration,
} from '../services/migration.service.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

const tid = (req: Request) => (req as any).sessionTokenId as number | null ?? null;

export const runMigrateClients         = wrap(async (req: Request, res: Response) => { res.json(await migrateClients(tid(req))); });
export const runMigrateItems           = wrap(async (req: Request, res: Response) => { res.json(await migrateItems(tid(req))); });
export const runDeleteAllItems         = wrap(async (_req: Request, res: Response) => { res.json(await deleteAllItems()); });
export const runMigrateVendors         = wrap(async (req: Request, res: Response) => { res.json(await migrateVendors(tid(req))); });
export const runMigrateExpenses        = wrap(async (req: Request, res: Response) => { res.json(await migrateExpenses(tid(req))); });
export const runMigrateExpenseCategories = wrap(async (req: Request, res: Response) => { res.json(await migrateExpenseCategories(tid(req))); });
export const runMigrateInvoices        = wrap(async (req: Request, res: Response) => { res.json(await migrateInvoices(tid(req))); });
export const runMigrateIncome          = wrap(async (req: Request, res: Response) => { res.json(await migrateIncome(tid(req))); });
export const runMigrateCreditNotes     = wrap(async (req: Request, res: Response) => { res.json(await migrateCreditNotes(tid(req))); });
export const runMigrateBills           = wrap(async (req: Request, res: Response) => { res.json(await migrateBills(tid(req))); });
export const runMigrateBillPayments    = wrap(async (req: Request, res: Response) => { res.json(await migrateBillPayments(tid(req))); });
export const runMigrateInvoicePayments = wrap(async (req: Request, res: Response) => { res.json(await migrateInvoicePayments(tid(req))); });
export const runMigrateChartOfAccounts = wrap(async (req: Request, res: Response) => { res.json(await migrateChartOfAccounts(tid(req))); });
export const runMigrateServices        = wrap(async (req: Request, res: Response) => { res.json(await migrateServices(tid(req))); });
export const runMigrateJournalEntries  = wrap(async (req: Request, res: Response) => { res.json(await migrateJournalEntries(tid(req))); });
export const runMigrateAll             = wrap(async (req: Request, res: Response) => { res.json(await migrateAll(tid(req))); });
export const runGetMigrationStatus     = wrap(async (_req: Request, res: Response) => { res.json(await getMigrationStatus()); });
export const runCancelMigration        = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  res.json(await cancelMigration(entityId));
});
