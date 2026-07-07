import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
const JWT_SECRET = process.env.APP_JWT_SECRET || 'changeme-set-APP_JWT_SECRET-in-env';
const JWT_EXPIRY = '7d';

const wrap = (fn: Function) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

export const appLogin = wrap(async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY },
  );

  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export const appMe = wrap(async (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
    res.json({ user: { id: payload.userId, email: payload.email, name: payload.name, role: payload.role } });
  } catch {
    res.status(401).json({ error: 'Token expired or invalid.' });
  }
});

export const appLogout = wrap(async (_req: Request, res: Response) => {
  res.json({ ok: true });
});
