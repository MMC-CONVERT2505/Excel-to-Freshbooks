import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import {
  listFiles, createFile, connectFile, deleteFile, getFileHistory,
  type MigrationFileEntry, type FileHistory,
} from '../lib/api';
import { getActiveFileId, setActiveFileId, clearActiveFile } from '../lib/activeFile';

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

export default function FilesPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { workflow = 'excel' } = useParams<{ workflow: string }>();

  const [files, setFiles]     = useState<MigrationFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId]   = useState<number | null>(null);
  const [historyFor, setHistoryFor] = useState<FileHistory | null>(null);
  const [activeId, setActiveId]     = useState<number | null>(getActiveFileId());

  async function refresh() {
    try {
      const { files } = await listFiles();
      setFiles(files);
      // If the active file was deleted elsewhere, don't keep pointing at it.
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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const file = await createFile(name);
      setNewName('');
      toast('success', 'File created', `"${file.name}" — ab ise FreshBooks se connect karo.`);
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
      // Linking needs one to exist first, so send them to do that rather than just
      // reporting the error and leaving them to work out the next step.
      if (/Connect FreshBooks first/i.test(err.message ?? '')) {
        setActiveFileId(f.id);
        setActiveId(f.id);
        toast('warning', 'FreshBooks not connected', 'Pehle FreshBooks connect karo, phir file link ho jayegi.');
        navigate(`/${workflow}/connect`);
        return;
      }
      toast('error', 'Could not connect', err.message);
    } finally {
      setBusyId(null);
    }
  }

  function onOpen(f: MigrationFileEntry) {
    if (!f.connected) {
      toast('warning', 'Not connected', 'Pehle is file ko FreshBooks company se connect karo.');
      return;
    }
    setActiveFileId(f.id);
    setActiveId(f.id);
    navigate(`/${workflow}/tracker`);
  }

  async function onHistory(f: MigrationFileEntry) {
    setBusyId(f.id);
    try {
      setHistoryFor(await getFileHistory(f.id));
    } catch (err: any) {
      toast('error', 'Could not load history', err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(f: MigrationFileEntry) {
    const runs = f.runCount ?? 0;
    const msg = runs > 0
      ? `Delete "${f.name}"?\n\n${runs} migration run(s) ki history KEPT rahegi (sirf is file se detach hogi).\nFreshBooks se kuch bhi delete nahi hoga.`
      : `Delete "${f.name}"?\n\nFreshBooks se kuch bhi delete nahi hoga.`;
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

  return (
    <div className="files-page" style={{ padding: '4px 0' }}>

      {/* ── header ── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card__head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Your Files</h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, opacity: .7 }}>
              {loading ? 'Loading…' : `${files.length} file${files.length === 1 ? '' : 's'} · ${files.filter(f => f.connected).length} connected`}
            </p>
          </div>
        </div>

        <div className="card__body">
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="New file name — e.g. Relentless 2024"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              disabled={creating}
            />
            <button className="btn btn--primary" disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : 'Create File'}
            </button>
          </form>
        </div>
      </div>

      {/* ── file grid ── */}
      {!loading && files.length === 0 && (
        <div className="card"><div className="card__body" style={{ textAlign: 'center', padding: 32, opacity: .7 }}>
          Abhi koi file nahi hai. Upar naam daal ke pehli file banao.
        </div></div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {files.map(f => {
          const isActive = activeId === f.id;
          return (
            <div key={f.id} className="card" style={isActive ? { outline: '2px solid var(--blue)' } : undefined}>
              <div className="card__body">
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 15 }}>{f.name}</strong>
                  {isActive && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)' }}>ACTIVE</span>}
                </div>

                <div style={{ fontSize: 12, opacity: .75, marginTop: 6 }}>
                  {f.connected
                    ? <>✅ {f.company ?? 'Connected'}{f.accountId ? ` · ${f.accountId}` : ''}</>
                    : <>⚪ Not connected</>}
                </div>

                <div style={{ fontSize: 12, opacity: .6, marginTop: 4 }}>
                  Created {fmtDate(f.createdAt)}
                  {typeof f.runCount === 'number' && ` · ${f.runCount} migration${f.runCount === 1 ? '' : 's'}`}
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                  {f.connected
                    ? <button className="btn btn--sm btn--primary" disabled={busyId === f.id} onClick={() => onOpen(f)}>Open</button>
                    : <button className="btn btn--sm btn--primary" disabled={busyId === f.id} onClick={() => onConnect(f)}>
                        {busyId === f.id ? 'Connecting…' : 'Connect FreshBooks'}
                      </button>}
                  <button className="btn btn--sm btn--ghost" disabled={busyId === f.id} onClick={() => onHistory(f)}>History</button>
                  <button className="btn btn--sm btn--ghost" disabled={busyId === f.id} onClick={() => onDelete(f)}
                          style={{ marginLeft: 'auto', color: 'var(--error)' }}>Delete</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── history panel ── */}
      {historyFor && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card__head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>History — {historyFor.file.name}</h3>
            <button className="btn btn--sm btn--ghost" onClick={() => setHistoryFor(null)}>Close</button>
          </div>
          <div className="card__body">
            {historyFor.runs.length === 0
              ? <div style={{ opacity: .7, padding: 12 }}>Is file ke neeche abhi koi migration nahi chali.</div>
              : historyFor.runs.map(r => (
                  <div key={r.id} style={{ borderTop: '1px solid var(--border, #e5e7eb)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13 }}>Run #{r.id}</strong>
                      <span style={{ fontSize: 12, opacity: .7 }}>{new Date(r.startedAt).toLocaleString()}</span>
                      <span style={{ fontSize: 12, opacity: .7 }}>{r.status}</span>
                      {r.triggeredBy && <span style={{ fontSize: 12, opacity: .6 }}>by {r.triggeredBy}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                        ✓ {r.totals.success} · ⚡ {r.totals.skipped} · ✗ {r.totals.failed}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, opacity: .75, marginTop: 4 }}>
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
