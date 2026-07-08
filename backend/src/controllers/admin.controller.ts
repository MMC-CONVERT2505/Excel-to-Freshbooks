import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

// GET /admin/users
export const listUsers = wrap(async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  res.json({ users });
});

// POST /admin/users
export const createUser = wrap(async (req: Request, res: Response) => {
  const { email, name, password, role = 'user' } = req.body as {
    email?: string; name?: string; password?: string; role?: string;
  };

  if (!email || !name || !password) {
    return res.status(400).json({ error: 'email, name, and password are required.' });
  }
  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin" or "user".' });
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) return res.status(409).json({ error: 'A user with that email already exists.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email: email.toLowerCase().trim(), name: name.trim(), passwordHash, role },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  res.status(201).json({ user });
});

// DELETE /admin/users/:id
export const deleteUser = wrap(async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const self = (req as any).appUser;

  if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID.' });
  if (self?.userId === id) return res.status(400).json({ error: 'You cannot delete your own account.' });

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  await prisma.user.delete({ where: { id } });
  res.json({ ok: true });
});

// PUT /admin/users/:id — update name, role, or password
export const updateUser = wrap(async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID.' });

  const { name, role, password } = req.body as { name?: string; role?: string; password?: string };
  const data: any = {};
  if (name)     data.name = name.trim();
  if (role)     {
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "user".' });
    data.role = role;
  }
  if (password) data.passwordHash = await bcrypt.hash(password, 12);

  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update.' });

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  res.json({ user });
});

// GET /admin/activity — all migration runs across all companies with phase breakdown
export const getActivity = wrap(async (_req: Request, res: Response) => {
  const runs = await prisma.migrationRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      token: { select: { companyLabel: true, accountId: true } },
      phases: {
        select: {
          entity: true,
          status: true,
          totalRecords: true,
          successCount: true,
          failedCount: true,
          skippedCount: true,
          startedAt: true,
          completedAt: true,
          durationMs: true,
        },
        orderBy: { startedAt: 'asc' },
      },
    },
  });

  res.json({
    runs: runs.map(r => ({
      id:          r.id,
      status:      r.status,
      company:     r.token?.companyLabel || r.token?.accountId || 'Unknown',
      startedAt:   r.startedAt?.toISOString()   ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      phases: r.phases.map(p => ({
        entity:    p.entity,
        status:    p.status,
        total:     p.totalRecords,
        success:   p.successCount,
        failed:    p.failedCount,
        skipped:   p.skippedCount,
        startedAt: p.startedAt?.toISOString() ?? null,
        durationMs: p.durationMs ?? 0,
      })),
    })),
  });
});

// GET /admin/stats — quick summary numbers
export const getStats = wrap(async (_req: Request, res: Response) => {
  const [userCount, runCount, activeRuns, tokenCount] = await Promise.all([
    prisma.user.count(),
    prisma.migrationRun.count(),
    prisma.migrationRun.count({ where: { status: 'RUNNING' } }),
    prisma.freshbooksToken.count({ where: { isActive: true } }),
  ]);

  res.json({ userCount, runCount, activeRuns, connectedAccounts: tokenCount });
});
