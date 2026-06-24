import { useState } from 'react';
import type { ExcelDryRunReport } from '../lib/api';
import { downloadErrorSheet } from '../lib/api';

interface Props {
  reports: ExcelDryRunReport[];
  onClose: () => void;
}

function countIssues(reports: ExcelDryRunReport[]) {
  return reports.reduce((acc, report) => {
    acc.errors   += report.issues.filter(i => i.sev === 'error').length;
    acc.warnings += report.issues.filter(i => i.sev === 'warning').length;
    acc.records  += report.total;
    return acc;
  }, { errors: 0, warnings: 0, records: 0 });
}

const IconError = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
  </svg>
);
const IconWarn = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);
const IconCheck = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

function EntityDetailModal({ report, onBack }: { report: ExcelDryRunReport; onBack: () => void }) {
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');
  const errors   = report.issues.filter(i => i.sev === 'error');
  const warnings = report.issues.filter(i => i.sev === 'warning');
  const shown    = filter === 'all' ? report.issues : filter === 'error' ? errors : warnings;

  return (
    <div className="overlay show" style={{ zIndex: 310 }}>
      <div className="modal dry-box" style={{ maxWidth: 680 }}>
        <div className="modal__body" style={{ paddingBottom: 0 }}>

          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:18 }}>
            <button
              onClick={onBack}
              style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:8,
                border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text-2)',
                fontSize:13, fontWeight:600, cursor:'pointer', flexShrink:0 }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Back
            </button>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:16, fontWeight:700, color:'var(--text-1)' }}>{report.name}</div>
              <div style={{ fontSize:12, color:'var(--text-3)', marginTop:2 }}>
                {report.file} &middot; {report.total.toLocaleString()} rows &middot; {report.columns.slice(0,5).join(', ')}{report.columns.length > 5 ? ` +${report.columns.length - 5} more` : ''}
              </div>
            </div>
          </div>

          {/* Filter tabs */}
          <div style={{ display:'flex', gap:6, marginBottom:14 }}>
            {(['all','error','warning'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding:'4px 12px', borderRadius:999, fontSize:12.5, fontWeight:600, cursor:'pointer',
                border: filter === f ? 'none' : '1px solid var(--border)',
                background: filter === f
                  ? (f === 'error' ? 'var(--error)' : f === 'warning' ? 'var(--warning)' : 'var(--blue)')
                  : 'var(--bg)',
                color: filter === f ? '#fff' : 'var(--text-2)',
              }}>
                {f === 'all'     ? `All (${report.issues.length})`  : ''}
                {f === 'error'   ? `Errors (${errors.length})`      : ''}
                {f === 'warning' ? `Warnings (${warnings.length})`  : ''}
              </button>
            ))}
          </div>

          {/* Issue list */}
          <div style={{ maxHeight:'52vh', overflowY:'auto', display:'flex', flexDirection:'column', gap:8 }}>
            {shown.length === 0 ? (
              <div style={{ textAlign:'center', padding:'32px 0', color:'var(--text-3)', fontSize:13 }}>
                No {filter === 'all' ? 'issues' : filter + 's'} found.
              </div>
            ) : shown.map((it, i) => (
              <div key={i} className={`issue issue--${it.sev}`}>
                <div className="issue__sev">
                  {it.sev === 'error' ? <IconError /> : <IconWarn />}
                </div>
                <div className="issue__body">
                  <div className="issue__top">
                    <span className="issue__row">{it.row > 0 ? `Row ${it.row}` : 'File'}</span>
                    {it.field && <span className="issue__field">{it.field}</span>}
                    {it.value && it.value !== '' && <span className="issue__val">"{it.value}"</span>}
                  </div>
                  <div className="issue__msg">{it.msg}</div>
                  {it.fix && <div className="issue__fix">Fix: {it.fix}</div>}
                </div>
              </div>
            ))}
          </div>

        </div>
        <div className="modal__foot">
          <div style={{ flex:1, fontSize:12, color:'var(--text-3)', alignSelf:'center' }}>
            {shown.length} issue{shown.length !== 1 ? 's' : ''} shown
          </div>
          {report.issues.some(i => i.row >= 2) && (
            <button
              className="btn btn--outline"
              style={{ flex:'0 0 180px', marginRight:8 }}
              onClick={() => downloadErrorSheet(report.entityId)}
            >
              Download Error Sheet
            </button>
          )}
          <button className="btn btn--primary" style={{ flex:'0 0 120px' }} onClick={onBack}>Back</button>
        </div>
      </div>
    </div>
  );
}

export default function ExcelDryRunModal({ reports, onClose }: Props) {
  const [detail, setDetail] = useState<ExcelDryRunReport | null>(null);
  const totals    = countIssues(reports);
  const valid     = Math.max(0, totals.records - totals.errors);
  const hasIssues = totals.errors > 0 || totals.warnings > 0;

  return (
    <>
      <div className="overlay show" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal dry-box">
          <div className="modal__body" style={{ paddingBottom: 0 }}>

            {/* Header */}
            <div style={{ textAlign:'center', marginBottom:20 }}>
              <h3 style={{ fontSize:20, fontWeight:700, marginBottom:6 }}>Excel Dry Run</h3>
              <p style={{ fontSize:13, color:'var(--text-3)', margin:0 }}>
                No data was written to FreshBooks — these checks are from your uploaded files.
              </p>
            </div>

            {/* Stats */}
            <div className="dry-summary">
              <div className="dry-stat ok">
                <b>{valid.toLocaleString()}</b>
                <span>Rows ready</span>
              </div>
              <div className="dry-stat warn">
                <b>{totals.warnings}</b>
                <span>Warnings</span>
              </div>
              <div className="dry-stat err">
                <b>{totals.errors}</b>
                <span>Blocked</span>
              </div>
            </div>

            {/* Verdict banner */}
            <div className={`dry-verdict ${totals.errors > 0 ? 'blocked' : totals.warnings > 0 ? 'warn' : 'clean'}`}>
              <span className="dry-verdict__icon">
                {totals.errors > 0 ? <IconError /> : totals.warnings > 0 ? <IconWarn /> : <IconCheck />}
              </span>
              <div>
                <b>
                  {totals.errors > 0
                    ? 'Fix blocked rows before pushing'
                    : totals.warnings > 0
                      ? 'Review warnings before pushing'
                      : 'All uploaded files are ready to push'}
                </b>
                <p style={{ margin:'3px 0 0' }}>
                  {totals.errors > 0
                    ? 'Missing or invalid required columns will be rejected by FreshBooks.'
                    : totals.warnings > 0
                      ? "Warnings won't block migration but may produce unexpected results."
                      : `${reports.length} ${reports.length === 1 ? 'entity' : 'entities'} checked — required columns all present.`}
                </p>
              </div>
            </div>

            {/* Entity list — click row to open detail */}
            <div className="dry-list">
              {reports.map(report => {
                const errors   = report.issues.filter(i => i.sev === 'error').length;
                const warnings = report.issues.filter(i => i.sev === 'warning').length;
                const clean    = errors === 0 && warnings === 0;
                const hasIssues = errors > 0 || warnings > 0;

                return (
                  <div
                    key={report.entityId}
                    className="dry-ent"
                    style={{ cursor: hasIssues ? 'pointer' : 'default' }}
                    onClick={() => hasIssues && setDetail(report)}
                  >
                    <div className="dry-ent__head">
                      <span className={`dry-ent__dot ${errors > 0 ? 'dot-err' : warnings > 0 ? 'dot-warn' : 'dot-ok'}`} />
                      <span className="dry-ent__name">{report.name}</span>
                      <span className="dry-ent__counts">
                        <span className="mini-badge g">{report.total.toLocaleString()} rows</span>
                        {errors   > 0 && <span className="mini-badge e">{errors} error{errors > 1 ? 's' : ''}</span>}
                        {warnings > 0 && <span className="mini-badge w">{warnings} warn</span>}
                        {clean        && <span className="mini-badge ok">✓ clean</span>}
                      </span>
                      {hasIssues && (
                        <span className="dry-ent__chev">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 18l6-6-6-6"/>
                          </svg>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

          </div>

          <div className="modal__foot">
            {hasIssues && (
              <div style={{ flex:1, fontSize:12, color:'var(--text-3)', alignSelf:'center' }}>
                {reports.length} {reports.length === 1 ? 'entity' : 'entities'} checked &middot; {totals.records.toLocaleString()} total rows
              </div>
            )}
            <button className="btn btn--primary" style={{ flex:'0 0 160px' }} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>

      {detail && (
        <EntityDetailModal report={detail} onBack={() => setDetail(null)} />
      )}
    </>
  );
}
