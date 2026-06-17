import { useState, useEffect } from 'react';
import { getProjects } from '../lib/api';
import type { FBProject } from '../lib/api';
// @ts-ignore
import XLSXStyle from 'xlsx-js-style';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

function fmtMoney(val: string | number | null): string {
  if (val === null || val === undefined || val === '') return '—';
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
}

function downloadProjectsExcel(projects: FBProject[]) {
  const HEADER = ['ID', 'Title', 'Description', 'Type', 'Budget', 'Fixed Price', 'Billed Amount', 'Billed Status', 'Due Date', 'Status', 'Created'];

  const HDR_STYLE = {
    fill: { fgColor: { rgb: '4338CA' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: { top: { style: 'thin', color: { rgb: 'FFFFFF' } }, bottom: { style: 'thin', color: { rgb: 'FFFFFF' } }, left: { style: 'thin', color: { rgb: 'FFFFFF' } }, right: { style: 'thin', color: { rgb: 'FFFFFF' } } },
  };
  const ROW_STYLE = {
    font: { sz: 11 },
    alignment: { vertical: 'center', wrapText: false },
    border: { top: { style: 'thin', color: { rgb: 'E6EAF1' } }, bottom: { style: 'thin', color: { rgb: 'E6EAF1' } }, left: { style: 'thin', color: { rgb: 'E6EAF1' } }, right: { style: 'thin', color: { rgb: 'E6EAF1' } } },
  };

  const rows = projects.map(p => [
    p.id,
    p.title,
    p.description ?? '',
    p.project_type === 'fixed_price' ? 'Fixed Price' : p.project_type === 'hourly_rate' ? 'Hourly Rate' : p.project_type,
    p.budget ?? '',
    p.fixed_price ?? '',
    p.billed_amount ?? '',
    p.billed_status,
    p.due_date ?? '',
    p.active ? 'Active' : 'Archived',
    p.created_at ? p.created_at.slice(0, 10) : '',
  ]);

  const ws = XLSXStyle.utils.aoa_to_sheet([HEADER, ...rows]);
  ws['!cols'] = [6, 28, 36, 14, 12, 12, 14, 14, 12, 10, 12].map(wch => ({ wch }));
  ws['!rows'] = [{ hpt: 22 }];

  // style header
  HEADER.forEach((_, i) => {
    const addr = XLSXStyle.utils.encode_cell({ r: 0, c: i });
    if (ws[addr]) ws[addr].s = HDR_STYLE;
  });
  // style data rows
  rows.forEach((_, ri) => {
    HEADER.forEach((_, ci) => {
      const addr = XLSXStyle.utils.encode_cell({ r: ri + 1, c: ci });
      if (ws[addr]) ws[addr].s = { ...ROW_STYLE, fill: { fgColor: { rgb: ri % 2 === 0 ? 'FFFFFF' : 'F8F9FB' } } };
    });
  });

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, 'Projects');
  XLSXStyle.writeFile(wb, 'freshbooks_projects.xlsx');
}

function ProjectTypeBadge({ type }: { type: string }) {
  const label = type === 'fixed_price' ? 'Fixed Price'
    : type === 'hourly_rate' ? 'Hourly'
    : type;
  const cls = type === 'fixed_price' ? 'proj-badge--blue' : 'proj-badge--purple';
  return <span className={`proj-badge ${cls}`}>{label}</span>;
}

function BilledBadge({ status }: { status: string }) {
  if (status === 'billed')   return <span className="proj-badge proj-badge--green">Billed</span>;
  if (status === 'partial')  return <span className="proj-badge proj-badge--amber">Partial</span>;
  return <span className="proj-badge proj-badge--grey">Unbilled</span>;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<FBProject[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [search, setSearch]     = useState('');

  useEffect(() => {
    getProjects()
      .then(({ projects: p }) => { setProjects(p); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  function reload() {
    setLoading(true); setError(null);
    getProjects()
      .then(({ projects: p }) => { setProjects(p); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }

  const filtered = search
    ? projects.filter(p =>
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        (p.description || '').toLowerCase().includes(search.toLowerCase()))
    : projects;

  const active   = filtered.filter(p => p.active);
  const inactive = filtered.filter(p => !p.active);

  return (
    <div className="proj-wrap">

      {/* header */}
      <div className="proj-header">
        <div className="proj-header__text">
          <h2 className="proj-header__title">FreshBooks Projects</h2>
          <p className="proj-header__sub">
            {loading ? 'Loading…' : `${projects.length} project${projects.length !== 1 ? 's' : ''} in this account`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn--primary btn--sm"
            onClick={() => downloadProjectsExcel(projects)}
            disabled={loading || projects.length === 0}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Excel
          </button>
          <button className="btn btn--ghost btn--sm" onClick={reload} disabled={loading}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* search */}
      {!loading && !error && projects.length > 0 && (
        <div className="proj-search-row">
          <div className="proj-search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              className="proj-search__input"
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="proj-search__clear" onClick={() => setSearch('')}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* states */}
      {loading && (
        <div className="proj-state">
          <div className="proj-spinner" />
          <span>Fetching projects from FreshBooks…</span>
        </div>
      )}

      {!loading && error && (
        <div className="proj-state proj-state--error">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <b>Failed to load projects</b>
          <span>{error}</span>
          <button className="btn btn--ghost btn--sm" onClick={reload}>Try again</button>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="proj-state">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}>
            <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <b>No projects found</b>
          <span>This FreshBooks account has no projects yet.</span>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && projects.length > 0 && (
        <div className="proj-state">
          <span>No projects match "<b>{search}</b>"</span>
        </div>
      )}

      {/* active projects */}
      {active.length > 0 && (
        <>
          <div className="proj-section-label">Active <span className="proj-count">{active.length}</span></div>
          <div className="proj-grid">
            {active.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        </>
      )}

      {/* archived projects */}
      {inactive.length > 0 && (
        <>
          <div className="proj-section-label" style={{ marginTop: 24 }}>
            Archived <span className="proj-count">{inactive.length}</span>
          </div>
          <div className="proj-grid">
            {inactive.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        </>
      )}

    </div>
  );
}

function ProjectCard({ project: p }: { project: FBProject }) {
  return (
    <div className={`proj-card card${!p.active ? ' proj-card--archived' : ''}`}>
      <div className="proj-card__head">
        <div className="proj-card__title">{p.title}</div>
        <ProjectTypeBadge type={p.project_type} />
      </div>

      {p.description && (
        <p className="proj-card__desc">{p.description}</p>
      )}

      <div className="proj-card__stats">
        <div className="proj-card__stat">
          <span className="proj-card__stat-label">Budget</span>
          <span className="proj-card__stat-val">
            {p.fixed_price ? fmtMoney(p.fixed_price) : p.budget ? fmtMoney(p.budget) : '—'}
          </span>
        </div>
        <div className="proj-card__stat">
          <span className="proj-card__stat-label">Billed</span>
          <span className="proj-card__stat-val">{fmtMoney(p.billed_amount)}</span>
        </div>
        <div className="proj-card__stat">
          <span className="proj-card__stat-label">Due</span>
          <span className="proj-card__stat-val">{fmtDate(p.due_date)}</span>
        </div>
      </div>

      <div className="proj-card__foot">
        <BilledBadge status={p.billed_status} />
        <span className="proj-card__created">Created {fmtDate(p.created_at)}</span>
      </div>
    </div>
  );
}
