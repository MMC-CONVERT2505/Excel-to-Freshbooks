import { Request, Response } from 'express';
import { getAuthUrl, exchangeCodeForTokens, fetchAndSaveBusinessIds, saveBusinessConfig } from '../services/auth.service.js';
import prisma from '../lib/prisma.js';

export function redirectToFreshBooks(req: Request, res: Response): void {
  const origin = process.env.FRONTEND_URL || req.headers.origin || 'http://localhost:1074';
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

  const { tokens, sessionId, tokenId } = await exchangeCodeForTokens(code);

  const rawState = req.query.state as string | undefined;
  const FRONTEND = rawState
    ? Buffer.from(rawState, 'base64url').toString()
    : process.env.FRONTEND_URL || 'http://localhost:1074';

  try {
    const memberships = await fetchAndSaveBusinessIds(tokens.access_token, tokenId, sessionId);

    if (memberships.length > 1) {
      const encoded = encodeURIComponent(JSON.stringify(
        memberships.map((m: any, i: number) => ({
          index:         i,
          name:          m.business.name,
          account_id:    m.business.account_id,
        }))
      ));
      res.redirect(`${FRONTEND}/oauth-callback?auth=select&businesses=${encoded}&session=${sessionId}`);
      return;
    }

    const bizName = memberships[0]?.business?.name || '';
    res.redirect(`${FRONTEND}/oauth-callback?auth=connected&name=${encodeURIComponent(bizName)}&session=${sessionId}`);
    return;
  } catch (err: any) {
    console.warn('[AUTH] Could not auto-fetch business IDs:', err.message);
  }

  res.redirect(`${FRONTEND}/oauth-callback?auth=connected&session=${sessionId}`);
}

// POST /auth/select-business — frontend sends chosen business after multi-business OAuth
export async function selectBusiness(req: Request, res: Response): Promise<void> {
  const index     = parseInt(String(req.params.index ?? req.body?.index), 10);
  const sessionId = (req as any).sessionId as string | undefined;
  const tokenId   = (req as any).sessionTokenId as number | undefined;

  if (!sessionId || !tokenId) {
    res.status(401).json({ error: 'Session required. Complete OAuth first.' });
    return;
  }

  const session = await prisma.userSession.findUnique({
    where:  { id: sessionId },
    select: { pendingBusinesses: true },
  });

  const memberships: any[] = (session?.pendingBusinesses as any[]) || [];

  if (!memberships.length) {
    res.status(400).json({ error: 'No pending businesses for this session. Complete OAuth first.' });
    return;
  }
  if (isNaN(index) || index < 0 || index >= memberships.length) {
    res.status(400).json({ error: `Invalid index. Valid range: 0–${memberships.length - 1}` });
    return;
  }

  const biz = memberships[index].business;
  await saveBusinessConfig(biz.account_id, biz.business_uuid, String(biz.id), biz.name, tokenId);

  // Clear pending businesses now that selection is done
  await prisma.userSession.update({ where: { id: sessionId }, data: { pendingBusinesses: undefined } });

  console.log(`\n[AUTH] ✅ Selected: "${biz.name}" for session ${sessionId}\n`);
  res.json({ message: `Selected "${biz.name}".`, business: biz });
}

export async function getAuthStatus(req: Request, res: Response): Promise<void> {
  const tokenId = (req as any).sessionTokenId as number | undefined;

  const token = tokenId
    ? await prisma.freshbooksToken.findUnique({
        where:  { id: tokenId },
        select: { id: true, accountId: true, businessId: true, expiresAt: true, companyLabel: true },
      })
    : null;

  res.json({
    connected:   Boolean(token),
    accountId:   token?.accountId    ?? null,
    businessId:  token?.businessId   ?? null,
    expiresAt:   token?.expiresAt    ?? null,
    companyName: token?.companyLabel ?? null,
  });
}

export async function getCompanies(req: Request, res: Response): Promise<void> {
  const tokenId = (req as any).sessionTokenId as number | undefined;
  if (!tokenId) { res.json({ companies: [] }); return; }

  const token = await prisma.freshbooksToken.findUnique({
    where:  { id: tokenId },
    select: { id: true, accountId: true, businessId: true, companyLabel: true, isCurrent: true, createdAt: true },
  });
  res.json({ companies: token ? [token] : [] });
}

export async function switchCompany(req: Request, res: Response): Promise<void> {
  const tokenId   = parseInt(String(req.params.tokenId), 10);
  const sessionId = (req as any).sessionId as string | undefined;

  if (isNaN(tokenId)) { res.status(400).json({ error: 'Invalid tokenId' }); return; }
  if (!sessionId)     { res.status(401).json({ error: 'Session required'  }); return; }

  const target = await prisma.freshbooksToken.findUnique({
    where:  { id: tokenId },
    select: { id: true, accountId: true, businessUuid: true, businessId: true, companyLabel: true, isActive: true },
  });
  if (!target || !target.isActive) { res.status(404).json({ error: 'Company not found' }); return; }

  // Rebind this session to the chosen token
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  await prisma.userSession.update({ where: { id: sessionId }, data: { tokenId, expiresAt } });

  if (target.accountId && target.businessUuid && target.businessId) {
    const { setBusinessConfig } = await import('../services/freshbooks.service.js');
    setBusinessConfig(target.accountId, target.businessUuid, target.businessId);
  }

  console.log(`\n[AUTH] ✅ Session ${sessionId} switched to "${target.companyLabel || target.accountId}".\n`);
  res.json({ message: `Switched to "${target.companyLabel || target.accountId}"`, company: target });
}

export async function updateCompanyLabel(req: Request, res: Response): Promise<void> {
  const tokenId = parseInt(String(req.params.tokenId), 10);
  const { label } = req.body as { label?: string };

  if (isNaN(tokenId))   { res.status(400).json({ error: 'Invalid tokenId' }); return; }
  if (!label?.trim())   { res.status(400).json({ error: 'label is required' }); return; }

  const updated = await prisma.freshbooksToken.update({
    where:  { id: tokenId },
    data:   { companyLabel: label.trim() },
    select: { id: true, companyLabel: true },
  });
  res.json({ company: updated });
}
