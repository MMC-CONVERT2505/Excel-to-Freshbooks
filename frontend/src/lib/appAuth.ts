const KEY = 'mmc_app_token';
const USER_KEY = 'mmc_app_user';

export type AppUser = { id: number; email: string; name: string; role: string };

export const getAppToken  = (): string | null => localStorage.getItem(KEY);
export const setAppToken  = (t: string) => localStorage.setItem(KEY, t);
export const clearAppToken = () => { localStorage.removeItem(KEY); localStorage.removeItem(USER_KEY); };
export const isLoggedIn   = () => !!getAppToken();

export const getAppUser = (): AppUser | null => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
};
export const setAppUser = (u: AppUser) => localStorage.setItem(USER_KEY, JSON.stringify(u));
