import { Request, Response } from 'express';
import { getAuthUrl, exchangeCodeForTokens, fetchAndSaveBusinessIds, saveBusinessConfig } from '../services/auth.service.js';
import prisma from '../lib/prisma.js';

export function redirectToFreshBooks(req: Request, res: Response): void {
  // Capture the caller's origin so the callback can redirect back to the right frontend
  const origin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || process.env.FRONTEND_URL || 'http://localhost:1074';
  const url = getAuthUrl(origin);
  res.redirect(url);
}

export async function handleCallback(req: Request, res: Response): Promise<void> {
  const raw  = req.query.code;
  const code = Array.isArray(raw) ? String(raw[0]) : typeof raw === 'object' ? '' : String(raw ?? '');

  if (!code) {
    res.status(400).json({ error: 'Authorization code missing' });
    return;
  }

  const tokens = await exchangeCodeForTokens(code);

  // Decode the frontend origin we encoded in the state param during login
  const rawState = req.query.state as string | undefined;
  const FRONTEND = rawState
    ? Buffer.from(rawState, 'base64url').toString()
    : process.env.FRONTEND_URL || 'http://localhost:1074';

  try {
    const memberships = await fetchAndSaveBusinessIds(tokens.access_token);
    // Use the fresh memberships list — never rely on the stale __fbBusinesses global here
    if (memberships.length > 1) {
      const encoded = encodeURIComponent(JSON.stringify(
        memberships.map((m: any, i: number) => ({ index: i, name: m.business.name, account_id: m.business.account_id }))
      ));
      res.redirect(`${FRONTEND}/oauth-callback?auth=select&businesses=${encoded}`);
      return;
    }
    // Single business — pass name to frontend
    const bizName = memberships[0]?.business?.name || '';
    res.redirect(`${FRONTEND}/oauth-callback?auth=connected&name=${encodeURIComponent(bizName)}`);
    return;
  } catch (err: any) {
    console.warn('[AUTH] Could not auto-fetch business IDs:', err.message);
  }

  res.redirect(`${FRONTEND}/oauth-callback?auth=connected`);
}

export async function selectBusiness(req: Request, res: Response): Promise<void> {
  const index = parseInt(String(req.params.index), 10);
  const memberships: any[] = (global as any).__fbBusinesses || [];

  if (!memberships.length) {
    res.status(400).json({ error: 'No businesses in memory. Complete OAuth first.' });
    return;
  }
  if (index < 0 || index >= memberships.length) {
    res.status(400).json({ error: `Invalid index. Valid range: 0–${memberships.length - 1}` });
    return;
  }

  const biz = memberships[index].business;
  await saveBusinessConfig(biz.account_id, biz.business_uuid, String(biz.id), biz.name);

  console.log(`\n[AUTH] ✅ Selected: "${biz.name}" — saved to DB, active immediately.\n`);
  res.json({ message: `Selected "${biz.name}". Active immediately — no restart needed.`, business: biz });
}

export async function getAuthStatus(_req: Request, res: Response): Promise<void> {
  const token = await prisma.freshbooksToken.findFirst({
    where: { isCurrent: true },
    select: { id: true, accountId: true, businessId: true, expiresAt: true, companyLabel: true },
  }) ?? await prisma.freshbooksToken.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true, accountId: true, businessId: true, expiresAt: true, companyLabel: true },
  });

  res.json({
    connected:   Boolean(token),
    accountId:   token?.accountId    ?? null,
    businessId:  token?.businessId   ?? null,
    expiresAt:   token?.expiresAt    ?? null,
    companyName: token?.companyLabel ?? null,
  });
}

export async function getCompanies(_req: Request, res: Response): Promise<void> {
  const tokens = await prisma.freshbooksToken.findMany({
    where:   { isActive: true },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, accountId: true, businessId: true, companyLabel: true, isCurrent: true, createdAt: true },
  });
  res.json({ companies: tokens });
}

export async function switchCompany(req: Request, res: Response): Promise<void> {
  const tokenId = parseInt(String(req.params.tokenId), 10);
  if (isNaN(tokenId)) { res.status(400).json({ error: 'Invalid tokenId' }); return; }

  const target = await prisma.freshbooksToken.findUnique({
    where:  { id: tokenId },
    select: { id: true, accountId: true, businessUuid: true, businessId: true, companyLabel: true, isActive: true },
  });
  if (!target || !target.isActive) { res.status(404).json({ error: 'Company not found' }); return; }

  await prisma.freshbooksToken.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
  await prisma.freshbooksToken.update({ where: { id: tokenId }, data: { isCurrent: true } });

  if (target.accountId && target.businessUuid && target.businessId) {
    const { setBusinessConfig } = await import('../services/freshbooks.service.js');
    setBusinessConfig(target.accountId, target.businessUuid, target.businessId);
  }

  console.log(`\n[AUTH] ✅ Switched to "${target.companyLabel || target.accountId}".\n`);
  res.json({ message: `Switched to "${target.companyLabel || target.accountId}"`, company: target });
}

export async function updateCompanyLabel(req: Request, res: Response): Promise<void> {
  const tokenId = parseInt(String(req.params.tokenId), 10);
  const { label } = req.body as { label?: string };

  if (isNaN(tokenId))       { res.status(400).json({ error: 'Invalid tokenId' }); return; }
  if (!label?.trim())       { res.status(400).json({ error: 'label is required' }); return; }

  const updated = await prisma.freshbooksToken.update({
    where:  { id: tokenId },
    data:   { companyLabel: label.trim() },
    select: { id: true, companyLabel: true },
  });
  res.json({ company: updated });
}
