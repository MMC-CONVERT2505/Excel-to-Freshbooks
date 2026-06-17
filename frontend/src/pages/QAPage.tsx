import { ENTITIES } from '../data/entities';
import { Badge } from '../components/CatIcon';

export default function QAPage() {
  return (
    <div>
      <div className="page-head"><h2>QA Report</h2></div>

      <div className="kpi-grid">
        <div className="kpi kpi--hover">
          <div className="kpi__top"><div className="kpi__icon ico-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div className="kpi__num">12</div><div className="kpi__label">Migrated</div>
        </div>
        <div className="kpi kpi--hover">
          <div className="kpi__top"><div className="kpi__icon ico-amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" strokeLinecap="round"/></svg></div></div>
          <div className="kpi__num">2</div><div className="kpi__label">Pending</div>
        </div>
        <div className="kpi kpi--hover">
          <div className="kpi__top"><div className="kpi__icon ico-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/></svg></div></div>
          <div className="kpi__num">0</div><div className="kpi__label">Failed</div>
        </div>
        <div className="kpi kpi--hover">
          <div className="kpi__top"><div className="kpi__icon ico-purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18M7 14l3-3 3 3 5-6"/></svg></div></div>
          <div className="kpi__num">96.4%</div><div className="kpi__label">Pass Rate</div>
        </div>
      </div>

      <div className="qa-grid">
        <div className="card card--hover">
          <div className="card__head"><h3>Overall Completion</h3></div>
          <div className="card__body">
            <div className="donut-wrap">
              <div className="donut">
                <div className="donut__center"><b>85%</b><span>Migrated</span></div>
              </div>
              <div className="donut-legend">
                <span><span className="lg-dot" style={{ background:'var(--blue)' }} />Migrated</span>
                <span><span className="lg-dot" style={{ background:'var(--purple)' }} />Pending</span>
                <span><span className="lg-dot" style={{ background:'#EDEFF3' }} />Not started</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card card--hover">
          <div className="card__head"><h3>Per-Entity Progress</h3><span className="sub">14 entities</span></div>
          <div className="card__body" style={{ paddingTop:8, paddingBottom:8 }}>
            {ENTITIES.map((e, i) => {
              const cls = e.status === 'done' ? '' : e.status === 'testing' ? 'amber' : 'gray';
              return (
                <div key={e.id} className="bar-row">
                  <div className="e-name">{e.name}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width:`${e.progress}%`, animationDelay:`${i * 0.05}s` }} data-cls={cls} />
                  </div>
                  <div className="bar-pct">{e.progress}%</div>
                  <div><Badge status={e.status === 'done' ? 'done' : 'testing'} /></div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h3>Known Issues</h3><span className="sub">3 open items</span>
          <div className="right"><span className="badge badge--error"><span className="b-dot" />Needs decision</span></div>
        </div>
        <div className="card__body">
          <div className="alert alert--error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div><b>Journal Entry #35096 — account mapping error</b><p>'First Community Bank Checking' is referenced but not present in the Chart of Accounts. Migration of this entry is blocked until the account is created in FreshBooks.</p></div>
          </div>
          <div className="alert alert--warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div><b>Vendor "N/A" names — handling undecided</b><p>Several vendor records arrive with a literal "N/A" name. Awaiting decision on whether to skip, merge, or substitute a placeholder before migrating.</p></div>
          </div>
          <div className="alert alert--warn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div><b>Zero-price items — handling undecided</b><p>A number of items export with a 0.00 unit price. Awaiting decision on whether FreshBooks should reject these or accept them as zero-rated.</p></div>
          </div>
          <div className="alert alert--info" style={{ marginBottom:0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <div><b>2 entities remain in testing</b><p>Bill Payments and Invoice Payments are functionally complete and undergoing final reconciliation checks before sign-off.</p></div>
          </div>
        </div>
      </div>
    </div>
  );
}
