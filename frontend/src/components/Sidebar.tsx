import { useNavigate, useLocation } from 'react-router-dom';
import { downloadAllStyledTemplates } from '../lib/templateExcel';
import type { Workflow } from '../context/AppContext';
import { useMigration } from '../context/MigrationContext';
import { templateFor } from '../data/entities';
import { clearAppToken, getAppUser } from '../lib/appAuth.js';

const ENTITY_ORDER = [
  'chart-of-accounts',
  'clients',
  'vendors',
  'items',
  'services',
  'expenses',
  'income',
  'invoices',
  'sales-receipts',
  'bills',
  'credit-notes',
  'invoice-payments',
  'bill-payments',
  'journal-entries',
];

function downloadAllTemplates(entities: ReturnType<typeof useMigration>['entities']) {
  const sheets = ENTITY_ORDER.map(id => ({
    cols: templateFor(id),
    sheetName: entities.find(e => e.id === id)?.name ?? id,
  }));
  downloadAllStyledTemplates(sheets, 'mmc_migration_templates.xlsx');
}

interface Props {
  workflow: Workflow;
  open: boolean;
  onClose: () => void;
  onChangeWf: () => void;
}

export default function Sidebar({ workflow, open, onClose, onChangeWf }: Props) {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { entities } = useMigration();
  const appUser = getAppUser();

  function go(path: string) { navigate(`/${workflow}/${path}`); onClose(); }

  function handleLogout() {
    clearAppToken();
    navigate('/');
  }

  const wfName = workflow === 'qbd' ? 'QBD → FreshBooks' : 'Excel → FreshBooks';

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar__logo">
        <img src="/nlogosmall.png" alt="MMC Convert" className="sidebar__img-logo" />
        <div className="logo-word"><b>MMC Convert</b><span>Data Migration</span></div>
      </div>

      <nav className="sidebar__nav">

        {/* connect */}
        <div className="nav-section">
          <button
            className={`nav-item${location.pathname === `/${workflow}/connect` ? ' active' : ''}`}
            onClick={() => go('connect')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>
            </svg>
            Connect FreshBooks
          </button>

          {/* migration history */}
          <button
            className={`nav-item${location.pathname === `/${workflow}/history` ? ' active' : ''}`}
            onClick={() => go('history')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Migration History
          </button>

          {/* admin panel — only for admin role */}
          {appUser?.role === 'admin' && (
            <button
              className={`nav-item${location.pathname === '/admin' ? ' active' : ''}`}
              onClick={() => { navigate('/admin'); onClose(); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              Admin Panel
            </button>
          )}

          {/* download all templates */}
          <button className="nav-item sb-tpl-btn" onClick={() => downloadAllTemplates(entities)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download All Templates
          </button>
        </div>

        {/* entities */}
        <div className="nav-section">
          <div className="nav-section__label">Entities</div>
          {ENTITY_ORDER.map(id => {
            const ent      = entities.find(e => e.id === id);
            const isActive = location.pathname === `/${workflow}/entity/${id}`;
            return (
              <button
                key={id}
                className={`nav-item sb-ent${isActive ? ' active' : ''}`}
                onClick={() => go(`entity/${id}`)}
              >
                {ent?.name ?? id}
              </button>
            );
          })}
        </div>

      </nav>

      <div className="wf-indicator">
        <div className="wf-indicator__icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9m-9 9a9 9 0 0 1 9-9"/>
          </svg>
        </div>
        <div className="wf-indicator__meta">
          <span className="lbl">Active workflow</span>
          <b>{wfName}</b>
        </div>
        <button className="wf-indicator__change" title="Change workflow" onClick={onChangeWf}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5"/>
          </svg>
        </button>
      </div>

      {appUser && (
        <div className="sidebar__user">
          <div className="sidebar__user-info">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
            <span>{appUser.name}</span>
          </div>
          <button className="sidebar__logout" onClick={handleLogout} title="Sign out">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}
