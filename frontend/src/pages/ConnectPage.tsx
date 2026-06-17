import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import freshbooksMark from '../assets/freshbooks-mark-transparent.png';
import { getCompanies, switchCompany, updateCompanyLabel } from '../lib/api';
import type { CompanyEntry } from '../lib/api';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:1073';

function FreshBooksIcon({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
      {/* Blue leaf/shield shape — rectangular left+bottom, leaf curve top-right */}
      <path
        d="M4 44C1.8 44 0 42.2 0 40V4C0 1.8 1.8 0 4 0H27C35.5 0 44 6.5 44 15C44 22.5 39.5 27 35 28.5V40C35 42.2 33.2 44 31 44Z"
        fill="#1B82E2"
      />
      {/* White bold F */}
      <path d="M9 13h19v5H14v5h13v5H14v8H9V13z" fill="white"/>
    </svg>
  );
}

void FreshBooksIcon;

interface BizOption { index: number; name: string; account_id: string; }

type Phase = 'idle' | 'selecting' | 'success';

export default function ConnectPage() {
  const { fbConnected, setFbConnected, setCompanyName } = useApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { workflow } = useParams<{ workflow: string }>();

  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [businesses, setBusinesses] = useState<BizOption[]>([]);
  const [selectedBiz, setSelectedBiz] = useState<string>('');
  const [selecting, setSelecting] = useState(false);
  const ran = useRef(false);

  // Company switcher state
  const [companies, setCompanies] = useState<CompanyEntry[]>([]);
  const [switching, setSwitching] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [savingLabel, setSavingLabel] = useState(false);

  // Load companies list whenever the connected state is active
  useEffect(() => {
    if (fbConnected) loadCompaniesList();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbConnected]);

  // Handle redirects from OAuth (after backend sends user back here)
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const status = searchParams.get('status');
    const auth   = searchParams.get('auth');

    if (status === 'connected') {
      setFbConnected(true);
      setPhase('success');
      loadCompaniesList();
      window.history.replaceState({}, '', `/${workflow}/connect`);
    } else if (auth === 'select') {
      try {
        const raw = searchParams.get('businesses');
        if (raw) {
          // searchParams.get() already URL-decodes — parse directly
          setBusinesses(JSON.parse(raw));
          setPhase('selecting');
        }
      } catch {
        toast('error', 'Could not load businesses', 'Try connecting again.');
      }
      window.history.replaceState({}, '', `/${workflow}/connect`);
    }
  }, []);

  async function selectBusiness(index: number, name: string) {
    setSelecting(true);
    try {
      const res = await fetch(`${API}/auth/select-business/${index}`);
      if (!res.ok) throw new Error(await res.text());
      setSelectedBiz(name);
      setFbConnected(true);
      setCompanyName(name);
      setPhase('success');
      toast('success', `Connected as "${name}"`, 'All functions are now unlocked.');
    } catch (err: any) {
      toast('error', 'Selection failed', err.message);
    } finally {
      setSelecting(false);
    }
  }

  function connect() {
    setLoading(true);
    localStorage.setItem('oauth_workflow', workflow || 'qbd');
    toast('info', 'Redirecting to FreshBooks', 'Approve access on the FreshBooks consent screen.');
    window.location.href = `${API}/auth/login`;
  }

  function disconnect() {
    setFbConnected(false);
    setPhase('idle');
    setBusinesses([]);
    setSelectedBiz('');
    setCompanies([]);
    toast('warning', 'FreshBooks disconnected', 'Functions are locked until you reconnect.');
  }

  async function loadCompaniesList() {
    try {
      const { companies: list } = await getCompanies();
      setCompanies(list);
    } catch { /* non-critical */ }
  }

  async function handleSwitch(tokenId: number) {
    setSwitching(tokenId);
    try {
      await switchCompany(tokenId);
      await loadCompaniesList();
      toast('success', 'Company switched', 'Migration data now shows for the selected company.');
    } catch (err: any) {
      toast('error', 'Switch failed', err.message);
    } finally {
      setSwitching(null); }
  }

  async function saveLabel(tokenId: number) {
    if (!editLabel.trim()) return;
    setSavingLabel(true);
    try {
      await updateCompanyLabel(tokenId, editLabel.trim());
      await loadCompaniesList();
      setEditingId(null);
    } catch (err: any) {
      toast('error', 'Could not save label', err.message);
    } finally {
      setSavingLabel(false);
    }
  }

  // ── Phase: Select business ──────────────────────────────────────────
  if (phase === 'selecting') {
    return (
      <div className="connect-wrap">
        <div className="card business-picker">
          <div className="card__head">
            <h3>Select your FreshBooks business</h3>
            <span className="sub">{businesses.length} businesses found</span>
          </div>
          <div className="card__body business-picker__body">
            <p className="business-picker__hint">
              Multiple businesses are on this account. Choose which one to migrate data into.
            </p>
            <div className="business-picker__list">
              {businesses.map(b => (
                <button
                  key={b.index}
                  className="business-option"
                  onClick={() => selectBusiness(b.index, b.name)}
                  disabled={selecting}
                >
                  <div className="business-option__avatar">
                    {b.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="business-option__meta">
                    <div className="business-option__name">{b.name}</div>
                    <div className="business-option__id">
                      ID: {b.account_id}
                    </div>
                  </div>
                  <svg className="business-option__arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase: Success ──────────────────────────────────────────────────
  if (phase === 'success' || fbConnected) {
    const currentCompany = companies.find(c => c.isCurrent);
    const displayName = currentCompany?.companyLabel || selectedBiz || null;

    return (
      <div className="connect-wrap">
        <div className="card">
          <div className="connected-card">
            <div className="connected-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h2>FreshBooks connected!</h2>
            <p>
              {displayName
                ? `"${displayName}" is linked and ready to receive your data.`
                : 'Your account is linked and ready to receive your data.'}
            </p>
            <div className="connected-meta">
              <span className="av av--logo"><img src={freshbooksMark} alt="FreshBooks" className="freshbooks-meta-logo" /></span>
              {displayName || 'FreshBooks account connected'}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 28, flexWrap: 'wrap' }}>
              <button className="btn btn--primary" style={{ height: 44, fontSize: 14 }} onClick={() => navigate(`/${workflow}/entity/chart-of-accounts`)}>
                Start Migration
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6"/>
                </svg>
              </button>
              <button className="btn btn--ghost" onClick={disconnect}>Disconnect</button>
            </div>
          </div>
        </div>

        {/* ── Stored companies ── */}
        {companies.length > 0 && (
          <div className="card co-list-card">
            <div className="co-list-head">
              <span className="co-list-head__title">Stored Companies</span>
              <span className="co-list-head__sub">Connect again to add another company</span>
            </div>
            <div className="co-list">
              {companies.map(co => (
                <div key={co.id} className={`co-item${co.isCurrent ? ' co-item--current' : ''}`}>
                  <div className="co-item__avatar">
                    {(co.companyLabel || co.accountId || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="co-item__meta">
                    {editingId === co.id ? (
                      <div className="co-item__edit-row">
                        <input
                          className="co-item__edit-input"
                          value={editLabel}
                          onChange={e => setEditLabel(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveLabel(co.id); if (e.key === 'Escape') setEditingId(null); }}
                          autoFocus
                        />
                        <button className="btn btn--sm btn--primary" onClick={() => saveLabel(co.id)} disabled={savingLabel}>Save</button>
                        <button className="btn btn--sm btn--ghost" onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="co-item__name-row">
                        <span className="co-item__name">{co.companyLabel || `Company (ID: ${co.accountId?.slice(-6) ?? co.id})`}</span>
                        <button className="co-item__rename" title="Rename" onClick={() => { setEditingId(co.id); setEditLabel(co.companyLabel || ''); }}>
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                      </div>
                    )}
                    <span className="co-item__id">Account ID: {co.accountId || '—'}</span>
                  </div>
                  <div className="co-item__action">
                    {co.isCurrent
                      ? <span className="co-item__current-badge">Active</span>
                      : <button
                          className="btn btn--sm btn--ghost"
                          onClick={() => handleSwitch(co.id)}
                          disabled={switching === co.id}
                        >
                          {switching === co.id ? 'Switching…' : 'Switch'}
                        </button>
                    }
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Phase: Idle (not connected) ─────────────────────────────────────
  return (
    <div className="connect-wrap">
      <div className="connect-hero">
        <div className="connect-logo">
          <img src={freshbooksMark} alt="FreshBooks" className="freshbooks-logo-img" />
        </div>
        <h2>Connect your FreshBooks account</h2>
        <p>Before you can upload files or run a migration, link the FreshBooks account your data will be pushed into.</p>
        <div className="connect-flow">
          <span className="node">
            <img src="/nlogosmall.png" alt="MMC Convert" className="connect-node-logo" />
          </span>
          <span className="arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </span>
          <span className="node">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            OAuth
          </span>
          <span className="arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </span>
          <span className="node node--freshbooks">
            <img src={freshbooksMark} alt="FreshBooks" className="freshbooks-flow-logo" />
          </span>
        </div>
      </div>

      <div className="connect-body">
        <ul className="connect-steps">
          <li>
            <span className="n">1</span>
            <div><b>Authorize MMC Convert</b><span>You'll approve read &amp; write access on FreshBooks' secure page.</span></div>
          </li>
          <li>
            <span className="n">2</span>
            <div><b>We store your tokens safely</b><span>OAuth tokens are saved server-side — we never see your password.</span></div>
          </li>
          <li>
            <span className="n">3</span>
            <div><b>Select your business &amp; migrate</b><span>If you have multiple businesses, choose which one to push into.</span></div>
          </li>
        </ul>

        <button className="btn btn--fb btn--block" onClick={connect} disabled={loading}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>
          </svg>
          {loading ? 'Opening FreshBooks…' : 'Connect FreshBooks Account'}
        </button>

        <div className="connect-secure">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          Secured by FreshBooks OAuth 2.0 · You can disconnect anytime
        </div>
      </div>
    </div>
  );
}
