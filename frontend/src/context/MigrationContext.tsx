import { createContext, useContext, useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Entity } from '../data/entities';
import { ENTITIES } from '../data/entities';
import type { MigrationResult, MigrationPhaseResult } from '../lib/api';
import { migrateExcelEntity, getMigrationStatus, cancelMigration } from '../lib/api';
import { useApp } from './AppContext';
import { useToast } from './ToastContext';

// ── waves ─────────────────────────────────────────────────────────────────────
export const WAVES = [
  { id: 'wave-1', num: 1, label: 'Wave 1', subtitle: 'Master Data',      entities: ['chart-of-accounts', 'clients', 'vendors'] },
  { id: 'wave-2', num: 2, label: 'Wave 2', subtitle: 'Transactions',     entities: ['items', 'services', 'journal-entries', 'expenses', 'income'] },
  { id: 'wave-3', num: 3, label: 'Wave 3', subtitle: 'Documents',        entities: ['invoices', 'bills', 'credit-notes'] },
  { id: 'wave-4', num: 4, label: 'Wave 4', subtitle: 'Payments',         entities: ['invoice-payments', 'bill-payments'] },
] as const;

export type WaveId = typeof WAVES[number]['id'];

// ── dependency map ────────────────────────────────────────────────────────────
export const DEPS: Record<string, string[]> = {
  'chart-of-accounts': [],
  'clients':           [],
  'vendors':           [],
  'income':            [],
  'expenses':          [],
  'items':             [],
  'services':          [],
  'journal-entries':   [],
  'invoices':          [],
  'bills':             [],
  'credit-notes':      [],
  'invoice-payments':  [],
  'bill-payments':     [],
};

export const TOTAL_RECORDS: Record<string, number> = {
  'chart-of-accounts': 142, clients: 264, vendors: 130,
  items: 94, services: 54, income: 431, 'journal-entries': 207,
  expenses: 633, invoices: 400, bills: 162, 'credit-notes': 45,
  'invoice-payments': 380, 'bill-payments': 156,
};

export interface PushState { pct: number; done: number; total: number; active: boolean; real?: boolean; }

// ── localStorage ──────────────────────────────────────────────────────────────
export const MIG_LS_KEY = 'mmc_tracker_results';

export function loadStoredResults(): Record<string, MigrationResult> {
  try { return JSON.parse(localStorage.getItem(MIG_LS_KEY) || '{}'); } catch { return {}; }
}
export function saveStoredResult(id: string, result: MigrationResult) {
  try {
    const s = loadStoredResults(); s[id] = result;
    localStorage.setItem(MIG_LS_KEY, JSON.stringify(s));
  } catch {}
}

// ── running-state persistence (survives page refresh) ────────────────────────
const RUNNING_KEY = 'mmc_running_entities';

interface RunningEntry { total: number; startedAt: number; }

function loadRunning(): Record<string, RunningEntry> {
  try {
    const data = JSON.parse(localStorage.getItem(RUNNING_KEY) || '{}') as Record<string, RunningEntry>;
    const now = Date.now();
    const fresh: Record<string, RunningEntry> = {};
    for (const [id, v] of Object.entries(data)) {
      // Discard entries older than 2 hours — migration must have finished or crashed
      if (now - v.startedAt < 2 * 60 * 60 * 1000) fresh[id] = v;
    }
    return fresh;
  } catch { return {}; }
}
function markRunning(id: string, total: number) {
  try {
    const d = loadRunning(); d[id] = { total, startedAt: Date.now() };
    localStorage.setItem(RUNNING_KEY, JSON.stringify(d));
  } catch {}
}
function clearRunning(id: string) {
  try {
    const d = loadRunning(); delete d[id];
    localStorage.setItem(RUNNING_KEY, JSON.stringify(d));
  } catch {}
}

// ── context shape ─────────────────────────────────────────────────────────────
interface MigCtx {
  entities:     Entity[];
  pushMap:      Record<string, PushState>;
  resultMap:    Record<string, MigrationResult>;
  sessionPushed: Set<string>;
  startTimes:   Record<string, number>;
  pushEntity:   (id: string, disableAnim?: boolean) => Promise<void>;
  cancelEntity: (id: string) => Promise<void>;
  runAll:       () => Promise<void>;
  canPush:      (id: string) => { ok: boolean; missing: { id: string; name: string }[] };
}

const Ctx = createContext<MigCtx | null>(null);

export function useMigration(): MigCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMigration must be inside MigrationProvider');
  return c;
}

// ── provider ──────────────────────────────────────────────────────────────────
export function MigrationProvider({ children, workflow }: { children: ReactNode; workflow: string }) {
  const { fbConnected, uploaded } = useApp();
  const { toast } = useToast();

  const [entities, setEntities] = useState<Entity[]>(() => {
    if (workflow !== 'excel') return ENTITIES;
    const stored = loadStoredResults();
    return ENTITIES.map(e => {
      const r = stored[e.id];
      if (r) return {
        ...e,
        status:  r.failed > 0 ? 'error' as const : 'done' as const,
        pushed:  r.success, skipped: r.skipped, failed: r.failed,
        dur:     r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '-',
        last: '-', progress: 100,
      };
      // Always start as idle — actual running state is authoritative from backend poll on mount
      return { ...e, status: 'idle' as const, pushed: 0, skipped: 0, failed: 0, dur: '-', last: '-', progress: 0 };
    });
  });

  const [pushMap, setPushMap] = useState<Record<string, PushState>>({});
  const [resultMap, setResultMap] = useState<Record<string, MigrationResult>>(() =>
    workflow === 'excel' ? loadStoredResults() : {}
  );

  const ivRefs      = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const startTRef   = useRef<Record<string, number>>({});
  const sessRef     = useRef<Set<string>>(new Set());

  // ── helpers ──────────────────────────────────────────────────────────────────
  function canPush(id: string) {
    const missing = (DEPS[id] || [])
      .map(d => entities.find(x => x.id === d))
      .filter((d): d is Entity => !!d && d.status !== 'done')
      .map(d => ({ id: d.id, name: d.name }));
    return { ok: missing.length === 0, missing };
  }

  function applyPhases(phases: MigrationPhaseResult[]) {
    if (!phases.length) return;

    setEntities(prev => prev.map(e => {
      const p = phases.find(x => x.entity === e.id);
      if (!p) return e;
      if (p.status === 'RUNNING')
        return { ...e, status: 'running' as const, pushed: p.success, skipped: p.skipped, failed: p.failed };
      const fin = p.status === 'COMPLETED' || p.status === 'PARTIAL' || p.status === 'FAILED';
      if (!fin) return e;
      // Never overwrite a locally-running entity with a stale completed phase.
      // There is a gap between pushEntity() starting and the new RUNNING phase appearing
      // in the DB (FreshBooks pre-flight calls can take 500ms–2s). During that gap the
      // poll would see the OLD completed phase and revert the UI to the previous result.
      // The HTTP response .then() handler is responsible for setting the final state.
      if (e.status === 'running') return e;
      return {
        ...e,
        status: p.status === 'FAILED' || p.failed > 0 ? 'error' as const : 'done' as const,
        pushed: p.success, skipped: p.skipped, failed: p.failed,
        dur:    p.durationMs ? `${(p.durationMs / 1000).toFixed(1)}s` : '-',
      };
    }));

    setResultMap(prev => {
      const next = { ...prev };
      for (const p of phases)
        if (p.status !== 'RUNNING')
          next[p.entity] = { entity: p.entity, total: p.total, success: p.success, skipped: p.skipped, failed: p.failed, durationMs: p.durationMs, errors: p.errors };
      return next;
    });

    setPushMap(prev => {
      const next = { ...prev };
      for (const p of phases) {
        if (p.status !== 'RUNNING') continue;
        const rd = p.success + p.skipped + p.failed;
        const rp = p.total > 0 ? Math.round(rd / p.total * 100) : 0;
        if (!startTRef.current[p.entity])
          startTRef.current[p.entity] = Date.now() - (p.durationMs ?? 0);
        // Real DB data always wins — never blocked by stale fake values
        next[p.entity] = { pct: rp, done: rd, total: p.total, active: true, real: true };
      }
      return next;
    });
  }

  // ── pushEntity ────────────────────────────────────────────────────────────────
  async function pushEntity(id: string, disableAnim = workflow === 'excel'): Promise<void> {
    // ── Pre-flight guard: check DB before starting (catches multi-tab duplicates) ──
    if (workflow === 'excel') {
      try {
        const { phases } = await getMigrationStatus();
        const alreadyRunning = phases.find(p => p.entity === id && p.status === 'RUNNING');
        if (alreadyRunning) {
          applyPhases(phases); // sync local state so the UI shows it as running
          return;              // bail out silently — no duplicate push
        }
      } catch { /* network error — let backend be the final guard */ }
    }

    return new Promise<void>(resolve => {
      const total = (workflow === 'excel' ? uploaded[id]?.rows : undefined) ?? TOTAL_RECORDS[id] ?? 100;
      startTRef.current[id] = Date.now();
      sessRef.current.add(id);
      markRunning(id, total);  // persist so refresh restores running state
      setPushMap(m => ({ ...m, [id]: { pct: 0, done: 0, total, active: true } }));
      setEntities(e => e.map(x => x.id === id ? { ...x, status: 'running' } : x));

      if (!disableAnim) {
        const CAP  = Math.floor(total * 0.90);
        const estMs = Math.max(2000, Math.ceil(total / 12) * 400);
        const step  = Math.max(1, Math.floor(CAP / (estMs / 250)));
        let ad = 0;
        ivRefs.current[id] = setInterval(() => {
          const j = Math.floor(Math.random() * step * 0.5) - Math.floor(step * 0.25);
          ad = Math.min(ad + step + j, CAP);
          setPushMap(m => ({ ...m, [id]: { pct: Math.round(ad / total * 100), done: ad, total, active: true } }));
        }, 250);
      }

      const call: Promise<MigrationResult | null> = workflow === 'excel'
        ? migrateExcelEntity(id) : Promise.resolve(null);

      call
        .then(result => {
          clearInterval(ivRefs.current[id]);
          if (result) {
            saveStoredResult(id, result);
            setResultMap(m => ({ ...m, [id]: result }));
            const dur    = `${(result.durationMs / 1000).toFixed(1)}s`;
            const status = result.failed > 0 ? 'error' as const : 'done' as const;
            setEntities(e => e.map(x => x.id === id
              ? { ...x, status, pushed: result.success, skipped: result.skipped, failed: result.failed, dur }
              : x));
            setPushMap(m => ({ ...m, [id]: { pct: 100, done: result.total, total: result.total, active: false } }));
          } else {
            const pushed = total - Math.floor(Math.random() * 5);
            setEntities(e => e.map(x => x.id === id
              ? { ...x, status: 'done', pushed, failed: total - pushed, dur: `${(Math.random() * 15 + 2).toFixed(1)}s` }
              : x));
            setPushMap(m => ({ ...m, [id]: { pct: 100, done: total, total, active: false } }));
          }
          clearRunning(id);
          // Completion toast — tells user this entity is done so they can move to the next
          const name = ENTITIES.find(e => e.id === id)?.name ?? id;
          if (result) {
            if (result.failed > 0) {
              toast('warning', `${name} done with errors`,
                `${result.success.toLocaleString()} pushed · ${result.failed.toLocaleString()} failed — download the error sheet to fix them.`);
            } else {
              toast('success', `${name} complete ✓`,
                `${result.success.toLocaleString()} record${result.success !== 1 ? 's' : ''} pushed to FreshBooks.`);
            }
          } else {
            toast('success', `${name} complete ✓`, 'All records pushed to FreshBooks.');
          }
          setTimeout(() => { setPushMap(m => { const n = { ...m }; delete n[id]; return n; }); resolve(); }, 600);
        })
        .catch((err: any) => {
          clearInterval(ivRefs.current[id]);
          clearRunning(id);
          const name = ENTITIES.find(e => e.id === id)?.name ?? id;
          toast('error', `${name} failed`, err?.message || 'Migration could not complete — check the error and retry.');
          setEntities(e => e.map(x => x.id === id ? { ...x, status: 'error' } : x));
          setPushMap(m => { const n = { ...m }; delete n[id]; return n; });
          resolve();
        });
    });
  }

  // ── cancelEntity ──────────────────────────────────────────────────────────────
  async function cancelEntity(id: string): Promise<void> {
    try {
      await cancelMigration(id);
    } catch { /* best-effort — still clear UI state */ }
    clearRunning(id);
    clearInterval(ivRefs.current[id]);
    setEntities(prev => prev.map(e => e.id === id ? { ...e, status: 'idle' as const } : e));
    setPushMap(prev => { const n = { ...prev }; delete n[id]; return n; });
    const name = ENTITIES.find(e => e.id === id)?.name ?? id;
    toast('warning', `${name} stopped`, 'Migration was cancelled.');
  }

  // ── runAll ────────────────────────────────────────────────────────────────────
  async function runAll() {
    if (!fbConnected) return;
    if (workflow === 'excel') {
      const toRerun = Object.keys(DEPS).filter(id => {
        const e = entities.find(x => x.id === id);
        return e && e.status !== 'done';
      });
      if (toRerun.length) {
        const s = loadStoredResults();
        toRerun.forEach(id => delete s[id]);
        try { localStorage.setItem(MIG_LS_KEY, JSON.stringify(s)); } catch {}
      }
    }

    const MAX = 3; let running = 0;
    const scheduled: Record<string, Promise<void>> = {};
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<void> => running < MAX
      ? (running++, Promise.resolve())
      : new Promise(r => waiters.push(() => { running++; r(); }));
    const release = () => { running--; waiters.shift()?.(); };

    const schedule = (id: string): Promise<void> => {
      if (scheduled[id]) return scheduled[id];
      const deps = (DEPS[id] || []).filter(d => {
        const e = entities.find(x => x.id === d);
        return e && e.status !== 'done';
      });
      scheduled[id] = Promise.all(deps.map(schedule))
        .then(acquire).then(() => pushEntity(id)).finally(release);
      return scheduled[id];
    };

    const toRun = Object.keys(DEPS).filter(id => {
      const e = entities.find(x => x.id === id);
      return e && e.status !== 'done';
    });
    await Promise.all(toRun.map(schedule));
  }

  // ── DB sync on mount + polling ────────────────────────────────────────────────
  // On mount: fetch real backend state — this is the authoritative source for running/done/error.
  // Completed phases are also saved to localStorage so they survive navigation.
  useEffect(() => {
    if (workflow !== 'excel') return;
    getMigrationStatus().then(({ phases }) => {
      if (!phases.length) return;
      for (const p of phases)
        if (p.status !== 'RUNNING' && p.entity)
          saveStoredResult(p.entity, { entity: p.entity, total: p.total, success: p.success, skipped: p.skipped, failed: p.failed, durationMs: p.durationMs, errors: p.errors });
      applyPhases(phases);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasRunning = entities.some(e => e.status === 'running');
  useEffect(() => {
    if (!hasRunning || workflow !== 'excel') return;
    const iv = setInterval(() =>
      getMigrationStatus().then(({ phases }) => applyPhases(phases)).catch(() => {}), 1000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunning]);

  return (
    <Ctx.Provider value={{
      entities, pushMap, resultMap,
      sessionPushed: sessRef.current,
      startTimes:    startTRef.current,
      pushEntity, cancelEntity, runAll, canPush,
    }}>
      {children}
    </Ctx.Provider>
  );
}
