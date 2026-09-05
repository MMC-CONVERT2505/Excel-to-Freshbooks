import { useState, useEffect, useRef, FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setAppToken, setAppUser, isLoggedIn } from '../lib/appAuth.js';
import { useToast } from '../context/ToastContext';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:1073';

/* Matches the CSS: 0.5s page transform is the longest leg, so wait it out before
   navigating. Under reduced motion the animation is skipped and so is this wait. */
const EXIT_MS = 520;

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const Tick = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const Spinner = () => (
  <svg className="lg-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" strokeOpacity=".25" />
    <path d="M12 3a9 9 0 0 1 9 9" />
  </svg>
);

const POINTS = [
  'Every client gets its own file — data never crosses between companies.',
  'Validate your sheet before pushing, so errors surface up front.',
  'Full history of every push, kept permanently.',
];

export default function LoginPage() {
  const navigate  = useNavigate();
  const { toast } = useToast();
  const [params]  = useSearchParams();
  const next = params.get('next') || '/';

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [errs,     setErrs]     = useState<{ email?: string; password?: string }>({});
  const [loading,  setLoading]  = useState(false);
  const [leaving,  setLeaving]  = useState(false);

  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (isLoggedIn()) navigate(next, { replace: true });
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // Inline validation. A toast is reserved for the submit itself failing —
    // a field problem belongs next to the field.
    const found: { email?: string; password?: string } = {};
    if (!email.trim())              found.email    = 'Email address is required.';
    else if (!EMAIL_RE.test(email.trim())) found.email = 'Enter a valid email address.';
    if (!password)                  found.password = 'Password is required.';

    setErrs(found);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    try {
      const res  = await fetch(`${API}/auth/app/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        const msg = data?.error || data?.message || 'Sign in failed.';
        setErrs({ password: msg });
        toast('error', 'Sign in failed', msg);
        setLoading(false);
        return;
      }

      setAppToken(data.token);
      setAppUser(data.user);

      // Play the exit, then navigate. loading stays true throughout so the form
      // cannot be resubmitted mid-animation.
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setLeaving(true);
      if (reduced) {
        navigate(next, { replace: true });
      } else {
        timer.current = window.setTimeout(() => navigate(next, { replace: true }), EXIT_MS);
      }
    } catch {
      const msg = 'Network error — please try again.';
      setErrs({ password: msg });
      toast('error', 'Sign in failed', msg);
      setLoading(false);
    }
  }

  return (
    <div className={`lg-page${leaving ? ' is-leaving' : ''}`}>

      {/* ── branded aside ── */}
      <aside className="lg-aside">
        <div className="lg-aside__glow lg-aside__glow--a" />
        <div className="lg-aside__glow lg-aside__glow--b" />
        <div className="lg-aside__grid" />

        <div className="lg-aside__inner">
          <div className="lg-lockup">
            <span className="lg-lockup__badge"><img src="/nlogosmall.png" alt="MMC Convert" /></span>
            {/* space in the filename has to be encoded or the request 404s */}
            <span className="lg-lockup__badge"><img src="/fb%20logo.png" alt="FreshBooks" /></span>
          </div>

          <h2 className="lg-head">
            Excel to FreshBooks,<br />
            <span className="lg-head__grad">without the mix-ups.</span>
          </h2>

          <ul className="lg-points">
            {POINTS.map(p => (
              <li className="lg-point" key={p}>
                <span className="lg-point__tick"><Tick /></span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* ── form ── */}
      <main className="lg-main">
        <div className="lg-form-wrap">

          <div className="lg-mobile-logo">
            <img src="/nlogosmall.png" alt="MMC Convert" />
            <b style={{ fontSize: 14, color: 'var(--ink-900)' }}>MMC Convert</b>
          </div>

          <h1 className="lg-title">Welcome back</h1>
          <p className="lg-sub">Sign in to continue to your workspace.</p>

          <form onSubmit={handleSubmit} noValidate>
            <div className="lg-field">
              <label className="lg-label" htmlFor="lg-email">Email address</label>
              <input
                id="lg-email"
                className={`lg-input${errs.email ? ' lg-input--err' : ''}`}
                type="email"
                value={email}
                onChange={e => { setEmail(e.target.value); if (errs.email) setErrs(v => ({ ...v, email: undefined })); }}
                placeholder="you@company.com"
                autoComplete="email"
                autoFocus
                disabled={loading}
              />
              {errs.email && <p className="lg-err">{errs.email}</p>}
            </div>

            <div className="lg-field">
              <label className="lg-label" htmlFor="lg-pw">Password</label>
              <div className="lg-pwwrap">
                <input
                  id="lg-pw"
                  className={`lg-input${errs.password ? ' lg-input--err' : ''}`}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); if (errs.password) setErrs(v => ({ ...v, password: undefined })); }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button
                  type="button"
                  className="lg-peek"
                  onClick={() => setShowPw(v => !v)}
                  disabled={loading}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
              {errs.password && <p className="lg-err">{errs.password}</p>}
            </div>

            <button type="submit" className="lg-submit" disabled={loading}>
              {loading ? <><Spinner /> Signing in…</> : 'Sign in'}
            </button>
          </form>

          {/* This product has no self-serve signup — accounts are created by an
              administrator — so this points at the real route rather than a
              /signup page that does not exist. */}
          <p className="lg-foot">Need an account? Ask your administrator to create one.</p>

          <p className="lg-mobile-foot">© 2026 MMC Convert</p>
        </div>
      </main>
    </div>
  );
}
