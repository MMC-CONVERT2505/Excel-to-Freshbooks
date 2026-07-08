import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const status = err.statusCode || err.response?.status || 500;
  const message = err.message || err.response?.data || 'Internal server error';
  res.status(status).json({ error: message });
}



