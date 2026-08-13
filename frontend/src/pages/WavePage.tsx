import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { downloadStyledTemplate } from '../lib/templateExcel';
import { useMigration, WAVES, DEPS } from '../context/MigrationContext';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { CatIconMini, Badge } from '../components/CatIcon';
import { templateFor } from '../data/entities';
import { uploadExcelFile, dryRunExcel } from '../lib/api';
import type { ExcelDryRunReport } from '../lib/api';

// ── real file hints shown in each entity card ──────────────────────────────
const FILE_HINTS: Record<string, string> = {
  'chart-of-accounts': '11_chart_of_accounts.xlsx',
  'clients':           '01_clients.xlsx',
  'vendors':           'Vendor.xlsx',
  'items':             'Items.xlsx',
  'services':          'Service.xlsx',
  'journal-entries':   'Journal.xlsx',
  'expenses':          'Expense.xlsx',
  'income':            'Income.xlsx',
  'invoices':          'Invoices.xlsx',
  'bills':             'Bills.xlsx',
  'credit-notes':      '07_credit_notes.xlsx',
  'invoice-payments':  '10_invoice_payments.xlsx',
  'bill-payments':     '09_bill_payments.xlsx',
};

// ── auto-match a filename to an entity id ──────────────────────────────────
const KEYWORDS: Record<string, string[]> = {
  'chart-of-accounts': ['chart', 'coa', 'chartofaccounts'],
  'clients':           ['client', 'customer'],
  'vendors':           ['vendor', 'supplier'],
  'items':             ['item', 'product'],
  'services':          ['service'],
  'journal-entries':   ['journal', 'je'],
  'expenses':          ['expense'],
  'income':            ['income', 'revenue'],
  'invoices':          ['invoice'],
  'bills':             ['bill'],
  'credit-notes':      ['credit', 'creditnote', 'memo'],
  'invoice-payments':  ['invoicepayment', 'invpay'],
  'bill-payments':     ['billpayment', 'billpay'],
};

function matchFile(filename: string, candidates: readonly string[]): string | null {
  const n = filename.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const id of candidates) {
    const kws = KEYWORDS[id] ?? [id.replace(/-/g, '')];
    if (kws.some(k => n.includes(k))) return id;
  }
  return null;
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function WavePage() {
  const { waveId, workflow = 'excel' } = useParams<{ waveId: string; workflow: string }>();
  const navigate = useNavigate();
  const { entities, pushMap, pushEntity } = useMigration();
  const { fbConnected, uploaded, setUploaded } = useApp();
  const { toast } = useToast();

  const bulkRef = useRef<HTMLInputElement>(null);
  const [bulkUploading, setBulkUploading] = useState(false);

  const wave = WAVES.find(w => w.id === waveId);
  if (!wave) { navigate(`/${workflow}/tracker`, { replace: true }); return null; }

  const waveIdx    = WAVES.findIndex(w => w.id === waveId);
  const prevWave   = waveIdx > 0 ? WAVES[waveIdx - 1] : null;
  const waveLocked = !!prevWave &&
    !prevWave.entities.every(id => entities.find(x => x.id === id)?.status === 'done');

  const waveEntities = wave.entities
    .map(id => entities.find(e => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e);

  const hasRunning = waveEntities.some(e => e.status === 'running');
  const allDone    = waveEntities.every(e => e.status === 'done');
  const doneCount  = waveEntities.filter(e => e.status === 'done').length;
  const errCount   = waveEntities.filter(e => e.status === 'error').length;
  const uploaded_  = wave.entities.filter(id => !!uploaded[id]).length;

  // ── Upload All: multi-file picker, auto-matched by filename ──────────────
  async function handleBulkUpload(files: FileList) {
    if (!fbConnected) { toast('warning', 'Connect FreshBooks first', ''); navigate(`/${workflow}/connect`); return; }
    setBulkUploading(true);
    let matched = 0; let unmatched: string[] = [];

    for (const file of Array.from(files)) {
      const entityId = matchFile(file.name, wave.entities);
      if (!entityId) { unmatched.push(file.name); continue; }

      try {
        if (workflow === 'excel') {
          const r = await uploadExcelFile(entityId, file);
          setUploaded(prev => ({ ...prev, [entityId]: { name: file.name, size: fmtSize(file.size), rows: r.total, savedAs: r.savedAs || r.file } }));
        } else {
          setUploaded(prev => ({ ...prev, [entityId]: { name: file.name, size: fmtSize(file.size) } }));
        }
        matched++;
      } catch (err: any) {
        toast('error', `Failed: ${file.name}`, err.message);
      }
    }

    setBulkUploading(false);
    if (matched) toast('success', `${matched} file${matched > 1 ? 's' : ''} uploaded`, `Matched and ready for ${wave.label}.`);
    if (unmatched.length) toast('warning', `${unmatched.length} file${unmatched.length > 1 ? 's' : ''} not matched`, `Upload manually: ${unmatched.join(', ')}`);
  }

  // ── Push All: DAG-aware, fires all simultaneously ────────────────────────
  async function pushAll() {
    if (!fbConnected) { toast('warning', 'Connect FreshBooks first', ''); navigate(`/${workflow}/connect`); return; }
    if (waveLocked) return;
    const canRun = waveEntities.filter(e => e.status !== 'running' && e.status !== 'done');
    if (!canRun.length) { toast('info', 'Nothing to push', 'All entities in this wave are already done.'); return; }

    const scheduled: Record<string, Promise<void>> = {};
    const schedule = (id: string): Promise<void> => {
      if (scheduled[id]) return scheduled[id];
      const depIds = (DEPS[id] || []).filter(d => {
        const e = entities.find(x => x.id === d);
        return e && e.status !== 'done';
      });
      scheduled[id] = Promise.all(depIds.map(d => schedule(d))).then(() => pushEntity(id));
      return scheduled[id];
    };
    await Promise.all(canRun.map(e => schedule(e.id)));
    toast('success', `${wave.label} complete`, `All entities pushed to FreshBooks.`);
  }

  const spinIcon = (
    <svg style={{ animation: 'spin .7s linear infinite' }} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );

  return (
    <div className="wp-wrap">

      {/* ── wave header ── */}
      <div className="wp-head">
        <div className="wp-head__left">
          <div className="wp-head__num">{wave.num}</div>
          <div className="wp-head__text">
            <h2>{wave.label} <span className="wp-head__sub">{wave.subtitle}</span></h2>
            <p className="wp-head__meta">
              {waveEntities.length} entities
              {doneCount > 0 && !allDone && <> · <span className="n-green">{doneCount} done</span></>}
              {errCount  > 0 && <> · <span className="n-red">{errCount} error{errCount > 1 ? 's' : ''}</span></>}
              {allDone   && <> · <span className="n-green">All done ✓</span></>}
              {workflow === 'excel' && uploaded_ > 0 && <> · {uploaded_}/{waveEntities.length} uploaded</>}
            </p>
          </div>
        </div>

        {/* action buttons */}
        <div className="wp-head__actions">
          {/* Upload All */}
          {workflow === 'excel' && (
            <button
              className="btn btn--ghost"
              disabled={bulkUploading}
              onClick={() => bulkRef.current?.click()}
              title={`Select all ${wave.label} sheets at once — auto-matched by filename`}
            >
              {bulkUploading
                ? <>{spinIcon} Uploading…</>
                : <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Upload All</>
              }
            </button>
          )}

          {/* Push All */}
          <button
            className={`btn btn--primary${hasRunning || waveLocked || allDone ? '' : ' btn--pulse'}`}
            disabled={hasRunning || waveLocked || allDone}
            onClick={pushAll}
          >
            {hasRunning
              ? <>{spinIcon} Running…</>
              : allDone
                ? <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> All Done</>
                : <><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Push All {wave.label}</>
            }
          </button>
        </div>
      </div>

      {/* hidden multi-file input */}
      <input
        ref={bulkRef}
        type="file"
        multiple
        accept=".xlsx"
        style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.length) handleBulkUpload(e.target.files); e.target.value = ''; }}
      />

      {/* upload-all hint */}
      {workflow === 'excel' && uploaded_ === 0 && !waveLocked && (
        <div className="wp-upload-hint">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Click <b>Upload All</b> to select all {wave.label} sheets at once — files are auto-matched by name. Or upload each card individually below.
        </div>
      )}

      {/* locked banner */}
      {waveLocked && prevWave && (
        <div className="gate-banner">
          <div className="gate-banner__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <div className="gate-banner__txt">
            <b>Complete {prevWave.label} ({prevWave.subtitle}) first</b>
            <span>All {prevWave.label} entities must be pushed before starting {wave.label}.</span>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => navigate(`/${workflow}/wave/${prevWave.id}`)}>
            Go to {prevWave.label}
          </button>
        </div>
      )}

      {/* ── entity card grid ── */}
      <div className="wp-grid">
        {wave.entities.map(id => (
          <EntityCard key={id} entityId={id} workflow={workflow} />
        ))}
      </div>

    </div>
  );
}

// ── per-entity card ───────────────────────────────────────────────────────────
function EntityCard({ entityId, workflow }: { entityId: string; workflow: string }) {
  const { entities, pushMap, resultMap, pushEntity, canPush } = useMigration();
  const { fbConnected, uploaded, setUploaded } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [uploading, setUploading]   = useState(false);
  const [drag, setDrag]             = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult]   = useState<{ ok: boolean; total: number; errs: number; warns: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const entity   = entities.find(e => e.id === entityId);
  if (!entity) return null;

  const ps       = pushMap[entityId];
  const realRes  = resultMap[entityId];
  const fileInfo = uploaded[entityId];
  const { ok: depsOk, missing } = canPush(entityId);
  const canGo    = fbConnected && depsOk && (workflow !== 'excel' || !!fileInfo) && entity.status !== 'running';
  const hint     = FILE_HINTS[entityId];

  async function acceptFile(file: File) {
    try {
      setUploading(true);
      if (workflow === 'excel') {
        const r = await uploadExcelFile(entityId, file);
        setUploaded(prev => ({ ...prev, [entityId]: { name: file.name, size: fmtSize(file.size), rows: r.total, savedAs: r.savedAs || r.file } }));
        setDryResult(null);
        toast('success', `${entity.name} ready`, `${r.total.toLocaleString()} rows loaded.`);
      } else {
        setUploaded(prev => ({ ...prev, [entityId]: { name: file.name, size: fmtSize(file.size) } }));
      }
    } catch (err: any) { toast('error', 'Upload failed', err.message); }
    finally { setUploading(false); }
  }

  function removeFile() {
    const u = { ...uploaded }; delete u[entityId]; setUploaded(u); setDryResult(null);
  }

  async function runDryRun() {
    try {
      setDryRunning(true);
      const [r] = await dryRunExcel([entityId]);
      const errs = r.issues.filter(i => i.sev === 'error').length;
      setDryResult({ ok: errs === 0, total: r.total, errs, warns: r.issues.filter(i => i.sev === 'warning').length });
    } catch (err: any) { toast('error', 'Dry run failed', err.message); }
    finally { setDryRunning(false); }
  }

  function downloadTemplate() {
    const cols = templateFor(entityId);
    downloadStyledTemplate(cols, `${entityId}_template.xlsx`, entity.name);
    toast('success', 'Template downloaded', entity.name);
  }

  function downloadErrors() {
    if (!realRes?.errors?.length) return;
    const cols  = templateFor(entityId);
    const hdr   = ['error_row', 'error_message', ...cols.map(c => c.col)];
    const rows  = realRes.errors.map(e => [String(e.row), e.error, ...cols.map(() => '')]);
    const csv   = [hdr, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `${entityId}_errors.csv`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  const spinSm = (
    <svg className="ep-spin" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".2"/><path d="M12 3a9 9 0 0 1 9 9"/>
    </svg>
  );

  return (
    <div className={`wc card${entity.status === 'done' ? ' wc--done' : entity.status === 'error' ? ' wc--error' : entity.status === 'running' ? ' wc--running' : ''}`}>

      {/* header */}
      <div className="wc__head">
        <CatIconMini cat={entity.cat} />
        <button className="wc__name" onClick={() => navigate(`/${workflow}/entity/${entityId}`)}>
          {entity.name}
        </button>
        <Badge status={entity.status === 'testing' ? 'idle' : entity.status} />
      </div>

      {/* dep warning */}
      {!depsOk && (
        <div className="wc__dep-warn">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Needs: {missing.map(m => m.name).join(', ')}
        </div>
      )}

      {/* upload row */}
      <div className="wc__upload">
        {!fileInfo
          ? <div
              className={`wc__drop${drag ? ' drag' : ''}${uploading ? ' uploading' : ''}`}
              onClick={() => !uploading && fileRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) acceptFile(f); }}
            >
              {uploading
                ? <>{spinSm} Uploading…</>
                : <>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    <span>Drop file{hint && <> · <span className="wc__hint">{hint}</span></>}</span>
                  </>
              }
            </div>
          : <div className="wc__file">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span className="wc__file-name">{fileInfo.name}</span>
              {fileInfo.rows && <span className="wc__file-rows">{fileInfo.rows.toLocaleString()} rows</span>}
              <button className="wc__file-rm" onClick={removeFile} title="Remove">✕</button>
            </div>
        }
        <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) acceptFile(f); e.target.value = ''; }} />
        <button className="wc__tpl" onClick={downloadTemplate} title="Download template">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>

      {/* dry run */}
      {workflow === 'excel' && fileInfo && (
        <div className="wc__dry">
          {!dryResult
            ? <button className="wc__dry-btn" onClick={runDryRun} disabled={dryRunning}>
                {dryRunning ? <>{spinSm} Scanning…</> : 'Dry Run'}
              </button>
            : <span className={`wc__dry-result wc__dry-result--${dryResult.ok ? 'ok' : 'err'}`}>
                {dryResult.ok
                  ? <><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> {dryResult.total.toLocaleString()} rows — clean</>
                  : <>{dryResult.errs} error{dryResult.errs > 1 ? 's' : ''}{dryResult.warns > 0 ? `, ${dryResult.warns} warn` : ''}</>
                }
                <button className="wc__dry-rerun" onClick={runDryRun} disabled={dryRunning}>re-run</button>
              </span>
          }
        </div>
      )}

      {/* push */}
      <button className="btn btn--fb wc__push" disabled={!canGo} onClick={() => pushEntity(entityId)}>
        {entity.status === 'running'
          ? <>{spinSm} Running…</>
          : entity.status === 'done'
            ? <><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Done · Re-push</>
            : 'Push to FreshBooks'
        }
      </button>

      {/* running progress */}
      {entity.status === 'running' && ps && (
        <div className="wc__prog">
          <div className="wc__prog-track">
            <div className="wc__prog-fill" style={{ width: `${ps.pct}%` }}>
              <div className="ep-prog__shimmer" />
            </div>
          </div>
          <div className="wc__prog-meta">
            <span>{ps.done.toLocaleString()} / {ps.total.toLocaleString()}</span>
          </div>
        </div>
      )}

      {/* results */}
      {(entity.status === 'done' || entity.status === 'error') && entity.pushed + entity.failed > 0 && (
        <div className="wc__result">
          <span className="wc__result-stat wc__result-stat--green">{entity.pushed.toLocaleString()} pushed</span>
          {entity.failed > 0 && <span className="wc__result-stat wc__result-stat--red">{entity.failed.toLocaleString()} failed</span>}
          {entity.dur && entity.dur !== '-' && <span className="wc__result-stat">{entity.dur}</span>}
        </div>
      )}

      {/* download error sheet */}
      {realRes?.errors && realRes.errors.length > 0 && (
        <button className="wc__dl-err btn btn--sm btn--ghost" onClick={downloadErrors}>
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download Error Sheet ({realRes.errors.length} rows)
        </button>
      )}

    </div>
  );
}
