import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useMigration } from '../context/MigrationContext';
import { getFile, type MigrationFileEntry } from '../lib/api';
import { getActiveFileId, clearActiveFile } from '../lib/activeFile';
import { EntityIcon } from '../components/EntityIcon';

/* Load order matters: everything in TRANSACTIONS refers to something in SETUP. */
const GROUPS: Array<{ label: string; hint: string; ids: string[] }> = [
  {
    label: 'Setup',
    hint:  'Load these first — transactions refer to them',
    ids: ['chart-of-accounts', 'clients', 'vendors', 'items', 'services'],
  },
  {
    label: 'Transactions',
    hint:  'The day-to-day entries',
    ids: ['expenses', 'income', 'invoices', 'sales-receipts', 'bills',
          'credit-notes', 'invoice-payments', 'bill-payments', 'journal-entries'],
  },
];

type CardState =
  | { kind: 'empty' }
  | { kind: 'ready';   rows: number }
  | { kind: 'partial'; pushed: number; total: number }
  | { kind: 'done';    pushed: number };

export default function FileOverviewPage() {
  const navigate = useNavigate();
  const { workflow = 'excel' } = useParams<{ workflow: string }>();
  const { entities } = useMigration();
  const { uploaded } = useApp();

  const [file, setFile] = useState<MigrationFileEntry | null>(null);

  useEffect(() => {
    const id = getActiveFileId();
    if (!id) return;
    getFile(id).then(setFile).catch(() => setFile(null));
  }, []);

  /* Derive each entity's state from what was uploaded and what has been pushed. */
  function stateOf(id: string): CardState {
    const ent  = entities.find(e => e.id === id);
    const rows = uploaded[id]?.rows;
    const pushed = ent?.pushed ?? 0;

    if (pushed > 0) {
      // A sheet's row count is the honest denominator when we have it; without one,
      // report only what was pushed rather than inventing a total.
      if (rows && pushed < rows) return { kind: 'partial', pushed, total: rows };
      return { kind: 'done', pushed };
    }
    if (rows) return { kind: 'ready', rows };
    return { kind: 'empty' };
  }

  const all = GROUPS.flatMap(g => g.ids);
  const doneCount = all.filter(id => stateOf(id).kind === 'done').length;
  const pct = Math.round((doneCount / all.length) * 100);

  function badge(s: CardState) {
    if (s.kind === 'ready')
      return <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: .3, color: 'var(--warning)',
                            background: 'var(--warning-light)', padding: '3px 8px', borderRadius: 999 }}>NOT PUSHED</span>;
    if (s.kind === 'partial')
      return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--warning)',
                            background: 'var(--warning-light)', padding: '3px 8px', borderRadius: 999 }}>
               {s.pushed}/{s.total}
             </span>;
    if (s.kind === 'done')
      return (
        <span style={{ color: 'var(--success)', display: 'grid' }}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/>
          </svg>
        </span>
      );
    return null;
  }

  function subtitle(s: CardState) {
    switch (s.kind) {
      case 'ready':   return `${s.rows.toLocaleString()} rows ready to push`;
      case 'partial': return `${s.pushed.toLocaleString()} of ${s.total.toLocaleString()} pushed`;
      case 'done':    return `All ${s.pushed.toLocaleString()} pushed to FreshBooks`;
      default:        return 'Upload a sheet';
    }
  }

  // State reads from the card itself, not just a badge: amber for work still to do,
  // green for finished, plain for nothing uploaded yet.
  function cardStyle(s: CardState): React.CSSProperties {
    if (s.kind === 'done')  return { border: '1px solid #A7DCC6', background: '#F4FBF8' };
    if (s.kind !== 'empty') return { border: '1px solid #F0C98A', background: '#FFFBF3' };
    return { border: '1px solid var(--border)', background: 'var(--surface)' };
  }

  return (
    <div className="file-overview">

      {/* ── header ── */}
      <button
        className="btn btn--sm btn--ghost"
        style={{ marginBottom: 14 }}
        onClick={() => { clearActiveFile(); navigate(`/${workflow}/files`); }}
      >
        ← All files
      </button>

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{file?.name ?? 'File'}</h2>
        {file?.company && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, color: 'var(--text-3)', fontSize: 12 }}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <span style={{ fontFamily: 'var(--mono, monospace)' }}>{file.company}</span>
          </div>
        )}
      </div>

      {/* ── progress ── */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card__body" style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <div style={{
            width: 62, height: 62, borderRadius: '50%', display: 'grid', placeItems: 'center',
            background: `conic-gradient(var(--blue) ${pct * 3.6}deg, var(--blue-light) 0deg)`,
            flexShrink: 0,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%', background: 'var(--surface)',
              display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, color: 'var(--text-1)',
            }}>{pct}%</div>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ fontSize: 14.5 }}>
              {doneCount === all.length ? 'All imports pushed' : 'Import in progress'}
            </strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
              {doneCount} of {all.length} imports are fully pushed to FreshBooks.
              Pick one below to upload and push.
            </p>
          </div>
          <button className="btn btn--ghost" onClick={() => navigate(`/${workflow}/history`)}>
            View history
          </button>
        </div>
      </div>

      {/* ── groups ── */}
      {GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: .6, textTransform: 'uppercase', color: 'var(--text-2)' }}>
              {group.label}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{group.hint}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 14 }}>
            {group.ids.map(id => {
              const ent = entities.find(e => e.id === id);
              const s = stateOf(id);
              return (
                <button
                  key={id}
                  className="card"
                  style={{
                    padding: 18, textAlign: 'left', display: 'block',
                    width: '100%', cursor: 'pointer', ...cardStyle(s),
                  }}
                  onClick={() => navigate(`/${workflow}/entity/${id}`)}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <EntityIcon id={id} size={46} />
                    {badge(s)}
                  </div>
                  <div style={{ marginTop: 13, fontSize: 13.5, fontWeight: 700, color: 'var(--text-1)' }}>
                    {ent?.name ?? id}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-3)' }}>
                    {subtitle(s)}
                  </div>
                  {(ent?.failed ?? 0) > 0 && (
                    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--error)' }}>
                      {ent!.failed.toLocaleString()} failed
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
