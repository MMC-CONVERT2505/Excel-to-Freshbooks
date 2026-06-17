import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMigrationStatus } from '../lib/api';
import type { MigrationPhaseResult } from '../lib/api';
import { ENTITIES } from '../data/entities';

const ENTITY_ORDER = [
  'chart-of-accounts',
  'clients',
  'vendors',
  'items',
  'services',
  'expenses',
  'income',
  'invoices',
  'bills',
  'credit-notes',
  'invoice-payments',
  'bill-payments',
  'journal-entries',
];

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

function fmtDur(ms: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'COMPLETED') return <span className="hist-badge hist-badge--green">Completed</span>;
  if (status === 'PARTIAL')   return <span className="hist-badge hist-badge--amber">Partial</span>;
  if (status === 'FAILED')    return <span className="hist-badge hist-badge--red">Failed</span>;
  if (status === 'RUNNING')   return <span className="hist-badge hist-badge--blue">Running</span>;
  return <span className="hist-badge hist-badge--grey">Not run</span>;
}

export default function HistoryPage() {
  const { workflow = 'excel' } = useParams<{ workflow: string }>();
  const navigate = useNavigate();

  const [phases, setPhases]     = useState<MigrationPhaseResult[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    getMigrationStatus()
      .then(({ phases: p }) => { setPhases(p); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  const phaseMap = new Map(phases.map(p => [p.entity, p]));

  const rows = ENTITY_ORDER.map(id => {
    const entity = ENTITIES.find(e => e.id === id);
    const phase  = phaseMap.get(id);
    return { id, name: entity?.name ?? id, phase };
  });

  const totalPushed  = rows.reduce((a, r) => a + (r.phase?.success  ?? 0), 0);
  const totalSkipped = rows.reduce((a, r) => a + (r.phase?.skipped  ?? 0), 0);
  const totalFailed  = rows.reduce((a, r) => a + (r.phase?.failed   ?? 0), 0);
  const totalRecords = rows.reduce((a, r) => a + (r.phase?.total    ?? 0), 0);
  const anyRun       = rows.some(r => !!r.phase);

  return (
    <div className="hist-wrap">
      <div className="hist-header">
        <div className="hist-header__text">
          <h2 className="hist-header__title">Migration History</h2>
          <p className="hist-header__sub">Last completed run per entity</p>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={() => {
          setLoading(true);
          getMigrationStatus()
            .then(({ phases: p }) => { setPhases(p); setLoading(false); })
            .catch(err => { setError(err.message); setLoading(false); });
        }}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          </svg>
          Refresh
        </button>
      </div>

      {loading && (
        <div className="hist-state">
          <div className="hist-spinner" />
          <span>Loading migration history…</span>
        </div>
      )}

      {!loading && error && (
        <div className="hist-state hist-state--error">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && !anyRun && (
        <div className="hist-state">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color:'var(--text-3)' }}>
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <b>No migrations run yet</b>
          <span>Push at least one entity to see history here.</span>
        </div>
      )}

      {!loading && !error && anyRun && (
        <div className="hist-card card">
          <table className="hist-table">
            <thead>
              <tr>
                <th className="hist-th hist-th--name">Entity</th>
                <th className="hist-th">Status</th>
                <th className="hist-th hist-th--num">Total</th>
                <th className="hist-th hist-th--num">Pushed</th>
                <th className="hist-th hist-th--num">Skipped</th>
                <th className="hist-th hist-th--num">Failed</th>
                <th className="hist-th hist-th--dur">Duration</th>
                <th className="hist-th hist-th--date">Last Run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ id, name, phase }) => (
                <tr key={id} className={`hist-tr${phase ? '' : ' hist-tr--idle'}`}>
                  <td className="hist-td hist-td--name">
                    <button
                      className="hist-ent-link"
                      onClick={() => navigate(`/${workflow}/entity/${id}`)}
                    >
                      {name}
                    </button>
                  </td>
                  <td className="hist-td">
                    <StatusBadge status={phase?.status ?? 'IDLE'} />
                  </td>
                  <td className="hist-td hist-td--num">{phase ? phase.total.toLocaleString() : '—'}</td>
                  <td className="hist-td hist-td--num">
                    {phase ? (
                      <span className={phase.success > 0 ? 'hist-num--green' : ''}>
                        {phase.success.toLocaleString()}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="hist-td hist-td--num">
                    {phase ? (
                      <span className={phase.skipped > 0 ? 'hist-num--muted' : ''}>
                        {phase.skipped.toLocaleString()}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="hist-td hist-td--num">
                    {phase ? (
                      phase.failed > 0
                        ? <button className="hist-fail-link" onClick={() => navigate(`/${workflow}/entity/${id}`)}>
                            {phase.failed.toLocaleString()}
                          </button>
                        : <span>0</span>
                    ) : '—'}
                  </td>
                  <td className="hist-td hist-td--dur">
                    {phase ? fmtDur(phase.durationMs) : '—'}
                  </td>
                  <td className="hist-td hist-td--date">
                    {phase ? fmtDate(phase.completedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="hist-tr hist-tr--total">
                <td className="hist-td hist-td--name"><b>Total</b></td>
                <td className="hist-td" />
                <td className="hist-td hist-td--num"><b>{totalRecords.toLocaleString()}</b></td>
                <td className="hist-td hist-td--num"><b className="hist-num--green">{totalPushed.toLocaleString()}</b></td>
                <td className="hist-td hist-td--num"><b className="hist-num--muted">{totalSkipped.toLocaleString()}</b></td>
                <td className="hist-td hist-td--num">
                  <b className={totalFailed > 0 ? 'hist-num--red' : ''}>{totalFailed.toLocaleString()}</b>
                </td>
                <td className="hist-td hist-td--dur" />
                <td className="hist-td hist-td--date" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
