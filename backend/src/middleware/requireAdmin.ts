import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.APP_JWT_SECRET || 'changeme-set-APP_JWT_SECRET-in-env';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // EventSource (SSE) cannot set headers — allow token via ?token= query param as fallback
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  if (!raw) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  try {
    const payload = jwt.verify(raw, JWT_SECRET) as any;
    if (payload.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required.' });
      return;
    }
    (req as any).appUser = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid.' });
  }
}
