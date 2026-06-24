import axios from 'axios';
import prisma from '../lib/prisma.js';
import { setBusinessConfig } from './freshbooks.service.js';

// Save business config onto a specific token (not the global isCurrent)
export async function saveBusinessConfig(
  accountId: string,
  businessUuid: string,
  businessId: string,
  businessName: string | undefined,
  tokenId: number,
): Promise<void> {
  await prisma.freshbooksToken.update({
    where: { id: tokenId },
    data: {
      accountId, businessUuid, businessId,
      ...(businessName ? { companyLabel: businessName } : {}),
    },
  });
  setBusinessConfig(accountId, businessUuid, businessId);
}

// Fetch /users/me from FreshBooks, auto-save if single business, store pending list if multiple.
export async function fetchAndSaveBusinessIds(
  accessToken: string,
  tokenId: number,
  sessionId: string,
): Promise<any[]> {
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
    await saveBusinessConfig(biz.account_id, biz.business_uuid, String(biz.id), biz.name, tokenId);
    console.log(`\n[AUTH] ✅ Auto-saved business: "${biz.name}"`);
    return memberships;
  }

  // Multiple businesses — store in the session so selectBusiness can read them per-user
  console.log(`\n[AUTH] ${memberships.length} businesses found — awaiting frontend selection.`);
  memberships.forEach((m, i) => {
    const biz = m.business;
    console.log(`  [${i}] ${biz.name}  (account_id=${biz.account_id})`);
  });

  await prisma.userSession.update({
    where: { id: sessionId },
    data:  { pendingBusinesses: memberships as any },
  });

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

  const state = frontendOrigin ? Buffer.from(frontendOrigin).toString('base64url') : '';
  const stateParam = state ? `&state=${encodeURIComponent(state)}` : '';

  return `https://my.freshbooks.com/service/auth/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${encodeURIComponent(scopes)}${stateParam}`;
}

// Exchange OAuth code for tokens, create FreshbooksToken + UserSession, return sessionId.
export async function exchangeCodeForTokens(code: string): Promise<{ tokens: any; sessionId: string; tokenId: number }> {
  const response = await axios.post('https://api.freshbooks.com/auth/oauth/token', {
    grant_type:    'authorization_code',
    client_id:     process.env.FRESHBOOKS_CLIENT_ID,
    client_secret: process.env.FRESHBOOKS_CLIENT_SECRET,
    code,
    redirect_uri:  process.env.FRESHBOOKS_REDIRECT_URI,
  });

  const tokens    = response.data;
  const expiresAt = new Date((tokens.created_at + tokens.expires_in) * 1000);

  const token = await prisma.freshbooksToken.create({
    data: {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType:    tokens.token_type || 'Bearer',
      scope:        tokens.scope,
      expiresAt,
      isActive:  true,
      isCurrent: false,
    },
  });

  const session = await prisma.userSession.create({
    data: { tokenId: token.id, expiresAt },
  });

  return { tokens, sessionId: session.id, tokenId: token.id };
}
