import './lib/logStream.js'; // must be first — patches console before any other import
import http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter from './routes/auth.route.js';
import freshbooksRouter from './routes/freshbooks.route.js';
import migrationRouter from './routes/migration.route.js';
import parserRouter from './routes/parser.route.js';
import excelRouter from './routes/excel.route.js';
import adminRouter from './routes/admin.route.js';
import fileRouter from './routes/file.route.js';
import { handleCallback } from './controllers/auth.controller.js';
import { errorHandler } from './middleware/errorHandler.js';
import { resolveSession } from './middleware/session.js';
import { loadBusinessConfigFromDB } from './services/freshbooks.service.js';
import prisma from './lib/prisma.js';

dotenv.config();

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err);
});

const app = express();
const PORT = process.env.PORT || 1073;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '75mb' }));
app.use(resolveSession);
app.use('/auth', authRouter);
app.use('/freshbooks', freshbooksRouter);
app.use('/migrate', migrationRouter);
app.use('/parse', parserRouter);
app.use('/api/excel', excelRouter);
app.use('/api/admin', adminRouter);
// Under /api like the other JSON routers. Mounted at bare /files it collided with the
// frontend's own /:workflow/files page: nginx has no proxy rule for it, so the SPA
// fallback served index.html and the fetch got "<!doctype" instead of JSON.
app.use('/api/files', fileRouter);
app.get('/callback', handleCallback);
app.get(/\/oauth-callback/, handleCallback);  // matches /oauth-callback and /*/oauth-callback

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/config-check', (_req: Request, res: Response) => {
  res.json({
    port: PORT,
    clientIdLoaded: Boolean(process.env.FRESHBOOKS_CLIENT_ID),
  });
});

app.use(errorHandler);

const server = http.createServer(app);

async function cleanupExpiredSheets() {
  const { count } = await prisma.uploadedSheet.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (count > 0) console.log(`[CLEANUP] Deleted ${count} expired uploaded sheet(s).`);
}

async function cleanupExpiredSessions() {
  const { count } = await prisma.userSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (count > 0) console.log(`[CLEANUP] Deleted ${count} expired session(s).`);
}

async function cleanupExpiredFiles() {
  const { count } = await prisma.storedFile.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (count > 0) console.log(`[CLEANUP] Deleted ${count} expired stored file(s).`);
}

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  // Clean up any RUNNING phases/runs left over from a previous crashed session
  try {
    const phases = await prisma.migrationPhase.updateMany({
      where: { status: 'RUNNING' },
      data:  { status: 'FAILED', completedAt: new Date() },
    });
    const runs = await prisma.migrationRun.updateMany({
      where: { status: 'RUNNING' },
      data:  { status: 'FAILED', completedAt: new Date() },
    });
    if (phases.count > 0 || runs.count > 0)
      console.log(`[STARTUP] Cleared ${phases.count} stale phase(s) and ${runs.count} stale run(s) from previous session`);
  } catch (err: any) {
    console.warn('[STARTUP] Could not clean up stale migrations:', err.message);
  }
  // Delete uploaded sheets and stored files that have passed their expiry
  try {
    await cleanupExpiredSessions();
    await cleanupExpiredSheets();
    await cleanupExpiredFiles();
  } catch (err: any) {
    console.warn('[STARTUP] Could not clean up expired data:', err.message);
  }
  // Re-run cleanup every 6 hours so long-running servers also purge stale data
  setInterval(async () => {
    await cleanupExpiredSessions().catch(() => {});
    await cleanupExpiredSheets().catch(() => {});
    await cleanupExpiredFiles().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  try {
    await loadBusinessConfigFromDB();
  } catch (err: any) {
    console.warn('[CONFIG] Could not load business config from DB:', err.message);
  }
});

server.on('error', (err) => {
  console.error('[SERVER] Error:', err);
  process.exit(1);
});
