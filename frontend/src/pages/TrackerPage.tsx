import { useState, Fragment } from 'react';
import type { Issue } from '../data/entities';
import { countIssues, issuesFor, templateFor } from '../data/entities';
import { CatIconMini, Badge } from '../components/CatIcon';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useMigration, DEPS } from '../context/MigrationContext';
import type { SkippedRow } from '../lib/api';

function downloadErrorSheet(entityId: string, entityName: string, errors: Array<{ row: number; error: string }>) {
  const cols   = templateFor(entityId);
  const header = ['error_row', 'error_message', ...cols.map(c => c.col)];
  const rows   = errors.map(e => [String(e.row), e.error, ...cols.map(() => '')]);
  const csv    = [header, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `${entityId}_errors.csv`,
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  void entityName;
}

function downloadSkippedSheet(entityId: string, skippedRows: SkippedRow[]) {
  if (!skippedRows.length) return;
  const payloadKeys = Array.from(new Set(skippedRows.flatMap(s => Object.keys(s.payload))));
  const header = ['skipped_row', 'skip_reason', ...payloadKeys];
  const rows   = skippedRows.map(s => [
    String(s.row),
    s.reason,
    ...payloadKeys.map(k => String(s.payload[k] ?? '')),
  ]);
  const csv = [header, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `${entityId}_skipped.csv`,
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

export default function TrackerPage() {
  const { workflow = 'qbd' } = useParams<{ workflow: string }>();
  const navigate  = useNavigate();
  const location  = useLocation();
  const { toast } = useToast();
  const { entities, pushMap, resultMap, pushEntity, runAll, sessionPushed } = useMigration();

  const [search,   setSearch]   = useState('');
  const [filter,   setFilter]   = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-start push when navigated here from UploadPage "Push" button
  const initNav = (location.state as { run?: string; ids?: string[]; startedAt?: number } | null);
  const autoStarted = { current: false };
  if (initNav?.ids?.length && !autoStarted.current) {
    autoStarted.current = true;
    navigate(location.pathname, { replace: true, state: null });
    if (initNav.run === 'all') {
      runAll().then(() => toast('success', 'Migration complete', 'All entities pushed to FreshBooks.'));
    } else {
      const selected = new Set(initNav.ids!);
      const scheduled: Record<string, Promise<void>> = {};
      const scheduleSelected = (id: string): Promise<void> => {
        if (scheduled[id]) return scheduled[id];
        const deps = (DEPS[id] || []).filter(d => selected.has(d));
        scheduled[id] = Promise.all(deps.map(scheduleSelected)).then(() => pushEntity(id));
        return scheduled[id];
      };
      Promise.all([...selected].map(id => scheduleSelected(id)));
    }
  }

  function toggleExpand(id: string) {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const hasRunning = entities.some(e => e.status === 'running');

  const q = search.toLowerCase();
  const rows = entities.filter(e => {
    const st = e.status === 'testing' ? 'idle' : e.status;
    if (filter !== 'all' && st !== filter) return false;
    if (q && !e.name.toLowerCase().includes(q)) return false;
    return true;
  });

  let tp = 0, ts = 0, tf = 0;
  rows.forEach(e => { tp += e.pushed; ts += e.skipped; tf += e.failed; });

  return (
    <div>
      <div className="page-head">
        <h2>Migration Tracker</h2>
        <div className="right">
          <button
            className={`btn btn--primary${hasRunning ? '' : ' btn--pulse'}`}
            onClick={() => runAll().then(() => toast('success', 'Migration complete', 'All entities pushed to FreshBooks.'))}
            disabled={hasRunning}
          >
            {hasRunning
              ? <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin .7s linear infinite' }}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Running…</>
              : <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run All</>
            }
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-search">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder="Search entities…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="select" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="done">Done</option>
          <option value="idle">Idle</option>
          <option value="running">Running</option>
          <option value="error">Error</option>
        </select>
      </div>

      {rows.length > 0 && (
        <div className="trk-summary">
          <div className="trk-summary__stat">
            <span className="trk-summary__num n-green">{tp.toLocaleString()}</span>
            <span className="trk-summary__lbl">Pushed</span>
          </div>
          <div className="trk-summary__divider" />
          <div className="trk-summary__stat">
            <span className="trk-summary__num n-muted">{ts.toLocaleString()}</span>
            <span className="trk-summary__lbl">Skipped</span>
          </div>
          <div className="trk-summary__divider" />
          <div className="trk-summary__stat">
            <span className={`trk-summary__num ${tf ? 'n-red' : 'n-muted'}`}>{tf.toLocaleString()}</span>
            <span className="trk-summary__lbl">Failed</span>
          </div>
          <div className="trk-summary__divider" />
          <div className="trk-summary__stat">
            <span className="trk-summary__num">{rows.length}</span>
            <span className="trk-summary__lbl">Entities</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="tbl-tracker-wrap">
          <table className="tbl-tracker">
            <thead>
              <tr>
                <th className="tbl-th tbl-th--entity">Entity</th>
                <th className="tbl-th">Status</th>
                <th className="tbl-th tbl-th--num">Pushed</th>
                <th className="tbl-th tbl-th--num">Skipped</th>
                <th className="tbl-th tbl-th--num">Failed</th>
                <th className="tbl-th">Issues</th>
                <th className="tbl-th">Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, idx) => {
                const ps           = pushMap[e.id];
                const realRes      = resultMap[e.id];
                const isExp        = expanded.has(e.id);
                const c            = countIssues(e.id);
                const realErrCount     = realRes?.errors?.length ?? 0;
                const realSkippedCount = realRes?.skipped_rows?.length ?? 0;
                const totalErrors      = realErrCount || c.err;
                const hasExpandable    = totalErrors > 0 || c.warn > 0 || e.failed > 0 || realSkippedCount > 0;
                const isActive     = e.status === 'done' || e.status === 'error' || e.status === 'running';
                const isResumedFromDB = e.status === 'running' && !sessionPushed.has(e.id);


                return (
                  <Fragment key={e.id}>
                    <tr
                      className={`tbl-tr tbl-tr--${e.status}`}
                      style={{ '--row-idx': idx } as React.CSSProperties}
                      onClick={() => navigate(`/${workflow}/entity/${e.id}`)}
                      title={`Open ${e.name}`}
                    >
                      <td className="tbl-td">
                        <div className="tbl-ent">
                          <CatIconMini cat={e.cat} />
                          <span className="tbl-ent__name">{e.name}</span>
                        </div>
                      </td>

                      <td className="tbl-td">
                        <div className="tbl-status-cell">
                          <Badge status={e.status === 'testing' ? 'idle' : e.status} />
                          {isResumedFromDB && (
                            <span className="tbl-resumed-tag" title="Running from a previous session">prev session</span>
                          )}
                        </div>
                      </td>

                      <td className="tbl-td tbl-td--num">
                        {e.status === 'running' && ps
                          ? <span className="tbl-num tbl-num--pushed">
                              {ps.done.toLocaleString()}
                              <span className="tbl-num-total"> / {ps.total.toLocaleString()}</span>
                            </span>
                          : isActive
                            ? <span className="tbl-num tbl-num--pushed">{e.pushed.toLocaleString()}</span>
                            : <span className="tbl-dash">—</span>
                        }
                      </td>

                      <td className="tbl-td tbl-td--num">
                        {(e.status === 'done' || e.status === 'error') && e.skipped > 0
                          ? <span className="tbl-num tbl-num--skipped">{e.skipped.toLocaleString()}</span>
                          : <span className="tbl-dash">—</span>
                        }
                      </td>

                      <td className="tbl-td tbl-td--num">
                        {(e.status === 'done' || e.status === 'error') && e.failed > 0
                          ? <span className="tbl-num tbl-num--failed">{e.failed.toLocaleString()}</span>
                          : <span className="tbl-dash">—</span>
                        }
                      </td>

                      <td className="tbl-td" onClick={e2 => { if (hasExpandable) { e2.stopPropagation(); toggleExpand(e.id); } }}>
                        {(e.status === 'done' || e.status === 'error')
                          ? totalErrors > 0
                            ? <button className={`tbl-issues-pill tbl-issues-pill--err tbl-issues-pill--btn${isExp ? ' open' : ''}`}>
                                {totalErrors} err
                                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="tbl-issues-chev"><polyline points="6 9 12 15 18 9"/></svg>
                              </button>
                            : realSkippedCount > 0
                              ? <button className={`tbl-issues-pill tbl-issues-pill--warn tbl-issues-pill--btn${isExp ? ' open' : ''}`}>
                                  {realSkippedCount} skipped
                                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="tbl-issues-chev"><polyline points="6 9 12 15 18 9"/></svg>
                                </button>
                              : c.warn > 0
                                ? <button className={`tbl-issues-pill tbl-issues-pill--warn tbl-issues-pill--btn${isExp ? ' open' : ''}`}>
                                    {c.warn} warn
                                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="tbl-issues-chev"><polyline points="6 9 12 15 18 9"/></svg>
                                  </button>
                                : <span className="tbl-issues-ok">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                  </span>
                          : <span className="tbl-dash">—</span>
                        }
                      </td>

                      <td className="tbl-td">
                        {e.status === 'running'
                          ? <span className="tbl-dur-running">
                              <svg className="tbl-spin-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="9" strokeOpacity=".2"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>
                            </span>
                          : e.dur && e.dur !== '-' && e.dur !== '–'
                            ? <span className="tbl-dur">{e.dur}</span>
                            : <span className="tbl-dash">—</span>
                        }
                      </td>
                    </tr>

                    {e.status === 'running' && ps && (
                      <tr className="tbl-prog-row" aria-hidden="true">
                        <td colSpan={7} className="tbl-prog-td">
                          <div className="tbl-prog-fill" style={{ width: `${ps.pct}%` }}>
                            <div className="tbl-prog-shimmer" />
                          </div>
                        </td>
                      </tr>
                    )}

                    {isExp && (
                      <tr className="tbl-exp-row" onClick={e2 => e2.stopPropagation()}>
                        <td colSpan={7}>
                          <div className="tbl-exp-inner">
                            <ExpandBody
                              e={e}
                              realErrors={realRes?.errors}
                              skippedRows={realRes?.skipped_rows}
                              onDownload={errs => downloadErrorSheet(e.id, e.name, errs)}
                              onDownloadSkipped={rows => downloadSkippedSheet(e.id, rows)}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="trk-list__empty">No entities match.</div>}
        </div>
      </div>
    </div>
  );
}

function ExpandBody({ e, realErrors, skippedRows, onDownload, onDownloadSkipped }: {
  e: { id: string; name: string };
  realErrors?: Array<{ row: number; error: string }>;
  skippedRows?: SkippedRow[];
  onDownload: (errors: Array<{ row: number; error: string }>) => void;
  onDownloadSkipped: (rows: SkippedRow[]) => void;
}) {
  const dlIcon = <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;

  if (realErrors !== undefined) {
    const hasErrors   = realErrors.length > 0;
    const hasSkipped  = (skippedRows?.length ?? 0) > 0;

    if (!hasErrors && !hasSkipped) return <div className="exp-clean">✓ All records migrated — no errors or skips.</div>;

    return (
      <>
        {hasErrors && (
          <>
            <div className="exp-head">
              <div className="exp-head__left">
                <span className="exp-head__count">{realErrors.length} failed row{realErrors.length > 1 ? 's' : ''}</span>
                <span className="exp-head__hint">Fix the errors, re-upload the corrected sheet and run again.</span>
              </div>
              <button className="btn btn--sm btn--ghost exp-dl-btn" onClick={() => onDownload(realErrors)}>
                {dlIcon} Download Error Sheet
              </button>
            </div>
            <div className="exp-list">
              {realErrors.map((it, i) => (
                <div key={i} className="exp-issue exp-issue--error">
                  <div className="exp-sev">✕</div>
                  <div className="exp-body">
                    <div className="exp-row-lbl">Row {it.row}</div>
                    <div className="exp-msg">{it.error}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {hasSkipped && (
          <>
            <div className="exp-head" style={hasErrors ? { marginTop: '12px' } : undefined}>
              <div className="exp-head__left">
                <span className="exp-head__count">{skippedRows!.length} skipped row{skippedRows!.length > 1 ? 's' : ''}</span>
                <span className="exp-head__hint">These rows were not created — download to review and re-upload.</span>
              </div>
              <button className="btn btn--sm btn--ghost exp-dl-btn" onClick={() => onDownloadSkipped(skippedRows!)}>
                {dlIcon} Download Skipped Sheet
              </button>
            </div>
            <div className="exp-list">
              {skippedRows!.map((it, i) => (
                <div key={i} className="exp-issue exp-issue--warn">
                  <div className="exp-sev">⚡</div>
                  <div className="exp-body">
                    <div className="exp-row-lbl">Row {it.row}</div>
                    <div className="exp-msg">{it.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  const issues: Issue[] = issuesFor(e.id);
  if (!issues.length) return <div className="exp-clean">✓ No issues — entity is clean.</div>;
  const errIssues = issues.filter(i => i.sev === 'error');
  return (
    <>
      <div className="exp-head">
        <div className="exp-head__left">
          <span className="exp-head__count">{issues.length} issue{issues.length > 1 ? 's' : ''}</span>
          <span className="exp-head__hint">Fix the errors, re-upload the corrected sheet and run again.</span>
        </div>
        {errIssues.length > 0 && (
          <button className="btn btn--sm btn--ghost exp-dl-btn"
            onClick={() => onDownload(errIssues.map(i => ({ row: i.row, error: `[${i.field}] ${i.msg}` })))}>
            {dlIcon} Download Error Sheet
          </button>
        )}
      </div>
      <div className="exp-list">
        {issues.map((it, i) => (
          <div key={i} className={`exp-issue exp-issue--${it.sev}`}>
            <div className="exp-sev">{it.sev === 'error' ? '✕' : '⚠'}</div>
            <div className="exp-body">
              <div className="exp-row-lbl">Row {it.row} · <span className="exp-field">{it.field}</span></div>
              <div className="exp-msg">{it.msg}</div>
              <div className="exp-fix">Fix: {it.fix}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
