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

export const runMigrateClients       = wrap(async (_req: Request, res: Response) => { res.json(await migrateClients()); });
export const runMigrateItems         = wrap(async (_req: Request, res: Response) => { res.json(await migrateItems()); });
export const runDeleteAllItems       = wrap(async (_req: Request, res: Response) => { res.json(await deleteAllItems()); });
export const runMigrateVendors       = wrap(async (_req: Request, res: Response) => { res.json(await migrateVendors()); });
export const runMigrateExpenses          = wrap(async (_req: Request, res: Response) => { res.json(await migrateExpenses()); });
export const runMigrateExpenseCategories = wrap(async (_req: Request, res: Response) => { res.json(await migrateExpenseCategories()); });
export const runMigrateInvoices      = wrap(async (_req: Request, res: Response) => { res.json(await migrateInvoices()); });
export const runMigrateIncome        = wrap(async (_req: Request, res: Response) => { res.json(await migrateIncome()); });
export const runMigrateCreditNotes   = wrap(async (_req: Request, res: Response) => { res.json(await migrateCreditNotes()); });
export const runMigrateBills         = wrap(async (_req: Request, res: Response) => { res.json(await migrateBills()); });
export const runMigrateBillPayments  = wrap(async (_req: Request, res: Response) => { res.json(await migrateBillPayments()); });
export const runMigrateInvoicePayments = wrap(async (_req: Request, res: Response) => { res.json(await migrateInvoicePayments()); });
export const runMigrateChartOfAccounts = wrap(async (_req: Request, res: Response) => { res.json(await migrateChartOfAccounts()); });
export const runMigrateServices      = wrap(async (_req: Request, res: Response) => { res.json(await migrateServices()); });
export const runMigrateJournalEntries = wrap(async (_req: Request, res: Response) => { res.json(await migrateJournalEntries()); });
export const runMigrateAll           = wrap(async (_req: Request, res: Response) => { res.json(await migrateAll()); });
export const runGetMigrationStatus   = wrap(async (_req: Request, res: Response) => { res.json(await getMigrationStatus()); });
export const runCancelMigration      = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  res.json(await cancelMigration(entityId));
});
