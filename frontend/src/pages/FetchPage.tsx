import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CatIcon } from '../components/CatIcon';
import { useToast } from '../context/ToastContext';
import { useApp } from '../context/AppContext';
import { fbExportEntity, fbExportAll, fbGetCounts } from '../lib/api';
import type { Cat } from '../data/entities';

const MODULES: Array<{ id: string; name: string; cat: Cat; desc: string }> = [
  { id: 'chart-of-accounts', name: 'Chart of Accounts', cat: 'accounts', desc: 'Account codes & types'      },
  { id: 'clients',           name: 'Clients',            cat: 'people',   desc: 'Customer records'           },
  { id: 'vendors',           name: 'Vendors',            cat: 'people',   desc: 'Supplier / vendor records'  },
  { id: 'items',             name: 'Items',              cat: 'catalog',  desc: 'Products & inventory'       },
  { id: 'services',          name: 'Services',           cat: 'catalog',  desc: 'Billable service items'     },
  { id: 'expenses',          name: 'Expenses',           cat: 'money',    desc: 'Business expenses'          },
  { id: 'income',            name: 'Income',             cat: 'money',    desc: 'Other income records'       },
  { id: 'invoices',          name: 'Invoices',           cat: 'docs',     desc: 'All issued invoices'        },
  { id: 'bills',             name: 'Bills',              cat: 'docs',     desc: 'Vendor bills'               },
  { id: 'credit-notes',      name: 'Credit Notes',       cat: 'docs',     desc: 'Issued credit notes'        },
  { id: 'invoice-payments',  name: 'Invoice Payments',   cat: 'payments', desc: 'Payments received'          },
  { id: 'bill-payments',     name: 'Bill Payments',      cat: 'payments', desc: 'Payments made to vendors'   },
  { id: 'journal-entries',   name: 'Journal Entries',    cat: 'accounts', desc: 'Manual journal entries'     },
];

function fmtCount(n: number) {
  return n.toLocaleString();
}

const Spin = ({ size = 14 }: { size?: number }) => (
  <svg className="ep-spin" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" strokeOpacity=".2"/><path d="M12 3a9 9 0 0 1 9 9"/>
  </svg>
);

const DlIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

export default function FetchPage() {
  const { toast }       = useToast();
  const { fbConnected } = useApp();
  const navigate        = useNavigate();
  const { workflow = 'excel' } = useParams<{ workflow: string }>();

  const [counts,      setCounts]      = useState<Record<string, number | null> | null>(null);
  const [countLoading,setCountLoading]= useState(false);
  const [busy,        setBusy]        = useState<Set<string>>(new Set());
  const [extracting,  setExtracting]  = useState<Set<string>>(new Set());
  const [allBusy,     setAllBusy]     = useState(false);
  const [done,        setDone]        = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  // Load counts when connected
  useEffect(() => {
    if (!fbConnected) return;
    setCountLoading(true);
    fbGetCounts()
      .then(c => setCounts(c))
      .catch(() => {})
      .finally(() => setCountLoading(false));
  }, [fbConnected]);

  function cancelAll() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function downloadOne(id: string) {
    setBusy(prev => new Set(prev).add(id));
    setExtracting(prev => new Set(prev).add(id));
    try {
      await fbExportEntity(id);
      setDone(prev => new Set(prev).add(id));
      toast('success', 'Downloaded', `freshbooks_${id}.xlsx saved.`);
    } catch (err: any) {
      toast('error', 'Download failed', err.message);
    } finally {
      setBusy(prev => { const s = new Set(prev); s.delete(id); return s; });
      setExtracting(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  async function downloadAll() {
    const controller = new AbortController();
    abortRef.current = controller;
    setAllBusy(true);
    setDone(new Set());
    setExtracting(new Set(MODULES.map(m => m.id)));
    try {
      await fbExportAll(controller.signal);
      setExtracting(new Set());
      for (let i = 0; i < MODULES.length; i++) {
        await new Promise(r => setTimeout(r, 90));
        setDone(prev => new Set(prev).add(MODULES[i].id));
      }
      toast('success', 'All modules downloaded', 'freshbooks_all.xlsx — each module is a separate sheet.');
    } catch (err: any) {
      setExtracting(new Set());
      if (err.name === 'AbortError') {
        toast('warning', 'Cancelled', 'Download All was cancelled.');
      } else {
        toast('error', 'Download failed', err.message);
      }
    } finally {
      setAllBusy(false);
      abortRef.current = null;
    }
  }

  const anyBusy = allBusy || busy.size > 0;
  const doneCount = done.size;

  return (
    <div className="fetch-page">

      {/* ── not connected banner ── */}
      {!fbConnected && (
        <div className="fetch-noconn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span>FreshBooks is not connected. <button className="fetch-noconn__link" onClick={() => navigate(`/${workflow}/connect`)}>Connect now →</button></span>
        </div>
      )}

      {/* ── header card ── */}
      <div className="card fetch-header">
        <div className="fetch-header__text">
          <h2>Fetch from FreshBooks</h2>
          <p>
            {allBusy
              ? `Extracting data… ${doneCount} of ${MODULES.length} modules ready`
              : 'Download current records from any module as an Excel file.'}
          </p>
        </div>
        <div className="fetch-header__actions">
          {allBusy && (
            <button className="btn btn--ghost fetch-header__cancel" onClick={cancelAll}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              Stop
            </button>
          )}
          <button
            className="btn btn--primary fetch-header__btn"
            onClick={downloadAll}
            disabled={anyBusy || !fbConnected}
            title={!fbConnected ? 'Connect FreshBooks first' : undefined}
          >
            {allBusy
              ? <><Spin size={15} /> Extracting…</>
              : <><DlIcon /> Download All Modules</>
            }
          </button>
        </div>

        {/* progress bar */}
        {allBusy && (
          <div className="fetch-bar">
            <div
              className="fetch-bar__fill"
              style={{ width: `${Math.max(4, Math.round(doneCount / MODULES.length * 100))}%` }}
            />
            <div className="fetch-bar__sweep" />
          </div>
        )}
      </div>

      {/* ── module grid ── */}
      <div className="fetch-grid">
        {MODULES.map((mod, idx) => {
          const isBusy      = busy.has(mod.id);
          const isDone      = done.has(mod.id);
          const isExtracting = extracting.has(mod.id) && !isDone;
          const count       = counts?.[mod.id];

          let cardCls = 'card fetch-card';
          if (isDone)        cardCls += ' fetch-card--done';
          else if (isExtracting) cardCls += ' fetch-card--extracting';

          return (
            <div
              key={mod.id}
              className={cardCls}
              style={isExtracting ? { animationDelay: `${(idx % 4) * 0.12}s` } : undefined}
            >
              {/* scan line overlay while extracting */}
              {isExtracting && <div className="fetch-scan" />}

              <div className="fetch-card__top">
                <CatIcon cat={mod.cat} size={36} />
                <div className="fetch-card__meta">
                  <span className="fetch-card__name">{mod.name}</span>
                  <span className="fetch-card__desc">{mod.desc}</span>
                </div>
                {isDone ? (
                  <div className="fetch-card__check-wrap">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                ) : isExtracting ? (
                  <div className="fetch-card__extract-badge">
                    <Spin size={12} />
                  </div>
                ) : null}
              </div>

              {/* count row */}
              <div className="fetch-card__count-row">
                {isDone ? (
                  <span className="fetch-count fetch-count--done">
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    Downloaded
                  </span>
                ) : isExtracting ? (
                  <span className="fetch-count fetch-count--extracting">
                    <span className="fetch-dots"><span /><span /><span /></span>
                    Extracting data
                  </span>
                ) : countLoading ? (
                  <span className="fetch-count-skel" />
                ) : count != null ? (
                  <span className="fetch-count">
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    {fmtCount(count)} records
                  </span>
                ) : null}
              </div>

              <button
                className={`btn btn--ghost btn--block fetch-card__btn${isExtracting ? ' fetch-card__btn--loading' : ''}${isDone ? ' fetch-card__btn--done' : ''}`}
                onClick={() => downloadOne(mod.id)}
                disabled={isBusy || anyBusy || !fbConnected}
                title={!fbConnected ? 'Connect FreshBooks first' : undefined}
              >
                {isBusy
                  ? <><Spin /> Fetching…</>
                  : isExtracting
                    ? <><Spin /> Extracting…</>
                    : isDone
                      ? <><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Re-download</>
                      : <><DlIcon /> Download</>
                }
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
