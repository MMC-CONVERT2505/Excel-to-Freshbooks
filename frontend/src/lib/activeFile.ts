import { getAppUser } from './appAuth.js';

// Which named file the user is currently working inside. Keyed per logged-in user for
// the same reason the FreshBooks session is: two people on one browser must never
// inherit each other's active file and push under the wrong client's name.
function key(): string {
  const user = getAppUser();
  return user ? `mmc_active_file_${user.id}` : 'mmc_active_file';
}

export function getActiveFileId(): number | null {
  const raw = localStorage.getItem(key());
  const id = Number(raw);
  return raw && !Number.isNaN(id) ? id : null;
}

export function setActiveFileId(id: number): void {
  localStorage.setItem(key(), String(id));
}

export function clearActiveFile(): void {
  localStorage.removeItem(key());
}
