import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode, ReactElement } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem { id: number; type: ToastType; title: string; msg: string; }

interface ToastCtx { toast: (type: ToastType, title: string, msg?: string) => void; }

const Ctx = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(Ctx);

const ICONS: Record<ToastType, ReactElement> = {
  success: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  error:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  info:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  warning: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
};

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((type: ToastType, title: string, msg = '') => {
    const id = ++nextId;
    setToasts(t => [...t, { id, type, title, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);

  const remove = (id: number) => setToasts(t => t.filter(x => x.id !== id));

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toast-stack">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast--${t.type}`}>
            <div className="toast__icon">{ICONS[t.type]}</div>
            <div className="toast__body"><b>{t.title}</b><span>{t.msg}</span></div>
            <button className="toast__close" onClick={() => remove(t.id)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
