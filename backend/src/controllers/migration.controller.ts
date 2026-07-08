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
import { loadBusinessConfigForToken } from '../services/freshbooks.service.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

const tid = (req: Request) => (req as any).sessionTokenId as number | null ?? null;

// Ensure the global FreshBooks config is scoped to the requesting session's token
// before running any migration — prevents one user's account overwriting another's.
async function scopeToSession(req: Request): Promise<number | null> {
  const tokenId = tid(req);
  if (tokenId) await loadBusinessConfigForToken(tokenId);
  return tokenId;
}

export const runMigrateClients         = wrap(async (req: Request, res: Response) => { res.json(await migrateClients(await scopeToSession(req))); });
export const runMigrateItems           = wrap(async (req: Request, res: Response) => { res.json(await migrateItems(await scopeToSession(req))); });
export const runDeleteAllItems         = wrap(async (_req: Request, res: Response) => { res.json(await deleteAllItems()); });
export const runMigrateVendors         = wrap(async (req: Request, res: Response) => { res.json(await migrateVendors(await scopeToSession(req))); });
export const runMigrateExpenses        = wrap(async (req: Request, res: Response) => { res.json(await migrateExpenses(await scopeToSession(req))); });
export const runMigrateExpenseCategories = wrap(async (req: Request, res: Response) => { res.json(await migrateExpenseCategories(await scopeToSession(req))); });
export const runMigrateInvoices        = wrap(async (req: Request, res: Response) => { res.json(await migrateInvoices(await scopeToSession(req))); });
export const runMigrateIncome          = wrap(async (req: Request, res: Response) => { res.json(await migrateIncome(await scopeToSession(req))); });
export const runMigrateCreditNotes     = wrap(async (req: Request, res: Response) => { res.json(await migrateCreditNotes(await scopeToSession(req))); });
export const runMigrateBills           = wrap(async (req: Request, res: Response) => { res.json(await migrateBills(await scopeToSession(req))); });
export const runMigrateBillPayments    = wrap(async (req: Request, res: Response) => { res.json(await migrateBillPayments(await scopeToSession(req))); });
export const runMigrateInvoicePayments = wrap(async (req: Request, res: Response) => { res.json(await migrateInvoicePayments(await scopeToSession(req))); });
export const runMigrateChartOfAccounts = wrap(async (req: Request, res: Response) => { res.json(await migrateChartOfAccounts(await scopeToSession(req))); });
export const runMigrateServices        = wrap(async (req: Request, res: Response) => { res.json(await migrateServices(await scopeToSession(req))); });
export const runMigrateJournalEntries  = wrap(async (req: Request, res: Response) => { res.json(await migrateJournalEntries(await scopeToSession(req))); });
export const runMigrateAll             = wrap(async (req: Request, res: Response) => { res.json(await migrateAll(await scopeToSession(req))); });
export const runGetMigrationStatus     = wrap(async (req: Request, res: Response) => { res.json(await getMigrationStatus(await scopeToSession(req))); });
export const runCancelMigration        = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  res.json(await cancelMigration(entityId));
});
