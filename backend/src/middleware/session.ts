import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';

export async function resolveSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.headers['x-session-id'] as string | undefined;
  if (sessionId) {
    try {
      const session = await prisma.userSession.findUnique({
        where:  { id: sessionId },
        select: { tokenId: true, expiresAt: true },
      });
      if (session && session.expiresAt > new Date()) {
        (req as any).sessionTokenId = session.tokenId;
        (req as any).sessionId      = sessionId;
      }
    } catch { /* never block a request over a session lookup failure */ }
  }
  next();
}
