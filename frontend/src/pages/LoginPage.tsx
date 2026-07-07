import { useState, useEffect, FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getAppToken, setAppToken, setAppUser, isLoggedIn } from '../lib/appAuth.js';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:1073';

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/';

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  useEffect(() => {
    if (isLoggedIn()) navigate(next, { replace: true });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API}/auth/app/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed.');
        return;
      }
      setAppToken(data.token);
      setAppUser(data.user);
      navigate(next, { replace: true });
    } catch {
      setError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg, #F4F5F9)',
      padding: '24px 16px',
    }}>
      <div className="landing__bg" />

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>

        <div className="landing__brand">
          <img src="/nlogosmall.png" alt="MMC Convert" className="landing__logo" />
        </div>

        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '36px 40px',
          width: '100%',
          boxShadow: '0 4px 28px rgba(0,0,0,0.13)',
        }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: 'var(--text-1)', textAlign: 'center' }}>
            Sign in to your account
          </h2>
          <p style={{ margin: '0 0 28px', fontSize: 13, color: 'var(--text-3)', textAlign: 'center' }}>
            Enter your credentials to continue
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Email</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                disabled={loading}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                disabled={loading}
              />
            </div>

            {error && (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--error, #CE2C3F)', fontWeight: 500 }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              className="btn btn--primary"
              disabled={loading}
              style={{ marginTop: 4, width: '100%', height: 42 }}
            >
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0 }}>MMC Convert · Data Migration Platform</p>
      </div>
    </div>
  );
}
