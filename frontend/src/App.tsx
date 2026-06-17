import { Routes, Route, Navigate, useSearchParams, useNavigate, useParams } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { useApp } from './context/AppContext';
import { useToast } from './context/ToastContext';
import { MigrationProvider } from './context/MigrationContext';
import Landing from './components/Landing';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import ConnectPage from './pages/ConnectPage';
import UploadPage from './pages/UploadPage';
import TrackerPage from './pages/TrackerPage';
import QAPage from './pages/QAPage';
import EntityPage from './pages/EntityPage';
import WavePage from './pages/WavePage';
import HistoryPage from './pages/HistoryPage';
import EstimateLinesPage from './pages/EstimateLinesPage';

function AuthCheck({ children }: { children: React.ReactNode }) {
  const { checkingAuth } = useApp();
  if (checkingAuth) {
    return (
      <div style={{ display:'grid', placeItems:'center', height:'100vh', background:'var(--bg)' }}>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:14 }}>
          <div style={{ width:36, height:36, borderRadius:'50%', border:'3px solid var(--blue-light)', borderTopColor:'var(--blue)', animation:'spin 0.7s linear infinite' }} />
          <span style={{ fontSize:13, color:'var(--text-3)', fontWeight:500 }}>Checking connection…</span>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }
  return <>{children}</>;
}

function OAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setFbConnected, setCompanyName } = useApp();
  const { toast } = useToast();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const auth     = params.get('auth');
    const workflow = localStorage.getItem('oauth_workflow') || 'qbd';
    const name     = params.get('name') || '';

    if (auth === 'connected') {
      setFbConnected(true);
      if (name) setCompanyName(decodeURIComponent(name));
      toast('success', 'FreshBooks connected!', 'Your account is linked — all functions are unlocked.');
      navigate(`/${workflow}/connect?status=connected`, { replace: true });
    } else if (auth === 'select') {
      // params.get() already URL-decodes the value; re-encode so the next page can safely parse it
      const biz = params.get('businesses') || '';
      navigate(`/${workflow}/connect?auth=select&businesses=${encodeURIComponent(biz)}`, { replace: true });
    } else {
      navigate('/', { replace: true });
    }
  }, []);

  return null;
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { workflow } = useParams<{ workflow: string }>();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (workflow !== 'qbd' && workflow !== 'excel') return <Navigate to="/" replace />;

  return (
    <MigrationProvider workflow={workflow}>
      <div className="app-shell show">
        <div className="app">
          <Sidebar
            workflow={workflow}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onChangeWf={() => navigate('/')}
          />
          {sidebarOpen && <div className="scrim show" onClick={() => setSidebarOpen(false)} />}
          <div className="main">
            <Header workflow={workflow} onHamburger={() => setSidebarOpen(true)} />
            <main className="content">{children}</main>
          </div>
        </div>
      </div>
    </MigrationProvider>
  );
}

export default function App() {
  return (
    <AuthCheck>
      <Routes>
        <Route path="/"               element={<Landing />} />
        <Route path="/oauth-callback" element={<OAuthCallback />} />
        <Route path="/:workflow"      element={<Navigate to="connect" replace />} />
        <Route path="/:workflow/connect" element={<AppLayout><ConnectPage /></AppLayout>} />
        <Route path="/:workflow/upload"  element={<AppLayout><UploadPage /></AppLayout>} />
        <Route path="/:workflow/tracker" element={<AppLayout><TrackerPage /></AppLayout>} />
        <Route path="/:workflow/qa"      element={<AppLayout><QAPage /></AppLayout>} />
        <Route path="/:workflow/entity/:entityId" element={<AppLayout><EntityPage /></AppLayout>} />
        <Route path="/:workflow/wave/:waveId"     element={<AppLayout><WavePage /></AppLayout>} />
        <Route path="/:workflow/history"            element={<AppLayout><HistoryPage /></AppLayout>} />
        <Route path="/:workflow/estimate-items"    element={<AppLayout><EstimateLinesPage /></AppLayout>} />
        <Route path="*"               element={<Navigate to="/" replace />} />
      </Routes>
    </AuthCheck>
  );
}
