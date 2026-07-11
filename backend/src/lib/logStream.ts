import type { Response } from 'express';

export type LogEntry = { ts: string; level: 'info' | 'warn' | 'error'; msg: string };

const BUFFER_SIZE = 500;
const buffer: LogEntry[] = [];
const clients = new Set<Response>();

function broadcast(entry: LogEntry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

function hook(level: LogEntry['level'], original: (...args: any[]) => void) {
  return (...args: any[]) => {
    original.apply(console, args);
    const msg = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    broadcast({ ts: new Date().toISOString(), level, msg });
  };
}

// Patch before anything else loads
console.log   = hook('info',  console.log.bind(console));
console.warn  = hook('warn',  console.warn.bind(console));
console.error = hook('error', console.error.bind(console));

export function addLogClient(res: Response): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send existing buffer so the client sees recent history immediately
  for (const entry of buffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  clients.add(res);
  return () => clients.delete(res);
}
