import { useState, useEffect, FormEvent } from 'react';
import { getAppToken, getAppUser, clearAppToken } from '../lib/appAuth.js';
import { useNavigate } from 'react-router-dom';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:1073';
const ADMIN_API = `${API}/api/admin`;

type User = { id: number; email: string; name: string; role: string; createdAt: string };
type Phase = { entity: string; status: string; total: number; success: number; failed: number; skipped: number; startedAt: string | null; durationMs: number };
type Run  = { id: number; status: string; company: string; startedAt: string | null; completedAt: string | null; phases: Phase[] };
type Stats = { userCount: number; runCount: number; activeRuns: number; connectedAccounts: number };

function authHeaders() {
  const t = getAppToken();
  return t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: '#16a34a', PARTIAL: '#d97706', FAILED: '#dc2626',
  RUNNING: '#2563eb', PENDING: '#9ca3af', CANCELLED: '#6b7280',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: STATUS_COLOR[status] + '22', color: STATUS_COLOR[status] || '#666' }}>
      {status}
    </span>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AdminPage() {
  const navigate  = useNavigate();
  const appUser   = getAppUser();
  const [tab, setTab] = useState<'users' | 'activity'>('users');

  // Users state
  const [users,    setUsers]    = useState<User[]>([]);
  const [uLoading, setULoading] = useState(true);
  const [uError,   setUError]   = useState('');

  // Create user form
  const [showForm,  setShowForm]  = useState(false);
  const [fName,     setFName]     = useState('');
  const [fEmail,    setFEmail]    = useState('');
  const [fPassword, setFPassword] = useState('');
  const [fRole,     setFRole]     = useState('user');
  const [fError,    setFError]    = useState('');
  const [fLoading,  setFLoading]  = useState(false);

  // Edit user
  const [editId,       setEditId]       = useState<number | null>(null);
  const [editPassword, setEditPassword] = useState('');
  const [editRole,     setEditRole]     = useState('user');
  const [editLoading,  setEditLoading]  = useState(false);

  // Activity state
  const [runs,    setRuns]    = useState<Run[]>([]);
  const [rLoading, setRLoading] = useState(false);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);

  // Stats
  const [stats, setStats] = useState<Stats | null>(null);

  const goToApp = () => {
    const wf = localStorage.getItem('oauth_workflow') || 'excel';
    navigate(`/${wf}/connect`);
  };

  useEffect(() => {
    if (appUser?.role !== 'admin') { navigate('/'); return; }
    fetchStats();
    fetchUsers();
  }, []);

  useEffect(() => {
    if (tab === 'activity') fetchActivity();
  }, [tab]);

  async function fetchStats() {
    try {
      const r = await fetch(`${ADMIN_API}/stats`, { headers: authHeaders() });
      if (r.ok) setStats(await r.json());
    } catch {}
  }

  async function fetchUsers() {
    setULoading(true);
    try {
      const r = await fetch(`${ADMIN_API}/users`, { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) setUsers(d.users);
      else setUError(d.error || 'Failed to load users.');
    } catch { setUError('Network error.'); }
    finally { setULoading(false); }
  }

  async function fetchActivity() {
    setRLoading(true);
    try {
      const r = await fetch(`${ADMIN_API}/activity`, { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) setRuns(d.runs);
    } catch {}
    finally { setRLoading(false); }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFError(''); setFLoading(true);
    try {
      const r = await fetch(`${ADMIN_API}/users`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ email: fEmail, name: fName, password: fPassword, role: fRole }),
      });
      const d = await r.json();
      if (!r.ok) { setFError(d.error || 'Failed.'); return; }
      setUsers(prev => [...prev, d.user]);
      setShowForm(false); setFName(''); setFEmail(''); setFPassword(''); setFRole('user');
      fetchStats();
    } catch { setFError('Network error.'); }
    finally { setFLoading(false); }
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${ADMIN_API}/users/${id}`, { method: 'DELETE', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) { alert(d.error); return; }
      setUsers(prev => prev.filter(u => u.id !== id));
      fetchStats();
    } catch { alert('Network error.'); }
  }

  async function handleUpdate(id: number) {
    setEditLoading(true);
    try {
      const r = await fetch(`${ADMIN_API}/users/${id}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ role: editRole, ...(editPassword ? { password: editPassword } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) { alert(d.error); return; }
      setUsers(prev => prev.map(u => u.id === id ? d.user : u));
      setEditId(null); setEditPassword('');
    } catch { alert('Network error.'); }
    finally { setEditLoading(false); }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #F4F5F9)', padding: '24px 20px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-1)' }}>Admin Panel</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-3)' }}>Manage users and monitor activity</p>
          </div>
          <button className="btn btn--ghost" onClick={goToApp} style={{ fontSize: 13 }}>
            ← Back to App
          </button>
        </div>

        {/* Stats */}
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
            {[
              { label: 'Total Users',        value: stats.userCount },
              { label: 'Migration Runs',     value: stats.runCount },
              { label: 'Active Right Now',   value: stats.activeRuns },
              { label: 'FB Accounts',        value: stats.connectedAccounts },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px' }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--blue)' }}>{s.value}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, width: 'fit-content' }}>
          {(['users', 'activity'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '7px 20px', borderRadius: 7, fontSize: 13, fontWeight: 600,
              background: tab === t ? 'var(--blue)' : 'transparent',
              color: tab === t ? '#fff' : 'var(--text-2)',
              transition: 'all 0.15s',
            }}>
              {t === 'users' ? 'Users' : 'Activity Monitor'}
            </button>
          ))}
        </div>

        {/* ── USERS TAB ── */}
        {tab === 'users' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Users ({users.length})</h2>
              <button className="btn btn--primary" style={{ fontSize: 12, height: 34 }} onClick={() => setShowForm(v => !v)}>
                {showForm ? 'Cancel' : '+ Add User'}
              </button>
            </div>

            {/* Create form */}
            {showForm && (
              <form onSubmit={handleCreate} style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px' }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Name</label>
                  <input className="input" style={{ height: 36 }} value={fName} onChange={e => setFName(e.target.value)} placeholder="Full name" required />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Email</label>
                  <input className="input" style={{ height: 36 }} type="email" value={fEmail} onChange={e => setFEmail(e.target.value)} placeholder="user@example.com" required />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px' }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Password</label>
                  <input className="input" style={{ height: 36 }} type="password" value={fPassword} onChange={e => setFPassword(e.target.value)} placeholder="••••••••" required />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Role</label>
                  <select className="input" style={{ height: 36, width: 100 }} value={fRole} onChange={e => setFRole(e.target.value)}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button className="btn btn--primary" style={{ height: 36, fontSize: 12 }} type="submit" disabled={fLoading}>
                  {fLoading ? 'Creating…' : 'Create'}
                </button>
                {fError && <p style={{ width: '100%', margin: 0, fontSize: 12, color: 'var(--error, #CE2C3F)' }}>{fError}</p>}
              </form>
            )}

            {/* Users table */}
            {uLoading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
            ) : uError ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--error, #CE2C3F)' }}>{uError}</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg)' }}>
                    {['Name', 'Email', 'Role', 'Created', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '10px 20px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <>
                      <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '12px 20px', fontWeight: 600 }}>{u.name}</td>
                        <td style={{ padding: '12px 20px', color: 'var(--text-2)' }}>{u.email}</td>
                        <td style={{ padding: '12px 20px' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: u.role === 'admin' ? '#EEF2FF' : '#F3F4F6', color: u.role === 'admin' ? 'var(--blue)' : 'var(--text-2)' }}>
                            {u.role}
                          </span>
                        </td>
                        <td style={{ padding: '12px 20px', color: 'var(--text-3)', fontSize: 12 }}>{fmtDate(u.createdAt)}</td>
                        <td style={{ padding: '12px 20px' }}>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              className="btn btn--ghost"
                              style={{ fontSize: 11, height: 28, padding: '0 10px' }}
                              onClick={() => { setEditId(editId === u.id ? null : u.id); setEditRole(u.role); setEditPassword(''); }}
                            >
                              {editId === u.id ? 'Cancel' : 'Edit'}
                            </button>
                            {appUser?.userId !== u.id && (
                              <button
                                className="btn"
                                style={{ fontSize: 11, height: 28, padding: '0 10px', background: '#FEE2E5', color: '#CE2C3F' }}
                                onClick={() => handleDelete(u.id, u.name)}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {editId === u.id && (
                        <tr key={`edit-${u.id}`} style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
                          <td colSpan={5} style={{ padding: '12px 20px' }}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>New Password (leave blank to keep)</label>
                                <input className="input" style={{ height: 34, width: 200 }} type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="••••••••" />
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>Role</label>
                                <select className="input" style={{ height: 34, width: 100 }} value={editRole} onChange={e => setEditRole(e.target.value)}>
                                  <option value="user">User</option>
                                  <option value="admin">Admin</option>
                                </select>
                              </div>
                              <button className="btn btn--primary" style={{ height: 34, fontSize: 12 }} onClick={() => handleUpdate(u.id)} disabled={editLoading}>
                                {editLoading ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── ACTIVITY TAB ── */}
        {tab === 'activity' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn--ghost" style={{ fontSize: 12, height: 34 }} onClick={fetchActivity} disabled={rLoading}>
                {rLoading ? 'Refreshing…' : '↻ Refresh'}
              </button>
            </div>

            {rLoading && !runs.length ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
            ) : runs.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>No migration runs yet.</div>
            ) : runs.map(run => (
              <div key={run.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                >
                  <StatusBadge status={run.status} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{run.company}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                      Run #{run.id} · Started {fmtDate(run.startedAt)}
                      {run.completedAt && ` · Finished ${fmtDate(run.completedAt)}`}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {run.phases.length} phase{run.phases.length !== 1 ? 's' : ''}
                  </div>
                  <span style={{ color: 'var(--text-3)', fontSize: 16 }}>{expandedRun === run.id ? '▲' : '▼'}</span>
                </div>

                {expandedRun === run.id && (
                  <div style={{ borderTop: '1px solid var(--border)' }}>
                    {run.phases.length === 0 ? (
                      <div style={{ padding: '12px 18px', fontSize: 13, color: 'var(--text-3)' }}>No phases recorded.</div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg)' }}>
                            {['Entity', 'Status', 'Total', 'Success', 'Failed', 'Skipped', 'Started', 'Duration'].map(h => (
                              <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {run.phases.map((p, i) => (
                            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                              <td style={{ padding: '8px 16px', fontWeight: 600, textTransform: 'capitalize' }}>{p.entity.replace(/_/g, ' ').toLowerCase()}</td>
                              <td style={{ padding: '8px 16px' }}><StatusBadge status={p.status} /></td>
                              <td style={{ padding: '8px 16px' }}>{p.total}</td>
                              <td style={{ padding: '8px 16px', color: '#16a34a', fontWeight: 600 }}>{p.success}</td>
                              <td style={{ padding: '8px 16px', color: p.failed > 0 ? '#dc2626' : 'var(--text-3)', fontWeight: p.failed > 0 ? 700 : 400 }}>{p.failed}</td>
                              <td style={{ padding: '8px 16px', color: 'var(--text-3)' }}>{p.skipped}</td>
                              <td style={{ padding: '8px 16px', color: 'var(--text-3)' }}>{fmtDate(p.startedAt)}</td>
                              <td style={{ padding: '8px 16px', color: 'var(--text-3)' }}>{p.durationMs ? `${(p.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
