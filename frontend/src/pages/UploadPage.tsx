import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { downloadStyledTemplate, downloadAllStyledTemplates } from '../lib/templateExcel';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import type { Entity } from '../data/entities';
import { ENTITIES, countIssues, templateFor } from '../data/entities';
import { CatIcon, Badge } from '../components/CatIcon';
import DryRunModal from '../components/DryRunModal';
import TemplateModal from '../components/TemplateModal';
import Drawer from '../components/Drawer';
import ExcelDryRunModal from '../components/ExcelDryRunModal';
import { dryRunExcel, uploadExcelFile } from '../lib/api';
import type { ExcelDryRunReport } from '../lib/api';

const QBD_FILES = [
  { id:'coa',              name:'Chart of Accounts', file:'COA.IIF',            cat:'accounts' as const },
  { id:'clients',          name:'Clients',           file:'Customer.IIF',       cat:'people' as const },
  { id:'vendors',          name:'Vendors',           file:'Vendor.IIF',         cat:'people' as const },
  { id:'all-data',         name:'All Data',          file:'AllData.IIF',        cat:'money' as const },
  { id:'bills',            name:'Bills',             file:'Bill.IIF',           cat:'docs' as const },
  { id:'bill-payments',    name:'Bill Payments',     file:'BillPayment.IIF',    cat:'payments' as const },
  { id:'invoice-payments', name:'Invoice Payments',  file:'InvoicePayment.IIF', cat:'payments' as const },
];

// Expense categories excluded — FreshBooks auto-handles them when expenses are pushed
const EXCEL_FILES = [
  { id:'chart-of-accounts',   name:'Chart of Accounts',   file:'11_chart_of_accounts.csv / .xlsx', cat:'accounts' as const },
  { id:'clients',             name:'Clients',             file:'01_clients.csv / .xlsx',            cat:'people' as const },
  { id:'vendors',             name:'Vendors',             file:'Vendor.xlsx',                        cat:'people' as const },
  { id:'items',               name:'Items',               file:'Items.xlsx',                         cat:'catalog' as const },
  { id:'services',            name:'Services',            file:'Service.xlsx',                       cat:'catalog' as const },
  { id:'expenses',            name:'Expenses',            file:'Expense.xlsx',                       cat:'money' as const },
  { id:'income',              name:'Income',              file:'Income.xlsx',                        cat:'money' as const },
  { id:'journal-entries',     name:'Journal Entries',     file:'Journal (1).xlsx',                   cat:'money' as const },
  { id:'invoices',            name:'Invoices',            file:'Invoicea.xlsx',                      cat:'docs' as const },
  { id:'bills',               name:'Bills',               file:'Billss.xlsx',                        cat:'docs' as const },
  { id:'credit-notes',        name:'Credit Notes',        file:'07_credit_notes.csv / .xlsx',        cat:'docs' as const },
  { id:'invoice-payments',    name:'Invoice Payments',    file:'10_invoice_payments.csv / .xlsx',    cat:'payments' as const },
  { id:'bill-payments',       name:'Bill Payments',       file:'09_bill_payments.csv / .xlsx',       cat:'payments' as const },
];

function fmtSize(b: number) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

export default function UploadPage() {
  const { fbConnected, uploaded, setUploaded } = useApp();
  const navigate = useNavigate();
  const { workflow = 'qbd' } = useParams<{ workflow: string }>();
  const { toast } = useToast();
  const [drag, setDrag] = useState<string | null>(null);
  const [dryEntities, setDryEntities] = useState<Entity[] | null>(null);
  const [excelDryRun, setExcelDryRun] = useState<ExcelDryRunReport[] | null>(null);
  const [tplModal, setTplModal] = useState<{ id: string; name: string } | null>(null);
  const [drawerEntity, setDrawerEntity] = useState<Entity | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const entities = workflow === 'excel'
    ? ENTITIES.map(e => ({ ...e, status:'idle' as const, pushed:0, skipped:0, failed:0, dur:'-', last:'-', progress:0 }))
    : ENTITIES;
  const fileList = workflow === 'qbd' ? QBD_FILES : EXCEL_FILES;
  const uploadedCount = fileList.filter(f => uploaded[f.id]).length;

  function requireConn() {
    if (fbConnected) return true;
    toast('warning', 'Please connect FreshBooks first', 'Link your account before uploading.');
    navigate(`/${workflow}/connect`);
    return false;
  }

  async function acceptFile(id: string, file: File) {
    if (!requireConn()) return;
    const meta = fileList.find(f => f.id === id);

    if (workflow === 'excel') {
      try {
        setUploading(id);
        const report = await uploadExcelFile(id, file);
        setUploaded(prev => ({
          ...prev,
          [id]: {
            name: file.name,
            size: fmtSize(file.size),
            rows: report.total,
            savedAs: report.savedAs || report.file,
          },
        }));
        toast('success', 'Excel file ready', `${meta?.name}: ${report.total.toLocaleString()} rows saved for migration.`);
      } catch (err: any) {
        toast('error', 'Upload failed', err.message || 'Could not save this Excel file.');
      } finally {
        setUploading(null);
      }
      return;
    }

    // Functional update so bulk uploads don't overwrite each other (stale closure fix)
    setUploaded(prev => ({ ...prev, [id]: { name: file.name, size: fmtSize(file.size) } }));
    toast('success', 'File uploaded', `${meta?.name}: ${file.name}`);
  }

  function removeFile(id: string) {
    const u = { ...uploaded };
    delete u[id];
    setUploaded(u);
  }

  function downloadTemplate(id: string, name: string) {
    const cols = templateFor(id);
    const fileName = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_template.xlsx`;
    downloadStyledTemplate(cols, fileName, name);
    toast('success', 'Template downloaded', `${name} template saved as Excel.`);
  }

  function downloadAllTemplates() {
    const sheets = fileList.map(f => ({ cols: templateFor(f.id), sheetName: f.name }));
    downloadAllStyledTemplates(sheets, 'mmc_migration_templates.xlsx');
    toast('success', 'All templates downloaded', `${fileList.length} sheets in one Excel file.`);
  }

  function startPush(id: string) {
    if (!requireConn()) return;

    if (workflow === 'excel' && id !== 'all' && !uploaded[id]) {
      toast('warning', 'Upload Excel file first', 'This entity needs a file before it can be pushed.');
      return;
    }

    const selected = id === 'all'
      ? entities.filter(e => workflow === 'excel' ? Boolean(uploaded[e.id]) : e.status !== 'done')
      : entities.filter(e => e.id === id);

    if (!selected.length) {
      toast('info', workflow === 'excel' ? 'No Excel files uploaded' : 'All migrated', workflow === 'excel' ? 'Upload at least one Excel file before pushing.' : 'Every selected entity has already been pushed.');
      return;
    }

    const label = id === 'all' ? `${selected.length} entities` : selected[0].name;
    toast('info', 'Opening tracker', `Tracking ${label} push progress there.`);
    navigate(`/${workflow}/tracker`, {
      state: {
        run: id === 'all' && selected.length === fileList.length ? 'all' : 'entity',
        ids: selected.map(e => e.id),
        startedAt: Date.now(),
      },
    });
  }

  async function runDryRun(ids: string[]) {
    if (!requireConn()) return;

    if (workflow !== 'excel') {
      const selected = ids.includes('all') ? entities : entities.filter(e => ids.includes(e.id));
      setDryEntities(selected);
      return;
    }

    const selectedIds = ids.includes('all')
      ? entities.filter(e => uploaded[e.id]).map(e => e.id)
      : ids.filter(id => uploaded[id]);

    if (!selectedIds.length) {
      toast('warning', 'Upload Excel file first', 'Dry run checks the files you upload through this screen.');
      return;
    }

    try {
      const reports = await dryRunExcel(selectedIds);
      setExcelDryRun(reports);
    } catch (err: any) {
      toast('error', 'Dry run failed', err.message || 'Could not inspect uploaded Excel files.');
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>Upload &amp; Push</h2>
        <div className="right">
          <span className="upload-count">{uploadedCount} of {fileList.length} uploaded</span>
          {workflow === 'excel' && (
            <button className="btn btn--ghost" onClick={downloadAllTemplates}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              All Templates
            </button>
          )}
          <button className="btn btn--primary" disabled={uploadedCount === 0} onClick={() => document.getElementById('pushSection')?.scrollIntoView({ behavior:'smooth' })}>
            Jump to Push
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
      </div>

      {!fbConnected && (
        <div className="gate-banner">
          <div className="gate-banner__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
          <div className="gate-banner__txt"><b>Connect FreshBooks to start uploading</b><span>You can view and download templates now, but uploads unlock once FreshBooks is connected.</span></div>
          <button className="btn btn--warn" onClick={() => navigate(`/${workflow}/connect`)}>Connect now</button>
        </div>
      )}

      {/* ── Bulk Upload Zone ── */}
      {fbConnected && (
        <BulkDropZone workflow={workflow} fileList={fileList} onFiles={acceptFile} />
      )}

      <div className="upload-grid">
        {fileList.map((f, i) => {
          const done = uploaded[f.id];
          const isUploading = uploading === f.id;
          return (
            <div key={f.id} className="up-card" style={{ animation:`fade-up .4s ${i * 0.04}s both` }}>
              <div className="up-card__head">
                <CatIcon cat={f.cat} size={28} />
                <div className="meta"><b>{f.name}</b></div>
                <div className="up-card__actions">
                  <button className="icon-btn" title="View template" onClick={() => setTplModal({ id: f.id, name: f.name })}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                  <button className="icon-btn" title="Download template" onClick={() => downloadTemplate(f.id, f.name)}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                  </button>
                </div>
              </div>

              {isUploading ? (
                <div className="up-card__uploading">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                  Uploading…
                </div>
              ) : done ? (
                <div className="up-file">
                  <div className="up-file__ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                  <div className="up-file__meta"><b>{done.name}</b><span>{done.rows ? `${done.rows.toLocaleString()} rows · ` : ''}{done.size}</span></div>
                  <button className="up-file__x" onClick={() => removeFile(f.id)}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              ) : !fbConnected ? (
                <div className="dropzone dropzone--lock" onClick={requireConn}>
                  <span className="dropzone__ico" style={{ background:'#fff',color:'var(--warning)' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </span>
                  <b style={{ color:'#78350F' }}>Connect to upload</b>
                </div>
              ) : (
                <DropZone
                  accept={workflow === 'qbd' ? '.iif,.csv' : '.xlsx,.xls'}
                  isDrag={drag === f.id}
                  onDragChange={v => setDrag(v ? f.id : null)}
                  onFile={file => acceptFile(f.id, file)}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="push-section" id="pushSection">
        <div className="push-section__head">
          <div><h3>Dry Run &amp; Push</h3><p>Dry run shows issues here. Actual pushes open in the tracker.</p></div>
          <div style={{ display:'flex',gap:8,flexWrap:'wrap' }}>
            <button
              className="btn btn--dry"
              disabled={workflow === 'excel' && uploadedCount === 0}
              title={workflow === 'excel' && uploadedCount === 0 ? 'Upload at least one file first' : undefined}
              onClick={() => runDryRun(['all'])}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              Dry Run All
            </button>
            <button
              className="btn btn--primary"
              disabled={workflow === 'excel' && uploadedCount === 0}
              title={workflow === 'excel' && uploadedCount === 0 ? 'Upload at least one file first' : undefined}
              onClick={() => startPush('all')}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v14"/></svg>
              Push All
            </button>
          </div>
        </div>

        {!fbConnected && (
          <div className="gate-banner">
            <div className="gate-banner__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
            <div className="gate-banner__txt"><b>Connect FreshBooks to push data</b><span>Dry Run and Push are locked until your FreshBooks account is connected.</span></div>
            <button className="btn btn--warn" onClick={() => navigate(`/${workflow}/connect`)}>Connect now</button>
          </div>
        )}

        <div className="card" style={{ marginTop:16 }}>
          <div className="push-list">
            {entities.map(e => {
              const isIdle = e.status === 'testing' || e.status === 'idle';
              const issueCount = workflow === 'excel' ? { err: 0, warn: 0 } : countIssues(e.id);
              return (
                <div key={e.id}>
                  <div className="push-row">
                    <div className="push-ent">
                      <CatIcon cat={e.cat} size={38} />
                      <div><div className="push-name">{e.name}</div><div className="push-cat">{e.cat}</div></div>
                    </div>
                    <div className="push-state">
                      <Badge status={e.status} />
                      {e.status === 'done' && <span className="push-count">{(e.pushed || 0).toLocaleString()} pushed</span>}
                      {issueCount.err > 0 && <span className="row-issues err">{issueCount.err} error{issueCount.err > 1 ? 's' : ''}</span>}
                      {issueCount.warn > 0 && <span className="row-issues warn">{issueCount.warn} warn</span>}
                    </div>
                    <div className="push-acts">
                      {isIdle ? (
                        <>
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={workflow === 'excel' && !uploaded[e.id]}
                            title={workflow === 'excel' && !uploaded[e.id] ? 'Upload file first' : undefined}
                            onClick={() => runDryRun([e.id])}
                          >Dry Run</button>
                          <button
                            className="btn btn--primary btn--sm"
                            disabled={workflow === 'excel' && !uploaded[e.id]}
                            title={workflow === 'excel' && !uploaded[e.id] ? 'Upload file first' : undefined}
                            onClick={() => startPush(e.id)}
                          >Push</button>
                        </>
                      ) : e.status === 'done' ? (
                        <button className="btn btn--ghost btn--sm" onClick={() => setDrawerEntity(e)}>Details</button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <Drawer entity={drawerEntity} onClose={() => setDrawerEntity(null)} />
      {dryEntities && <DryRunModal entities={dryEntities} onClose={() => setDryEntities(null)} />}
      {excelDryRun && <ExcelDryRunModal reports={excelDryRun} onClose={() => setExcelDryRun(null)} />}
      {tplModal && (
        <TemplateModal
          show
          name={tplModal.name}
          cols={templateFor(tplModal.id)}
          onClose={() => setTplModal(null)}
          onDownload={() => { downloadTemplate(tplModal.id, tplModal.name); setTplModal(null); }}
        />
      )}
    </div>
  );
}

// ── Bulk drop zone — drop ALL files at once, auto-routes by filename ──────────
const FILENAME_MAP: Record<string, string> = {
  // QBD files
  'coaiif': 'coa', 'customeriif': 'clients', 'vendoriif': 'vendors',
  'alldataiif': 'all-data', 'billiif': 'bills',
  'billpaymentiif': 'bill-payments', 'invoicepaymentiif': 'invoice-payments',
  // Excel templates (by keyword in name)
  'chart_of_accounts': 'chart-of-accounts', 'coa': 'chart-of-accounts',
  '11_chart': 'chart-of-accounts',
  'client': 'clients', '01_client': 'clients',
  'vendor': 'vendors', '03_vendor': 'vendors',
  'item': 'items', '02_item': 'items',
  'service': 'services', '12_service': 'services',
  'expense': 'expenses', '04_expense': 'expenses',
  'income': 'income', '06_income': 'income',
  'journal': 'journal-entries', '14_journal': 'journal-entries',
  'invoice_payment': 'invoice-payments', '10_invoice_payment': 'invoice-payments',
  'invoicea': 'invoices', '05_invoice': 'invoices',
  'bill_payment': 'bill-payments', '09_bill_payment': 'bill-payments',
  'billss': 'bills', '08_bill': 'bills',
  'credit_note': 'credit-notes', '07_credit': 'credit-notes',
};

function guessEntityId(filename: string): string | null {
  const lower = filename.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.]/g, '');
  const noExt = lower.replace(/\.(xlsx|xls|csv|iif)$/, '');
  // Try exact match first
  if (FILENAME_MAP[noExt]) return FILENAME_MAP[noExt];
  // Try partial match
  for (const [key, id] of Object.entries(FILENAME_MAP)) {
    if (noExt.includes(key) || key.includes(noExt)) return id;
  }
  return null;
}

interface BulkProps {
  workflow: string;
  fileList: { id: string; name: string }[];
  onFiles: (id: string, file: File) => void;
}

function BulkDropZone({ workflow, fileList, onFiles }: BulkProps) {
  const [bulk, setBulk] = useState(false);
  const [results, setResults] = useState<{ name: string; matched: string | null }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList) {
    const res: { name: string; matched: string | null }[] = [];
    Array.from(files).forEach(file => {
      const entityId = guessEntityId(file.name);
      const match = entityId ? fileList.find(f => f.id === entityId) : null;
      res.push({ name: file.name, matched: match?.name || null });
      if (match) onFiles(match.id, file);
    });
    setResults(res);
    setTimeout(() => setResults([]), 5000);
  }

  return (
    <div style={{ marginBottom:18 }}>
      <label
        style={{
          display:'flex', flexDirection:'column', alignItems:'center', gap:10,
          padding:'22px 20px', borderRadius:14, cursor:'pointer', textAlign:'center',
          border: bulk ? '2px solid var(--blue)' : '2px dashed var(--border)',
          background: bulk ? 'var(--blue-light)' : 'linear-gradient(135deg,#161B33,#232A4D)',
          color: bulk ? 'var(--blue-hover)' : '#fff', transition:'all .2s',
        }}
        onDragOver={e => { e.preventDefault(); setBulk(true); }}
        onDragLeave={() => setBulk(false)}
        onDrop={e => { e.preventDefault(); setBulk(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
        <b style={{ fontSize:14.5, fontWeight:700 }}>
          Drop ALL your {workflow === 'qbd' ? 'QBD export' : 'Excel template'} files here at once
        </b>
        <span style={{ fontSize:12.5, opacity:.75 }}>
          We auto-detect which file belongs to which entity by filename — no manual routing needed
        </span>
        <span style={{
          display:'inline-flex', alignItems:'center', gap:6, padding:'7px 16px',
          borderRadius:999, background:bulk?'var(--blue)':'rgba(255,255,255,.15)',
          color: bulk?'#fff':'#fff', fontSize:13, fontWeight:600,
        }}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
          Or click to select multiple files
        </span>
        <input ref={inputRef} type="file" multiple accept=".xlsx,.xls,.iif,.csv" style={{ display:'none' }}
          onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); }} />
      </label>

      {results.length > 0 && (
        <div style={{ marginTop:10, display:'flex', flexWrap:'wrap', gap:6 }}>
          {results.map((r, i) => (
            <span key={i} style={{
              display:'inline-flex', alignItems:'center', gap:5, padding:'4px 10px',
              borderRadius:999, fontSize:12, fontWeight:600,
              background: r.matched ? 'var(--success-light)' : 'var(--error-light)',
              color: r.matched ? '#047857' : '#B42318',
            }}>
              {r.matched ? '✓' : '✕'} {r.name} {r.matched ? `→ ${r.matched}` : '(unrecognised)'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DropZone({ accept, isDrag, onDragChange, onFile }: { accept:string; isDrag:boolean; onDragChange:(v:boolean)=>void; onFile:(f:File)=>void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label
      className={`dropzone${isDrag ? ' drag' : ''}`}
      onDragOver={e => { e.preventDefault(); onDragChange(true); }}
      onDragLeave={() => onDragChange(false)}
      onDrop={e => { e.preventDefault(); onDragChange(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
    >
      <span className="dropzone__ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg></span>
      <b>Drop or <u>browse</u></b>
      <span>{accept.includes('iif') ? '.IIF or .CSV' : '.XLSX or .XLS'}</span>
      <input ref={ref} type="file" accept={accept} style={{ display:'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
    </label>
  );
}
