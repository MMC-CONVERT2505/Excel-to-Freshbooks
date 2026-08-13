import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  migrateClients,
  migrateItems,
  deleteAllItems,
  migrateVendors,
  migrateExpenses,
  migrateExpenseCategories,
  migrateInvoices,
  migrateSalesReceipts,
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
  buildIssueReport,
} from '../services/migration.service.js';
import { runWithToken, getSessionCompany } from '../services/freshbooks.service.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

const tid = (req: Request) => (req as any).sessionTokenId as number | null ?? null;

const JWT_SECRET = process.env.APP_JWT_SECRET || 'changeme-set-APP_JWT_SECRET-in-env';
function extractUser(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try { const p = jwt.verify(h.slice(7), JWT_SECRET) as any; return p.email || p.name || null; } catch { return null; }
}

async function withSession<T>(req: Request, fn: (tokenId: number | null) => Promise<T>): Promise<T> {
  const tokenId    = tid(req);
  const triggeredBy = extractUser(req);

  // Fail closed. Without a session there is no AsyncLocalStorage context, so every
  // getToken() inside would fall back to "most recently created active token" — i.e.
  // whichever company connected last, possibly another client's. That is how data
  // ends up pushed into the wrong FreshBooks account. Refuse instead of guessing.
  // 409, never 401: the frontend treats 401 as "app login expired" and force-logs-out.
  // A user who is correctly logged in but has not connected FreshBooks yet must be told
  // to connect, not thrown back to the login page.
  if (!tokenId) {
    const err = new Error(
      'No FreshBooks connection for this session. Connect on the Connect page before pushing.'
    );
    (err as any).statusCode = 409;
    throw err;
  }

  return runWithToken(tokenId, () => {
    // Record the destination once per actual push. Only for mutating requests — GET
    // /status is polled continuously by the frontend, and logging that flooded the
    // output with a [PUSH] line every second.
    if (req.method !== 'GET') {
      const co = getSessionCompany();
      console.log(`[PUSH] → company "${co?.label}" (account ${co?.accountId}, token ${tokenId}) by ${triggeredBy ?? 'unknown user'}`);
    }
    return fn(tokenId);
  }, triggeredBy);
}

export const runMigrateClients         = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateClients(t))); });
export const runMigrateItems           = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateItems(t))); });
export const runDeleteAllItems         = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, () => deleteAllItems())); });
export const runMigrateVendors         = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateVendors(t))); });
export const runMigrateExpenses        = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateExpenses(t))); });
export const runMigrateExpenseCategories = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateExpenseCategories(t))); });
export const runMigrateInvoices        = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateInvoices(t))); });
export const runMigrateSalesReceipts   = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateSalesReceipts(t))); });
export const runMigrateIncome          = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateIncome(t))); });
export const runMigrateCreditNotes     = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateCreditNotes(t))); });
export const runMigrateBills           = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateBills(t))); });
export const runMigrateBillPayments    = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateBillPayments(t))); });
export const runMigrateInvoicePayments = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateInvoicePayments(t))); });
export const runMigrateChartOfAccounts = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateChartOfAccounts(t))); });
export const runMigrateServices        = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateServices(t))); });
export const runMigrateJournalEntries  = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateJournalEntries(t))); });
export const runMigrateAll             = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => migrateAll(t))); });
export const runGetMigrationStatus     = wrap(async (req: Request, res: Response) => { res.json(await withSession(req, (t) => getMigrationStatus(t))); });
export const runCancelMigration        = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  res.json(await cancelMigration(entityId, tid(req)));
});

// Skipped + Errors workbook for the latest run of one entity, scoped to this company.
export const runDownloadIssueReport = wrap(async (req: Request, res: Response) => {
  const entityId = String(req.params.entity);
  const { buffer, skipped, failed } = await withSession(req, () => buildIssueReport(entityId));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${entityId}_issues.xlsx"`);
  // Let the frontend show counts without parsing the workbook.
  res.setHeader('X-Skipped-Count', String(skipped));
  res.setHeader('X-Failed-Count',  String(failed));
  res.setHeader('Access-Control-Expose-Headers', 'X-Skipped-Count, X-Failed-Count');
  res.send(buffer);
});
