import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

// Every query below is scoped by this. A file belongs to exactly one user and is never
// reachable from another account, even with a guessed id.
function userId(req: Request): number {
  const id = (req as any).appUser?.userId;
  if (!id) {
    const err = new Error('Authentication required.');
    (err as any).statusCode = 401;
    throw err;
  }
  return Number(id);
}

function shape(file: any) {
  return {
    id:        file.id,
    name:      file.name,
    createdAt: file.createdAt,
    connected: Boolean(file.tokenId && file.token),
    company:   file.token?.companyLabel ?? null,
    accountId: file.token?.accountId ?? null,
    tokenId:   file.tokenId ?? null,
    runCount:  file._count?.runs ?? undefined,
  };
}

// GET /files — the dashboard list
export const listFiles = wrap(async (req: Request, res: Response) => {
  const files = await prisma.migrationFile.findMany({
    where:   { userId: userId(req) },
    orderBy: { createdAt: 'desc' },
    include: {
      token:  { select: { companyLabel: true, accountId: true, isActive: true } },
      _count: { select: { runs: true } },
    },
  });
  res.json({ files: files.map(shape) });
});

// POST /files — create by name; connected to a company later
export const createFile = wrap(async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'A file name is required.' });
    return;
  }

  const existing = await prisma.migrationFile.findFirst({
    where: { userId: userId(req), name },
  });
  if (existing) {
    res.status(409).json({ error: `You already have a file named "${name}".` });
    return;
  }

  const file = await prisma.migrationFile.create({
    data: { userId: userId(req), name },
    include: { token: { select: { companyLabel: true, accountId: true, isActive: true } } },
  });
  res.status(201).json(shape(file));
});

// GET /files/:id
export const getFile = wrap(async (req: Request, res: Response) => {
  const file = await prisma.migrationFile.findFirst({
    where:   { id: Number(req.params.id), userId: userId(req) },
    include: {
      token:  { select: { companyLabel: true, accountId: true, isActive: true } },
      _count: { select: { runs: true } },
    },
  });
  if (!file) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  res.json(shape(file));
});

// PUT /files/:id/connect — bind this file to the FreshBooks company the session
// is currently connected to. Connect FreshBooks first, then call this.
export const connectFile = wrap(async (req: Request, res: Response) => {
  const tokenId = (req as any).sessionTokenId as number | undefined;
  if (!tokenId) {
    // 409, never 401 — the frontend force-logs-out on 401, and "FreshBooks not
    // connected" is a different condition from "app login expired".
    res.status(409).json({ error: 'Connect FreshBooks first, then link it to this file.' });
    return;
  }

  const file = await prisma.migrationFile.findFirst({
    where: { id: Number(req.params.id), userId: userId(req) },
  });
  if (!file) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  const token = await prisma.freshbooksToken.findUnique({
    where:  { id: tokenId },
    select: { id: true, accountId: true, companyLabel: true },
  });
  if (!token?.accountId) {
    res.status(409).json({ error: 'This FreshBooks connection has no business selected yet.' });
    return;
  }

  // Guard against silently repointing a file that already holds history to a
  // different company — that would mix two companies' runs under one name.
  if (file.tokenId && file.tokenId !== tokenId) {
    const prev = await prisma.freshbooksToken.findUnique({
      where:  { id: file.tokenId },
      select: { accountId: true, companyLabel: true },
    });
    const runCount = await prisma.migrationRun.count({ where: { fileId: file.id } });
    if (prev && prev.accountId !== token.accountId && runCount > 0) {
      res.status(409).json({
        error:
          `"${file.name}" already has ${runCount} migration(s) under ${prev.companyLabel ?? 'another company'}. ` +
          `Connecting it to ${token.companyLabel ?? 'a different company'} would mix two companies' history ` +
          `under one file. Create a new file for that company instead.`,
      });
      return;
    }
  }

  const updated = await prisma.migrationFile.update({
    where:   { id: file.id },
    data:    { tokenId },
    include: { token: { select: { companyLabel: true, accountId: true, isActive: true } } },
  });
  res.json(shape(updated));
});

// GET /files/:id/history — every run made under this file, newest first
export const getFileHistory = wrap(async (req: Request, res: Response) => {
  const file = await prisma.migrationFile.findFirst({
    where: { id: Number(req.params.id), userId: userId(req) },
  });
  if (!file) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  const runs = await prisma.migrationRun.findMany({
    where:   { fileId: file.id },
    orderBy: { createdAt: 'desc' },
    take:    100,
    include: {
      token:  { select: { companyLabel: true, accountId: true } },
      phases: {
        orderBy: { id: 'asc' },
        select: {
          entity: true, status: true, totalRecords: true,
          successCount: true, failedCount: true, skippedCount: true,
          durationMs: true, startedAt: true, completedAt: true,
        },
      },
    },
  });

  res.json({
    file: { id: file.id, name: file.name },
    runs: runs.map(r => ({
      id:          r.id,
      status:      r.status,
      startedAt:   r.startedAt ?? r.createdAt,
      completedAt: r.completedAt,
      triggeredBy: r.triggeredBy,
      company:     r.token?.companyLabel ?? null,
      phases:      r.phases,
      totals: r.phases.reduce(
        (acc, p) => ({
          total:   acc.total   + p.totalRecords,
          success: acc.success + p.successCount,
          failed:  acc.failed  + p.failedCount,
          skipped: acc.skipped + p.skippedCount,
        }),
        { total: 0, success: 0, failed: 0, skipped: 0 },
      ),
    })),
  });
});

// DELETE /files/:id — removes the file only. Runs survive with fileId set to NULL
// (schema uses SetNull), so migration history is never destroyed by this.
export const deleteFile = wrap(async (req: Request, res: Response) => {
  const file = await prisma.migrationFile.findFirst({
    where: { id: Number(req.params.id), userId: userId(req) },
  });
  if (!file) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  const runCount = await prisma.migrationRun.count({ where: { fileId: file.id } });
  await prisma.migrationFile.delete({ where: { id: file.id } });

  res.json({
    message: `Deleted "${file.name}".`,
    // Say plainly what was and wasn't touched: nothing in FreshBooks is undone,
    // and the run history is detached rather than deleted.
    note: runCount > 0
      ? `${runCount} migration run(s) were kept and detached from this file. Nothing was removed from FreshBooks.`
      : 'Nothing was removed from FreshBooks.',
  });
});
