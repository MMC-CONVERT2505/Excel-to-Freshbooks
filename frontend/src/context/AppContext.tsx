import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';

export type Workflow = 'qbd' | 'excel';

interface UploadedFile { name: string; size: string; rows?: number; savedAs?: string; }

// Stored entry includes a timestamp so we can expire stale data
interface StoredEntry extends UploadedFile { uploadedAt: number; company: string; }

interface AppState {
  fbConnected:    boolean;
  setFbConnected: (v: boolean) => void;
  companyName:    string;
  setCompanyName: (v: string) => void;
  uploaded:       Record<string, UploadedFile>;
  setUploaded:    (u: Record<string, UploadedFile> | ((prev: Record<string, UploadedFile>) => Record<string, UploadedFile>)) => void;
  checkingAuth:   boolean;
}

const Ctx = createContext<AppState>({} as AppState);
export const useApp = () => useContext(Ctx);

const API       = import.meta.env.VITE_API_BASE_URL || 'http://localhost:1073';
const LS_KEY    = 'fb_connected';
const LS_CO     = 'fb_company';
const LS_UPLOAD = 'mmc_uploaded_files';

// Files uploaded more than 48 hours ago are considered stale
const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000;

function loadUploadedFiles(currentCompany: string): Record<string, UploadedFile> {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_UPLOAD) || '{}') as Record<string, StoredEntry>;
    const now  = Date.now();
    const valid: Record<string, UploadedFile> = {};

    for (const [id, entry] of Object.entries(raw)) {
      const tooOld      = now - entry.uploadedAt > UPLOAD_TTL_MS;
      const wrongAccount = currentCompany && entry.company && entry.company !== currentCompany;

      if (!tooOld && !wrongAccount) {
        const { uploadedAt: _, company: __, ...file } = entry;
        valid[id] = file;
      }
    }

    return valid;
  } catch { return {}; }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [fbConnected, _setFbConnected] = useState(() => localStorage.getItem(LS_KEY) === 'true');
  const [companyName, _setCompanyName] = useState(() => localStorage.getItem(LS_CO) || '');
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Restore uploaded files — filter out stale / wrong-account entries
  const [uploaded, _setUploaded] = useState<Record<string, UploadedFile>>(() =>
    loadUploadedFiles(localStorage.getItem(LS_CO) || '')
  );

  const setFbConnected = useCallback((v: boolean) => {
    _setFbConnected(v);
    if (v) {
      localStorage.setItem(LS_KEY, 'true');
    } else {
      // Disconnected — wipe everything sensitive
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_CO);
      localStorage.removeItem(LS_UPLOAD);
      _setUploaded({});
    }
  }, []);

  const setCompanyName = useCallback((v: string) => {
    _setCompanyName(v);
    if (v) localStorage.setItem(LS_CO, v);
  }, []);

  // When company changes (different FreshBooks account connected), clear uploaded files
  useEffect(() => {
    if (!companyName) return;
    _setUploaded(prev => {
      // Re-filter with the now-known company name
      const filtered = loadUploadedFiles(companyName);
      // If nothing changed, keep same reference to avoid re-render
      if (JSON.stringify(prev) === JSON.stringify(filtered)) return prev;
      return filtered;
    });
  }, [companyName]);

  const setUploaded = useCallback((u: Record<string, UploadedFile> | ((prev: Record<string, UploadedFile>) => Record<string, UploadedFile>)) => {
    _setUploaded(prev => {
      const next = typeof u === 'function' ? u(prev) : u;

      // Save with metadata so we can validate on restore
      try {
        const company = localStorage.getItem(LS_CO) || '';
        const now     = Date.now();
        const toStore: Record<string, StoredEntry> = {};
        for (const [id, file] of Object.entries(next)) {
          toStore[id] = { ...file, uploadedAt: now, company };
        }
        localStorage.setItem(LS_UPLOAD, JSON.stringify(toStore));
      } catch {}

      return next;
    });
  }, []);

  useEffect(() => {
    fetch(`${API}/auth/status`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        if (typeof data.connected === 'boolean') setFbConnected(data.connected);
        if (data.companyName) setCompanyName(data.companyName);
      })
      .catch(() => {})
      .finally(() => setCheckingAuth(false));
  }, []);

  return (
    <Ctx.Provider value={{ fbConnected, setFbConnected, companyName, setCompanyName, uploaded, setUploaded, checkingAuth }}>
      {children}
    </Ctx.Provider>
  );
}
