import { getAppUser } from './appAuth.js';

// Each logged-in user gets their own session key so two users
// on the same browser never share a FreshBooks session.
function sessionKey(): string {
  const user = getAppUser();
  return user ? `fb_session_id_${user.id}` : 'fb_session_id';
}

export function getSessionId(): string | null {
  return localStorage.getItem(sessionKey());
}

export function setSessionId(id: string): void {
  localStorage.setItem(sessionKey(), id);
}

export function clearSession(): void {
  localStorage.removeItem(sessionKey());
}
