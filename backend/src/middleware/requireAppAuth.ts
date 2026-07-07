import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.APP_JWT_SECRET || 'changeme-set-APP_JWT_SECRET-in-env';

export function requireAppAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
    (req as any).appUser = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid. Please log in again.' });
  }
}
