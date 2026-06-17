import axios from 'axios';
import prisma from '../lib/prisma.js';
import { setBusinessConfig } from './freshbooks.service.js';

export async function saveBusinessConfig(accountId: string, businessUuid: string, businessId: string, businessName?: string): Promise<void> {
  await prisma.freshbooksToken.updateMany({
    where:  { isCurrent: true },
    data: {
      accountId, businessUuid, businessId,
      ...(businessName ? { companyLabel: businessName } : {}),
    },
  });
  setBusinessConfig(accountId, businessUuid, businessId);
}

export async function fetchAndSaveBusinessIds(accessToken: string): Promise<any[]> {
  const res = await axios.get('https://api.freshbooks.com/auth/api/v1/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const memberships: any[] = res.data?.response?.business_memberships || [];

  if (memberships.length === 0) {
    console.log('\n[AUTH] No businesses found on this FreshBooks account.');
    return memberships;
  }

  if (memberships.length === 1) {
    const biz = memberships[0].business;
    await saveBusinessConfig(biz.account_id, biz.business_uuid, String(biz.id), biz.name);
    console.log(`\n[AUTH] ✅ Auto-saved business: "${biz.name}"`);
    return memberships;
  }

  // Multiple businesses — store in memory, frontend handles selection via UI
  console.log(`\n[AUTH] ${memberships.length} businesses found — awaiting frontend selection.`);
  memberships.forEach((m, i) => {
    const biz = m.business;
    console.log(`  [${i}] ${biz.name}  (account_id=${biz.account_id})`);
  });
  (global as any).__fbBusinesses = memberships;

  return memberships;
}

export function getAuthUrl(frontendOrigin?: string): string {
  const clientId    = process.env.FRESHBOOKS_CLIENT_ID;
  const redirectUri = process.env.FRESHBOOKS_REDIRECT_URI;

  const scopes = [
    'user:profile:read',
    'user:clients:read', 'user:clients:write',
    'user:invoices:read', 'user:invoices:write',
    'user:expenses:read', 'user:expenses:write',
    'user:billable_items:read', 'user:billable_items:write',
    'user:bills:read', 'user:bills:write',
    'user:bill_payments:read', 'user:bill_payments:write',
    'user:bill_vendors:read', 'user:bill_vendors:write',
    'user:estimates:read', 'user:estimates:write',
    'user:credit_notes:read', 'user:credit_notes:write',
    'user:business:read', 'user:business:write',
    'user:payments:read', 'user:payments:write',
    'user:account:read', 'user:account:write',
    'user:reports:read',
    'user:journal_entries:read', 'user:journal_entries:write',
    'user:other_income:read', 'user:other_income:write',
    'user:projects:read', 'user:projects:write',
  ].join(' ');

  // Encode the caller's frontend origin in state so the callback knows where to redirect
  const state = frontendOrigin ? Buffer.from(frontendOrigin).toString('base64url') : '';
  const stateParam = state ? `&state=${encodeURIComponent(state)}` : '';

  return `https://my.freshbooks.com/service/auth/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${encodeURIComponent(scopes)}${stateParam}`;
}

export async function exchangeCodeForTokens(code: string) {
  const response = await axios.post('https://api.freshbooks.com/auth/oauth/token', {
    grant_type:    'authorization_code',
    client_id:     process.env.FRESHBOOKS_CLIENT_ID,
    client_secret: process.env.FRESHBOOKS_CLIENT_SECRET,
    code,
    redirect_uri:  process.env.FRESHBOOKS_REDIRECT_URI,
  });

  const tokens = response.data;
  const expiresAt = new Date((tokens.created_at + tokens.expires_in) * 1000);

  // Deselect whichever company was current — new OAuth becomes the current one.
  // Keep isActive=true on all tokens so history per company is preserved.
  await prisma.freshbooksToken.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });

  await prisma.freshbooksToken.create({
    data: {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType:    tokens.token_type || 'Bearer',
      scope:        tokens.scope,
      expiresAt,
      isActive:     true,
      isCurrent:    true,
    },
  });

  return tokens;
}
