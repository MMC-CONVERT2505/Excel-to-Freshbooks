const SESSION_KEY = 'fb_session_id';

export function getSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function setSessionId(id: string): void {
  localStorage.setItem(SESSION_KEY, id);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}
