import { useState, useEffect, useRef } from 'react';
import type { Entity } from '../data/entities';
import { issuesFor, countIssues } from '../data/entities';
import { useToast } from '../context/ToastContext';

interface Props { entities: Entity[]; onClose: () => void; }

export default function DryRunModal({ entities, onClose }: Props) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<'scan' | 'result'>('scan');
  const [pct, setPct] = useState(0);
  const [nowText, setNowText] = useState('Starting dry run — nothing is written to FreshBooks');
  const [openEnt, setOpenEnt] = useState<string | null>(entities[0]?.id || null);
  const intervalRef = useRef<number | null>(null);
  const C = 276.5;

  useEffect(() => {
    setPct(0); setPhase('scan'); setNowText('Starting dry run…');
    let cur = 0;
    intervalRef.current = window.setInterval(() => {
      cur = Math.min(100, cur + Math.random() * 16 + 6);
      setPct(Math.round(cur));
      const ni = Math.min(entities.length - 1, Math.floor(cur / 100 * entities.length));
      setNowText(`Validating ${entities[ni]?.name}…`);
      if (cur >= 100) {
        clearInterval(intervalRef.current!);
        setTimeout(() => setPhase('result'), 360);
      }
    }, 230);
    return () => clearInterval(intervalRef.current!);
  }, [entities]);

  let totalErr = 0, totalWarn = 0, totalRecords = 0;
  entities.forEach(e => {
    const c = countIssues(e.id);
    totalErr += c.err; totalWarn += c.warn;
    totalRecords += (e.pushed + e.skipped + e.failed) || 0;
  });
  const valid = Math.max(0, totalRecords - totalErr - totalWarn);

  function proceed() {
    onClose();
    toast('info', 'Migration started', 'Pushing valid records to FreshBooks…');
    setTimeout(() => toast('success', 'Migration complete', 'Valid records pushed · blocked rows skipped'), 1700);
  }

  return (
    <div className="overlay show" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dry-box">
        {phase === 'scan' ? (
          <div className="dry-scan">
            <div className="dry-scan__ring">
              <svg viewBox="0 0 100 100">
                <circle className="track" cx="50" cy="50" r="44" fill="none" stroke="var(--blue-light)" strokeWidth="7"/>
                <circle cx="50" cy="50" r="44" fill="none" stroke="var(--blue)" strokeWidth="7" strokeLinecap="round"
                  strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} style={{ transition: 'stroke-dashoffset .2s linear' }}/>
              </svg>
              <div className="dry-scan__pct" style={{ position:'absolute',inset:0,display:'grid',placeItems:'center',fontSize:20,fontWeight:800,color:'var(--blue-hover)',letterSpacing:'-.5px' }}>{pct}%</div>
            </div>
            <h3>Validating records…</h3>
            <div className="now">{nowText}</div>
          </div>
        ) : (
          <>
            <div className="modal__body" style={{ paddingBottom: 0 }}>
              <h3 style={{ textAlign:'center' }}>
                {entities.length === 1 ? `Dry run · ${entities[0].name}` : `Dry run · ${entities.length} entities`}
              </h3>
              <p style={{ textAlign:'center' }}>No data was written to FreshBooks. Review and fix issues below, then migrate.</p>

              <div className="dry-summary">
                <div className="dry-stat ok"><b>{valid.toLocaleString()}</b><span>Will migrate</span></div>
                <div className="dry-stat warn"><b>{totalWarn}</b><span>Warnings</span></div>
                <div className="dry-stat err"><b>{totalErr}</b><span>Blocked</span></div>
              </div>

              <div className={`dry-verdict ${totalErr > 0 ? 'blocked' : totalWarn > 0 ? 'warn' : 'clean'}`}>
                {totalErr > 0 ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <div><b>{totalErr} record{totalErr > 1 ? 's are' : ' is'} blocked from migrating</b><p>Fix the errors below first. Records with errors are skipped — everything else can still go through.</p></div>
                  </>
                ) : totalWarn > 0 ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <div><b>No blocking errors — {totalWarn} warning{totalWarn > 1 ? 's' : ''} to review</b><p>Warnings won't stop the migration, but affected rows may be skipped or defaulted.</p></div>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    <div><b>All clear — ready to migrate</b><p>Every record passed validation. You're safe to push to FreshBooks.</p></div>
                  </>
                )}
              </div>

              <div className="dry-list">
                {entities.map(e => {
                  const list = issuesFor(e.id);
                  const c = countIssues(e.id);
                  const isOpen = openEnt === e.id;
                  return (
                    <div key={e.id} className={`dry-ent${isOpen ? ' open' : ''}`}>
                      <div className="dry-ent__head" onClick={() => setOpenEnt(isOpen ? null : e.id)}>
                        <span className="dry-ent__name">{e.name}</span>
                        <span className="dry-ent__counts">
                          {c.err > 0 && <span className="mini-badge e">{c.err} error{c.err > 1 ? 's' : ''}</span>}
                          {c.warn > 0 && <span className="mini-badge w">{c.warn} warn</span>}
                          {!c.err && !c.warn && <span className="mini-badge g">clean</span>}
                        </span>
                        <span className="dry-ent__chev">
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        </span>
                      </div>
                      {isOpen && (
                        <div className="dry-ent__body">
                          {list.length === 0
                            ? <div style={{ fontSize:'12.5px',color:'var(--text-3)',padding:'8px 0' }}>No issues found for {e.name}.</div>
                            : list.map((it, i) => (
                              <div key={i} className={`issue issue--${it.sev}`} style={{ marginTop: 8 }}>
                                <div className="issue__sev">
                                  {it.sev === 'error'
                                    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                                  }
                                </div>
                                <div className="issue__body">
                                  <div className="issue__top">
                                    <span className="issue__row">Row {it.row}</span>
                                    <span className="issue__field">{it.field}</span>
                                  </div>
                                  <div className="issue__msg">{it.msg}</div>
                                  <div className="issue__fix">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                    <span>{it.fix}</span>
                                  </div>
                                </div>
                              </div>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal__foot">
              <button className="btn btn--ghost" onClick={onClose}>Close</button>
              <button className="btn btn--primary" onClick={proceed}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                {totalErr > 0 ? `Migrate ${valid.toLocaleString()} valid records` : 'Migrate all'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
