import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import {
  listFiles, createFile, connectFile, deleteFile, getFileHistory,
  type MigrationFileEntry, type FileHistory,
} from '../lib/api';
import { getActiveFileId, setActiveFileId, clearActiveFile } from '../lib/activeFile';

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

/* ── icons ─────────────────────────────────────────────────────────────────── */
const IconFile = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
  </svg>
);
const IconLink = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);
const IconCheck = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/>
  </svg>
);
const IconTrash = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
);
const IconClock = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);
const IconChevron = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);
const IconSearch = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const IconPlus = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

export default function FilesPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { workflow = 'excel' } = useParams<{ workflow: string }>();

  const [files, setFiles]       = useState<MigrationFileEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew]   = useState(false);
  const [newName, setNewName]   = useState('');
  const [search, setSearch]     = useState('');
  const [busyId, setBusyId]     = useState<number | null>(null);
  const [historyFor, setHistoryFor] = useState<FileHistory | null>(null);
  const [activeId, setActiveId]     = useState<number | null>(getActiveFileId());

  async function refresh() {
    try {
      const { files } = await listFiles();
      setFiles(files);
      // If the active file was deleted elsewhere, stop pointing at it.
      const active = getActiveFileId();
      if (active && !files.some(f => f.id === active)) {
        clearActiveFile();
        setActiveId(null);
      }
    } catch (err: any) {
      toast('error', 'Could not load files', err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter(f =>
      f.name.toLowerCase().includes(q) || (f.company ?? '').toLowerCase().includes(q));
  }, [files, search]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const file = await createFile(name);
      setNewName('');
      setShowNew(false);
      toast('success', 'File created', `"${file.name}" — connect it to FreshBooks next.`);
      await refresh();
    } catch (err: any) {
      toast('error', 'Could not create file', err.message);
    } finally {
      setCreating(false);
    }
  }

  async function onConnect(f: MigrationFileEntry) {
    setBusyId(f.id);
    try {
      const updated = await connectFile(f.id);
      toast('success', 'Connected', `"${updated.name}" → ${updated.company ?? 'FreshBooks'}`);
      await refresh();
    } catch (err: any) {
      // The backend returns this when the session has no FreshBooks connection yet.
      // Linking needs one to exist first, so take them there rather than only
      // reporting the error and leaving them to work out the next step.
      if (/Connect FreshBooks first/i.test(err.message ?? '')) {
        setActiveFileId(f.id);
        setActiveId(f.id);
        toast('warning', 'FreshBooks not connected', 'Connect FreshBooks first, then link this file.');
        navigate(`/${workflow}/connect`);
        return;
      }
      toast('error', 'Could not connect', err.message);
    } finally {
      setBusyId(null);
    }
  }

  function onOpen(f: MigrationFileEntry) {
    if (!f.connected) { onConnect(f); return; }
    setActiveFileId(f.id);
    setActiveId(f.id);
    navigate(`/${workflow}/tracker`);
  }

  async function onHistory(f: MigrationFileEntry) {
    setBusyId(f.id);
    try { setHistoryFor(await getFileHistory(f.id)); }
    catch (err: any) { toast('error', 'Could not load history', err.message); }
    finally { setBusyId(null); }
  }

  async function onDelete(f: MigrationFileEntry) {
    const runs = f.runCount ?? 0;
    const msg = runs > 0
      ? `Delete "${f.name}"?\n\nIts ${runs} migration run(s) are KEPT — they are only detached from this file.\nNothing is removed from FreshBooks.`
      : `Delete "${f.name}"?\n\nNothing is removed from FreshBooks.`;
    if (!window.confirm(msg)) return;

    setBusyId(f.id);
    try {
      const res = await deleteFile(f.id);
      if (getActiveFileId() === f.id) { clearActiveFile(); setActiveId(null); }
      toast('success', 'File deleted', res.note ?? res.message);
      await refresh();
    } catch (err: any) {
      toast('error', 'Could not delete', err.message);
    } finally {
      setBusyId(null);
    }
  }

  const iconBtn: React.CSSProperties = {
    display: 'grid', placeItems: 'center', width: 30, height: 30,
    borderRadius: 8, color: 'var(--text-3)', background: 'transparent',
  };

  return (
    <div className="files-page">

      {/* ── header: title + search + new ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>Your Files</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-3)' }}>
            {loading
              ? 'Loading…'
              : `${files.length} file${files.length === 1 ? '' : 's'} · ${files.filter(f => f.connected).length} connected`}
          </p>
        </div>

        <div style={{ position: 'relative', minWidth: 220 }}>
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', display: 'grid' }}>
            <IconSearch />
          </span>
          <input
            className="input"
            style={{ paddingLeft: 34 }}
            placeholder="Search files…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <button className="btn btn--primary" onClick={() => setShowNew(v => !v)}>
          <IconPlus /> New File
        </button>
      </div>

      {/* ── new file form, only when asked for ── */}
      {showNew && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card__body">
            <form onSubmit={onCreate} style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="File name — e.g. Relentless 2024"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                disabled={creating}
                autoFocus
              />
              <button className="btn btn--primary" disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : 'Create File'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => { setShowNew(false); setNewName(''); }}>
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── empty states ── */}
      {!loading && files.length === 0 && !showNew && (
        <div className="card"><div className="card__body" style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
          No files yet. Create your first file to get started.
        </div></div>
      )}
      {!loading && files.length > 0 && shown.length === 0 && (
        <div className="card"><div className="card__body" style={{ textAlign: 'center', padding: 32, color: 'var(--text-3)' }}>
          No files match “{search}”.
        </div></div>
      )}

      {/* ── file cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
        {shown.map(f => {
          const isActive = activeId === f.id;
          const busy = busyId === f.id;
          return (
            <div
              key={f.id}
              className="card"
              style={{ padding: 0, outline: isActive ? '2px solid var(--blue)' : undefined }}
            >
              {/* body */}
              <div style={{ padding: '20px 20px 16px' }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center',
                  background: 'var(--blue-light)', color: 'var(--blue)', marginBottom: 14,
                }}>
                  <IconFile />
                </div>

                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <strong style={{ fontSize: 16, color: 'var(--text-1)' }}>{f.name}</strong>
                  {isActive && (
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: .4, color: 'var(--blue)' }}>ACTIVE</span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, color: 'var(--text-3)', fontSize: 13 }}>
                  <IconLink />
                  <span style={{ fontFamily: 'var(--mono, monospace)' }}>
                    {f.company ?? 'Not linked to a company'}
                  </span>
                </div>

                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
                  Created {fmtDate(f.createdAt)}
                  {typeof f.runCount === 'number' && ` · ${f.runCount} migration${f.runCount === 1 ? '' : 's'}`}
                </div>
              </div>

              {/* footer: status + actions */}
              <div style={{
                borderTop: '1px solid var(--border)', padding: '10px 14px 10px 20px',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                {f.connected ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--success)', fontWeight: 600, fontSize: 13 }}>
                    <IconCheck /> Connected
                  </span>
                ) : (
                  <button
                    className="btn btn--sm btn--soft"
                    disabled={busy}
                    onClick={() => onConnect(f)}
                  >
                    {busy ? 'Connecting…' : 'Connect FreshBooks'}
                  </button>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button style={iconBtn} title="History" disabled={busy} onClick={() => onHistory(f)}>
                    <IconClock />
                  </button>
                  <button style={{ ...iconBtn, color: 'var(--error)' }} title="Delete" disabled={busy} onClick={() => onDelete(f)}>
                    <IconTrash />
                  </button>
                  <button
                    style={{ ...iconBtn, color: f.connected ? 'var(--blue)' : 'var(--text-3)' }}
                    title={f.connected ? 'Open' : 'Connect first'}
                    disabled={busy}
                    onClick={() => onOpen(f)}
                  >
                    <IconChevron />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── history panel ── */}
      {historyFor && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card__head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>History — {historyFor.file.name}</h3>
            <button className="btn btn--sm btn--ghost" onClick={() => setHistoryFor(null)}>Close</button>
          </div>
          <div className="card__body">
            {historyFor.runs.length === 0
              ? <div style={{ color: 'var(--text-3)', padding: 12 }}>No migrations have run under this file yet.</div>
              : historyFor.runs.map(r => (
                  <div key={r.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13 }}>Run #{r.id}</strong>
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{new Date(r.startedAt).toLocaleString()}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{r.status}</span>
                      {r.triggeredBy && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.triggeredBy}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                        <span style={{ color: 'var(--success)' }}>✓ {r.totals.success}</span>
                        {'  '}<span style={{ color: 'var(--text-3)' }}>⚡ {r.totals.skipped}</span>
                        {'  '}<span style={{ color: 'var(--error)' }}>✗ {r.totals.failed}</span>
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                      {r.phases.map(p => `${p.entity} (${p.successCount}/${p.totalRecords})`).join(' · ')}
                    </div>
                  </div>
                ))}
          </div>
        </div>
      )}
    </div>
  );
}
