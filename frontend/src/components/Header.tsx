import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useMigration } from '../context/MigrationContext';
import type { Workflow } from '../context/AppContext';

const TITLES: Record<string, string> = {
  connect: 'Connect FreshBooks',
  upload:  'Upload & Push',
  tracker: 'Overview',
  qa:      'QA Report',
};

interface Props {
  workflow:    Workflow;
  onHamburger: () => void;
}

export default function Header({ workflow, onHamburger }: Props) {
  const { fbConnected, companyName } = useApp();
  const { entities } = useMigration();
  const navigate = useNavigate();
  const location = useLocation();
  const params   = useParams<{ entityId?: string; waveId?: string }>();

  // Resolve the page title
  let title = 'Dashboard';
  let crumb = 'Dashboard';

  if (params.entityId) {
    const ent = entities.find(e => e.id === params.entityId);
    title = ent?.name ?? params.entityId;
    crumb = title;
  } else if (params.waveId) {
    const num = params.waveId.replace('wave-', 'Wave ');
    title = num;
    crumb = num;
  } else {
    const segment = location.pathname.split('/').at(-1) || 'connect';
    title = TITLES[segment] ?? 'Dashboard';
    crumb = title;
  }

  const chipLabel = fbConnected ? (companyName || 'FreshBooks connected') : 'Not connected';

  return (
    <header className="header">
      <button className="hamburger" onClick={onHamburger} title="Menu">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      <div className="header__title">
        <h1>{title}</h1>
        <div className="breadcrumb">
          MMC Convert <span>›</span>
          <b style={{ color:'var(--blue)', textTransform:'capitalize' }}>{workflow}</b>
          <span>›</span> <b>{crumb}</b>
        </div>
      </div>

      <button
        className={`fb-chip${fbConnected ? ' connected' : ''}`}
        onClick={() => navigate(`/${workflow}/connect`)}
        style={{ marginLeft:'auto' }}
      >
        <span className="fb-chip__dot" />
        {fbConnected && companyName ? (
          <>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, opacity:.7 }}>
              <path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>
            </svg>
            <span style={{ fontWeight:700 }}>{companyName}</span>
          </>
        ) : (
          <span>{chipLabel}</span>
        )}
      </button>
    </header>
  );
}
