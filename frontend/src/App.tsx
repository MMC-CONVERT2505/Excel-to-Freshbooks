import { Routes, Route, Navigate, useSearchParams, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { setSessionId } from './lib/session.js';
import { isLoggedIn } from './lib/appAuth.js';
import { getActiveFileId } from './lib/activeFile.js';
import { useApp } from './context/AppContext';
import { useToast } from './context/ToastContext';
import { MigrationProvider } from './context/MigrationContext';
import Landing from './components/Landing';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import LoginPage from './pages/LoginPage';
import AdminPage from './pages/AdminPage';
import ConnectPage from './pages/ConnectPage';
import FilesPage from './pages/FilesPage';
import UploadPage from './pages/UploadPage';
import TrackerPage from './pages/TrackerPage';
import QAPage from './pages/QAPage';
import EntityPage from './pages/EntityPage';
import WavePage from './pages/WavePage';
import HistoryPage from './pages/HistoryPage';
import EstimateLinesPage from './pages/EstimateLinesPage';
import FetchPage from './pages/FetchPage';

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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isLoggedIn()) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <>{children}</>;
}

// Migration pages need a file to work inside — that file is what decides which
// company the push targets and which history the run is grouped under. Without one
// selected, send the user back to the dashboard to pick or create it rather than
// letting them upload and push into no file at all.
function RequireFile({ children }: { children: React.ReactNode }) {
  const { workflow = 'excel' } = useParams<{ workflow: string }>();
  if (!getActiveFileId()) {
    return <Navigate to={`/${workflow}/files`} replace />;
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
    const session  = params.get('session');
    const workflow = localStorage.getItem('oauth_workflow') || 'qbd';
    const name     = params.get('name') || '';

    if (session) setSessionId(session);

    if (auth === 'connected') {
      setFbConnected(true);
      if (name) setCompanyName(decodeURIComponent(name));
      // Back to the dashboard, not the connect page: the connection still has to be
      // linked to a file before any function opens, and that button lives on the file.
      toast('success', 'FreshBooks connected!', 'Now link this connection to your file.');
      navigate(`/${workflow}/files?status=connected`, { replace: true });
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
        <Route path="/login"          element={<LoginPage />} />
        <Route path="/admin"          element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/oauth-callback" element={<OAuthCallback />} />
        <Route path="/:workflow"      element={<Navigate to="files" replace />} />
        <Route path="/:workflow/files"   element={<RequireAuth><AppLayout><FilesPage /></AppLayout></RequireAuth>} />
        <Route path="/:workflow/connect" element={<RequireAuth><AppLayout><ConnectPage /></AppLayout></RequireAuth>} />
        <Route path="/:workflow/upload"  element={<RequireAuth><RequireFile><AppLayout><UploadPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/tracker" element={<RequireAuth><RequireFile><AppLayout><TrackerPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/qa"      element={<RequireAuth><RequireFile><AppLayout><QAPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/entity/:entityId" element={<RequireAuth><RequireFile><AppLayout><EntityPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/wave/:waveId"     element={<RequireAuth><RequireFile><AppLayout><WavePage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/history"            element={<RequireAuth><RequireFile><AppLayout><HistoryPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/estimate-items"    element={<RequireAuth><RequireFile><AppLayout><EstimateLinesPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="/:workflow/fetch"             element={<RequireAuth><RequireFile><AppLayout><FetchPage /></AppLayout></RequireFile></RequireAuth>} />
        <Route path="*"               element={<Navigate to="/" replace />} />
      </Routes>
    </AuthCheck>
  );
}
