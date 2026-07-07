import { useNavigate } from 'react-router-dom';
import type { Workflow } from '../context/AppContext';
import { isLoggedIn } from '../lib/appAuth.js';

export default function Landing() {
  const navigate = useNavigate();

  function choose(wf: Workflow) {
    localStorage.setItem('oauth_workflow', wf);
    if (!isLoggedIn()) {
      navigate(`/login?next=/${wf}/connect`);
    } else {
      navigate(`/${wf}/connect`);
    }
  }

  return (
    <div className="landing">
      <div className="landing__bg" />
      <div className="landing__inner">

        {/* Brand */}
        <div className="landing__brand">
          <img src="/nlogosmall.png" alt="MMC Convert" className="landing__logo" />
        </div>


        <h1 className="landing__title">How do you want to migrate?</h1>
        <p className="landing__sub">
          Choose your source. We'll move everything into FreshBooks for you,<br />
          in the right order.
        </p>

        <div className="lan-cards">
          {/* QBD card */}
          <button className="lan-card" onClick={() => choose('qbd')}>
            <div className="lan-flow">
              <span className="lan-node lan-node--src">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h3"/>
                </svg>
                QBD
              </span>
              <span className="lan-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6"/>
                </svg>
              </span>
              <span className="lan-node lan-node--dst">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>
                </svg>
                FB
              </span>
            </div>
            <h3>QuickBooks Desktop → FreshBooks</h3>
            <p>Read your QBD export Excel files, then push every record into FreshBooks.</p>
            <span className="lan-card__cta">
              Start with QBD
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </span>
          </button>

          {/* Excel card */}
          <button className="lan-card" onClick={() => choose('excel')}>
            <div className="lan-flow">
              <span className="lan-node lan-node--green">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8l8 8M16 8l-8 8"/>
                </svg>
                XLS
              </span>
              <span className="lan-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6"/>
                </svg>
              </span>
              <span className="lan-node lan-node--dst">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>
                </svg>
                FB
              </span>
            </div>
            <h3>Excel Template → FreshBooks</h3>
            <p>Already have a pre-filled Excel template? Skip parsing and push straight to FreshBooks.</p>
            <span className="lan-card__cta">
              Start with Excel
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </span>
          </button>
        </div>

        <p className="landing__foot">You can switch workflows anytime from the sidebar.</p>
      </div>
    </div>
  );
}
