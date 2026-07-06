import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { downloadStyledTemplate } from '../lib/templateExcel';
import { useMigration, DEPS } from '../context/MigrationContext';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { CatIcon, Badge } from '../components/CatIcon';
import { templateFor } from '../data/entities';
import { uploadExcelFile, dryRunExcel, fbDeleteById, fbBulkDelete, fbBulkUpdate, fbExportEntity } from '../lib/api';
import type { ExcelDryRunReport, BulkOpResult } from '../lib/api';

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

export default function EntityPage() {
  const { entityId, workflow = 'excel' } = useParams<{ entityId: string; workflow: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { entities, pushMap, resultMap, pushEntity, cancelEntity, canPush, startTimes, sessionPushed, statusChecked } = useMigration();
  const { fbConnected, uploaded, setUploaded } = useApp();
  const { toast } = useToast();

  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryReport, setDryReport] = useState<ExcelDryRunReport | null>(null);
  const [errExp, setErrExp] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadAreaRef = useRef<HTMLDivElement>(null);

  const [activePanel, setActivePanel] = useState<'upload' | 'update' | 'delete' | null>(null);

  const entity = entities.find(e => e.id === entityId);

  // Tick every 500 ms while running so elapsed time updates
  useEffect(() => {
    if (entity?.status !== 'running') return;
    const iv = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(iv);
  }, [entity?.status]);

  // Handle ?action= from sidebar nav
  useEffect(() => {
    const action = searchParams.get('action');
    if (!action) return;
    setSearchParams({}, { replace: true });
    if (action === 'upload') {
      setActivePanel('upload');
      setTimeout(() => uploadAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } else if (action === 'update') {
      setActivePanel('update');
    } else if (action === 'delete') {
      setActivePanel('delete');
    }
  }, [searchParams]);

  if (!entity) {
    navigate(`/${workflow}/tracker`, { replace: true });
    return null;
  }

  const ps       = pushMap[entity.id];
  const realRes  = resultMap[entity.id];
  const fileInfo = uploaded[entity.id];
  const { ok: depsOk, missing } = canPush(entity.id);

  const depList = (DEPS[entity.id] || []).map(depId => ({
    id: depId, dep: entities.find(x => x.id === depId),
  }));

  const startT  = startTimes[entity.id];
  const elapsed = startT && entity.status === 'running'
    ? `${((Date.now() - startT) / 1000).toFixed(1)}s` : null;

  const canGo = fbConnected && depsOk && statusChecked
    && (workflow !== 'excel' || !!fileInfo)
    && entity.status !== 'running';

  // ── file upload ────────────────────────────────────────────────────────────
  async function acceptFile(file: File) {
    if (!fbConnected) {
      toast('warning', 'Connect FreshBooks first', '');
      navigate(`/${workflow}/connect`); return;
    }
    try {
      setUploading(true);
      if (workflow === 'excel') {
        const r = await uploadExcelFile(entity.id, file);
        setUploaded(prev => ({ ...prev, [entity.id]: { name: file.name, size: fmtSize(file.size), rows: r.total, savedAs: r.savedAs || r.file } }));
        setDryReport(null);
        toast('success', 'File ready', `${entity.name}: ${r.total.toLocaleString()} rows loaded.`);
      } else {
        setUploaded(prev => ({ ...prev, [entity.id]: { name: file.name, size: fmtSize(file.size) } }));
        toast('success', 'File ready', file.name);
      }
    } catch (err: any) {
      toast('error', 'Upload failed', err.message);
    } finally { setUploading(false); }
  }

  function removeFile() {
    const u = { ...uploaded }; delete u[entity.id]; setUploaded(u); setDryReport(null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0]; if (f) acceptFile(f);
  }

  // ── dry run ────────────────────────────────────────────────────────────────
  async function runDryRun() {
    try {
      setDryRunning(true);
      const [r] = await dryRunExcel([entity.id]);
      setDryReport(r);
    } catch (err: any) {
      toast('error', 'Dry run failed', err.message);
    } finally { setDryRunning(false); }
  }

  // ── cancel migration ──────────────────────────────────────────────────────
  async function handleCancel() {
    setCancelling(true);
    try { await cancelEntity(entity.id); } finally { setCancelling(false); }
  }

  // ── template download ──────────────────────────────────────────────────────
  function downloadTemplate() {
    const cols = templateFor(entity.id);
    downloadStyledTemplate(cols, `${entity.id}_template.xlsx`, entity.name);
    toast('success', 'Template downloaded', entity.name);
  }

  // ── error sheet download ───────────────────────────────────────────────────
  function dlErrors() {
    if (!realRes?.errors?.length) return;
    const cols   = templateFor(entity.id);
    const header = ['error_row', 'error_message', ...cols.map(c => c.col)];
    const rows   = realRes.errors.map(e => [String(e.row), e.error, ...cols.map(() => '')]);
    const csv    = [header, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `${entity.id}_errors.csv`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  const spinIcon = (
    <svg className="ep-spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".2"/>
      <path d="M12 3a9 9 0 0 1 9 9"/>
    </svg>
  );

  return (
    <div className="ep-wrap">

      {/* ── header ── */}
      <div className="ep-header card">
        <CatIcon cat={entity.cat} size={40} />
        <div className="ep-header__text">
          <h2 className="ep-header__name">{entity.name}</h2>
          <span className="ep-header__cat">{entity.cat}</span>
        </div>
        <div className="ep-header__actions">
          <button
            className={`ep-hdr-btn ep-hdr-btn--upload${activePanel === 'upload' ? ' active' : ''}`}
            onClick={() => {
              setActivePanel(p => p === 'upload' ? null : 'upload');
              setTimeout(() => uploadAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
            }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload
          </button>
          <button
            className={`ep-hdr-btn ep-hdr-btn--update${activePanel === 'update' ? ' active' : ''}`}
            onClick={() => setActivePanel(p => p === 'update' ? null : 'update')}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Update
          </button>
          <button
            className={`ep-hdr-btn ep-hdr-btn--delete${activePanel === 'delete' ? ' active' : ''}`}
            onClick={() => setActivePanel(p => p === 'delete' ? null : 'delete')}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            Delete
          </button>
        </div>
        <Badge status={entity.status === 'testing' || ((entity.status === 'done' || entity.status === 'error') && !sessionPushed.has(entity.id)) ? 'idle' : entity.status} />
      </div>

      {/* ── inline update panel ── */}
      {activePanel === 'update' && (
        <UpdatePanel entity={entity} toast={toast} onClose={() => setActivePanel(null)} />
      )}

      {/* ── inline delete panel ── */}
      {activePanel === 'delete' && (
        <DeletePanel entity={entity} toast={toast} onClose={() => setActivePanel(null)} />
      )}

      {/* ── dependency chips ── */}
      {depList.length > 0 && (
        <div className="ep-deps">
          <span className="ep-deps__label">Requires</span>
          <div className="ep-deps__row">
            {depList.map(({ id, dep }) => (
              <button
                key={id}
                className={`ep-dep-chip ep-dep-chip--${dep?.status === 'done' ? 'done' : 'wait'}`}
                onClick={() => navigate(`/${workflow}/entity/${id}`)}
                title={dep?.status !== 'done' ? `Go to ${dep?.name}` : undefined}
              >
                {dep?.status === 'done'
                  ? <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  : <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="9"/></svg>
                }
                {dep?.name ?? id}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ep-steps">

        {/* ── step 1: upload ── */}
        {activePanel !== 'update' && activePanel !== 'delete' && <div className="ep-step card">
          <div className="ep-step__head">
            <span className="ep-step__num">1</span>
            <h3 className="ep-step__title">Upload Sheet</h3>
            <button className="btn btn--sm btn--ghost ep-tpl-btn" onClick={downloadTemplate}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Template
            </button>
          </div>
          <div className="ep-step__body">
            {!fileInfo
              ? <div
                  ref={uploadAreaRef}
                  className={`ep-drop${drag ? ' drag' : ''}${uploading ? ' ep-drop--uploading' : ''}`}
                  onClick={() => !uploading && fileRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={onDrop}
                >
                  {uploading
                    ? <>{spinIcon}<span>Uploading…</span></>
                    : <>
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        <b>Drop XLSX here</b>
                        <span>or <u style={{ color: 'var(--blue)', cursor: 'pointer' }}>click to browse</u></span>
                      </>
                  }
                  <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) acceptFile(f); e.target.value = ''; }} />
                </div>
              : <div className="ep-file-chip">
                  <div className="ep-file-chip__icon">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                  <div className="ep-file-chip__meta">
                    <b>{fileInfo.name}</b>
                    <span>{fileInfo.rows ? `${fileInfo.rows.toLocaleString()} rows · ` : ''}{fileInfo.size}</span>
                  </div>
                  <button className="ep-file-chip__rm" onClick={removeFile} title="Remove">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
            }
          </div>
        </div>}

        {/* ── step 2: dry run (excel only) ── */}
        {activePanel !== 'update' && activePanel !== 'delete' && workflow === 'excel' && (
          <div className={`ep-step card${!fileInfo ? ' ep-step--locked' : ''}`}>
            <div className="ep-step__head">
              <span className="ep-step__num">2</span>
              <h3 className="ep-step__title">Dry Run</h3>
              <span className="ep-step__sub">Validate before pushing</span>
            </div>
            <div className="ep-step__body">
              {!fileInfo
                ? <p className="ep-locked-hint">Upload a sheet first to validate it.</p>
                : !dryReport
                  ? <button className="btn btn--ghost btn--block" onClick={runDryRun} disabled={dryRunning}>
                      {dryRunning
                        ? <>{spinIcon} Scanning…</>
                        : <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Run Validation</>
                      }
                    </button>
                  : <DryRunSummary report={dryReport} onRerun={runDryRun} loading={dryRunning} />
              }
            </div>
          </div>
        )}

        {/* ── step 3: push ── */}
        {activePanel !== 'update' && activePanel !== 'delete' && <div className="ep-step card">
          <div className="ep-step__head">
            <span className="ep-step__num">{workflow === 'excel' ? '3' : '2'}</span>
            <h3 className="ep-step__title">Push to FreshBooks</h3>
          </div>
          <div className="ep-step__body">

            {/* dep lock warning */}
            {!depsOk && (
              <div className="ep-dep-warn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span>Complete <b>{missing.map(m => m.name).join(', ')}</b> first</span>
              </div>
            )}

            {/* push button — hidden while running */}
            {entity.status !== 'running' && (
              <button className="btn btn--fb btn--block" disabled={!canGo} onClick={() => pushEntity(entity.id)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Push to FreshBooks
              </button>
            )}

            {/* ── running state ── */}
            {entity.status === 'running' && (
              <div className="ep-run">
                {/* status pill + stop button row */}
                <div className="ep-run__status-row">
                  <div className="ep-run__status">
                    <svg className="ep-spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" strokeOpacity=".25"/>
                      <path d="M12 3a9 9 0 0 1 9 9"/>
                    </svg>
                    {cancelling ? 'Stopping…' : 'Running…'}
                  </div>
                  <button
                    className="ep-run__stop"
                    onClick={handleCancel}
                    disabled={cancelling}
                    title="Stop migration"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                    Stop
                  </button>
                </div>

                {/* counts row */}
                <div className="ep-run__counts">
                  {ps
                    ? <>
                        <span className="ep-run__done">{ps.done.toLocaleString()}</span>
                        <span className="ep-run__sep">/</span>
                        <span className="ep-run__total">{ps.total.toLocaleString()}</span>
                        <span className="ep-run__lbl">records</span>
                        {ps.pct > 0 && <span className="ep-run__pct">{ps.pct}%</span>}
                      </>
                    : <span className="ep-run__waiting">Starting…</span>
                  }
                  {elapsed && <span className="ep-run__elapsed">{elapsed} elapsed</span>}
                </div>

                {/* glittery progress bar */}
                <div className="ep-run__track">
                  {ps && ps.pct > 0
                    ? <div className="ep-run__fill" style={{ width: `${ps.pct}%` }}>
                        <div className="ep-run__shimmer" />
                        <div className="ep-run__glitter" />
                      </div>
                    : <div className="ep-run__fill ep-run__fill--indeterminate">
                        <div className="ep-run__shimmer" />
                        <div className="ep-run__glitter" />
                      </div>
                  }
                </div>
              </div>
            )}

            {/* result stats — only shown after a push in this session */}
            {(entity.status === 'done' || entity.status === 'error') && (entity.pushed + entity.failed) > 0 && sessionPushed.has(entity.id) && (
              <div className={`ep-result${entity.status === 'done' ? ' ep-result--complete' : ''}`}>
                <div className="ep-result__stat ep-result__stat--green">
                  <b>{entity.pushed.toLocaleString()}</b><span>Pushed</span>
                </div>
                {entity.failed > 0 && (
                  <div className="ep-result__stat ep-result__stat--red">
                    <b>{entity.failed.toLocaleString()}</b><span>Failed</span>
                  </div>
                )}
                {entity.skipped > 0 && (
                  <div className="ep-result__stat ep-result__stat--muted">
                    <b>{entity.skipped.toLocaleString()}</b><span>Skipped</span>
                  </div>
                )}
                {entity.dur && entity.dur !== '-' && entity.dur !== '–' && (
                  <div className="ep-result__stat ep-result__stat--muted">
                    <b>{entity.dur}</b><span>Duration</span>
                  </div>
                )}
              </div>
            )}

            {/* error rows — only shown after a push in this session */}
            {realRes?.errors && realRes.errors.length > 0 && sessionPushed.has(entity.id) && (
              <div className="ep-err-panel">
                <div className="ep-err-panel__head">
                  <button className={`ep-err-toggle${errExp ? ' open' : ''}`} onClick={() => setErrExp(v => !v)}>
                    <svg className="ep-err-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    {realRes.errors.length} failed row{realRes.errors.length > 1 ? 's' : ''}
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={dlErrors}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Download Error Sheet
                  </button>
                </div>
                {errExp && (
                  <div className="ep-err-list">
                    {realRes.errors.map((err, i) => (
                      <div key={i} className="ep-err-row">
                        <span className="ep-err-row__num">Row {err.row}</span>
                        <span className="ep-err-row__msg">{err.error}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>}

      </div>
    </div>
  );
}

// ── delete panel (inline) ─────────────────────────────────────────────────────
function DeletePanel({ entity, onClose, toast }: {
  entity: { id: string; name: string };
  onClose: () => void;
  toast: (t: string, title: string, msg: string) => void;
}) {
  const [tab, setTab]       = useState<'id' | 'bulk'>('id');
  const [recId, setRecId]   = useState('');
  const [busy, setBusy]     = useState(false);
  const [result, setResult] = useState<BulkOpResult | null>(null);

  async function handleDeleteById() {
    if (!recId.trim()) return;
    setBusy(true); setResult(null);
    try {
      await fbDeleteById(entity.id, recId.trim());
      toast('success', 'Deleted', `Record ${recId} removed from FreshBooks.`);
      setRecId('');
    } catch (err: any) {
      toast('error', 'Delete failed', err.message);
    } finally { setBusy(false); }
  }

  async function handleBulkDelete() {
    setBusy(true); setResult(null);
    try {
      const r = await fbBulkDelete(entity.id);
      setResult(r);
      toast(r.failed === 0 ? 'success' : 'warning', 'Bulk delete done', `${r.deleted} deleted, ${r.failed} failed.`);
    } catch (err: any) {
      toast('error', 'Bulk delete failed', err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="ep-panel ep-panel--delete card">
      <div className="ep-panel__head">
        <span className="ep-panel__title">Delete from FreshBooks</span>
        <div className="ep-panel__tabs">
          <button className={`ep-panel__tab${tab === 'id' ? ' active' : ''}`} onClick={() => { setTab('id'); setResult(null); }}>By ID</button>
          <button className={`ep-panel__tab${tab === 'bulk' ? ' active' : ''}`} onClick={() => { setTab('bulk'); setResult(null); }}>Delete All</button>
        </div>
        <button className="ep-panel__close" onClick={onClose}>✕</button>
      </div>
      <div className="ep-panel__body">
        {tab === 'id' ? (
          <div className="ep-panel__row">
            <input className="ep-panel__input" placeholder="FreshBooks Record ID (e.g. 12345)" value={recId} onChange={e => setRecId(e.target.value)} disabled={busy} />
            <button className="ep-panel__action ep-panel__action--danger" onClick={handleDeleteById} disabled={busy || !recId.trim()}>
              {busy ? 'Deleting…' : 'Delete Record'}
            </button>
          </div>
        ) : (
          <div className="ep-panel__bulk">
            <div className="ep-panel__warn">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Fetches <b>all</b> {entity.name} from FreshBooks and deletes them one by one. Cannot be undone.
            </div>
            <button className="ep-panel__action ep-panel__action--danger" onClick={handleBulkDelete} disabled={busy}>
              {busy ? 'Deleting all…' : 'Confirm Delete All'}
            </button>
            {result && (
              <div className="ep-panel__result">
                <span className="ep-panel__result-ok">{result.deleted} deleted</span>
                {(result.failed ?? 0) > 0 && <span className="ep-panel__result-err">{result.failed} failed</span>}
                {result.errors?.slice(0, 3).map((e, i) => <div key={i} className="ep-panel__err-row">{e}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── update panel (inline) ─────────────────────────────────────────────────────
function UpdatePanel({ entity, onClose, toast }: {
  entity: { id: string; name: string };
  onClose: () => void;
  toast: (t: string, title: string, msg: string) => void;
}) {
  const [drag, setDrag]           = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded]   = useState<{ name: string; rows: number } | null>(null);
  const [running, setRunning]     = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult]       = useState<BulkOpResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const spinIcon = (
    <svg className="ep-spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".25"/><path d="M12 3a9 9 0 0 1 9 9"/>
    </svg>
  );

  async function handleDownload() {
    setDownloading(true);
    try {
      await fbExportEntity(entity.id);
      toast('success', 'Downloaded', `freshbooks_${entity.id}.xlsx saved — edit it and re-upload below.`);
    } catch (err: any) {
      toast('error', 'Export failed', err.message);
    } finally { setDownloading(false); }
  }

  async function acceptFile(file: File) {
    setUploading(true); setUploaded(null); setResult(null);
    try {
      const r = await uploadExcelFile(entity.id, file);
      setUploaded({ name: file.name, rows: r.total });
      toast('success', 'Sheet loaded', `${r.total.toLocaleString()} rows ready to update.`);
    } catch (err: any) {
      toast('error', 'Upload failed', err.message);
    } finally { setUploading(false); }
  }

  async function runBulk() {
    setRunning(true); setResult(null);
    try {
      const r = await fbBulkUpdate(entity.id);
      setResult(r);
      toast(r.failed === 0 ? 'success' : 'warning', 'Bulk update done', `${r.updated} updated, ${r.failed} failed.`);
    } catch (err: any) {
      toast('error', 'Bulk update failed', err.message);
    } finally { setRunning(false); }
  }

  return (
    <div className="ep-panel ep-panel--update card">
      <div className="ep-panel__head">
        <span className="ep-panel__title">Update in FreshBooks</span>
        <button className="ep-panel__close" onClick={onClose}>✕</button>
      </div>
      <div className="ep-panel__body">
        <div className="ep-panel__dl-hint">
          <div className="ep-panel__dl-hint-text">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Download your current {entity.name} from FreshBooks first — the file includes the <b>id</b> column. Edit the values you want to change, then upload it below.
          </div>
          <button className="ep-panel__dl-btn" onClick={handleDownload} disabled={downloading}>
            {downloading
              ? <>{spinIcon} Fetching…</>
              : <><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download current records</>
            }
          </button>
        </div>

        {!uploaded ? (
          <div
            className={`ep-drop${drag ? ' drag' : ''}${uploading ? ' ep-drop--uploading' : ''}`}
            onClick={() => !uploading && fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) acceptFile(f); }}
          >
            {uploading
              ? <>{spinIcon}<span>Uploading…</span></>
              : <>
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <b>Drop edited XLSX here</b>
                  <span>or <u style={{ color: 'var(--blue)', cursor: 'pointer' }}>click to browse</u></span>
                </>
            }
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) acceptFile(f); e.target.value = ''; }} />
          </div>
        ) : (
          <div className="ep-file-chip">
            <div className="ep-file-chip__icon">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div className="ep-file-chip__meta"><b>{uploaded.name}</b><span>{uploaded.rows.toLocaleString()} rows</span></div>
            <button className="ep-file-chip__rm" onClick={() => { setUploaded(null); setResult(null); }}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}
        <button className="btn btn--fb btn--block" onClick={runBulk} disabled={running || !uploaded} style={{ marginTop: 10 }}>
          {running ? <>{spinIcon} Updating…</> : 'Run Bulk Update'}
        </button>
        {result && (
          <div className="ep-panel__result">
            <span className="ep-panel__result-ok">{result.updated} updated</span>
            {(result.failed ?? 0) > 0 && <span className="ep-panel__result-err">{result.failed} failed</span>}
            {result.errors?.slice(0, 3).map((e, i) => <div key={i} className="ep-panel__err-row">{e}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── dry run summary ──────────────────────────────────────────────────────────
function DryRunSummary({ report, onRerun, loading }: {
  report: ExcelDryRunReport; onRerun: () => void; loading: boolean;
}) {
  const errs  = report.issues.filter(i => i.sev === 'error');
  const warns = report.issues.filter(i => i.sev === 'warning');
  const clean = report.issues.length === 0;
  return (
    <div className="ep-dry">
      <div className="ep-dry__stats">
        <div className="ep-dry__stat ep-dry__stat--blue">
          <b>{report.total.toLocaleString()}</b><span>Total rows</span>
        </div>
        {errs.length > 0 && (
          <div className="ep-dry__stat ep-dry__stat--red">
            <b>{errs.length}</b><span>Errors</span>
          </div>
        )}
        {warns.length > 0 && (
          <div className="ep-dry__stat ep-dry__stat--amber">
            <b>{warns.length}</b><span>Warnings</span>
          </div>
        )}
      </div>

      {clean
        ? <div className="ep-dry__clean">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            No issues — safe to push
          </div>
        : <div className="ep-dry__issues">
            {report.issues.slice(0, 4).map((iss, i) => (
              <div key={i} className={`ep-dry__issue ep-dry__issue--${iss.sev}`}>
                <span className="ep-dry__issue-loc">Row {iss.row} · {iss.field}</span>
                <span className="ep-dry__issue-msg">{iss.msg}</span>
              </div>
            ))}
            {report.issues.length > 4 && (
              <div className="ep-dry__more">+{report.issues.length - 4} more issues</div>
            )}
          </div>
      }

      <button className="btn btn--sm btn--ghost" onClick={onRerun} disabled={loading} style={{ marginTop: 10 }}>
        Re-run validation
      </button>
    </div>
  );
}
