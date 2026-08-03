import { useState } from 'react';
import { CatIcon } from '../components/CatIcon';
import { useToast } from '../context/ToastContext';
import { fbExportEntity, fbExportAll } from '../lib/api';
import type { Cat } from '../data/entities';

const MODULES: Array<{ id: string; name: string; cat: Cat; desc: string }> = [
  { id: 'chart-of-accounts', name: 'Chart of Accounts', cat: 'accounts', desc: 'All account codes & types'    },
  { id: 'clients',           name: 'Clients',            cat: 'people',   desc: 'Customer records'             },
  { id: 'vendors',           name: 'Vendors',            cat: 'people',   desc: 'Supplier / vendor records'    },
  { id: 'items',             name: 'Items',              cat: 'catalog',  desc: 'Products & inventory'         },
  { id: 'services',          name: 'Services',           cat: 'catalog',  desc: 'Billable service items'       },
  { id: 'expenses',          name: 'Expenses',           cat: 'money',    desc: 'Business expenses'            },
  { id: 'income',            name: 'Income',             cat: 'money',    desc: 'Other income records'         },
  { id: 'invoices',          name: 'Invoices',           cat: 'docs',     desc: 'All issued invoices'          },
  { id: 'bills',             name: 'Bills',              cat: 'docs',     desc: 'Vendor bills'                 },
  { id: 'credit-notes',      name: 'Credit Notes',       cat: 'docs',     desc: 'Issued credit notes'          },
  { id: 'invoice-payments',  name: 'Invoice Payments',   cat: 'payments', desc: 'Payments received'            },
  { id: 'bill-payments',     name: 'Bill Payments',      cat: 'payments', desc: 'Payments made to vendors'     },
  { id: 'journal-entries',   name: 'Journal Entries',    cat: 'accounts', desc: 'Manual journal entries'       },
];

const Spin = () => (
  <svg className="ep-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" strokeOpacity=".25"/><path d="M12 3a9 9 0 0 1 9 9"/>
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
  const { toast } = useToast();
  const [busy,     setBusy]     = useState<Set<string>>(new Set());
  const [allBusy,  setAllBusy]  = useState(false);
  const [done,     setDone]     = useState<Set<string>>(new Set());

  async function downloadOne(id: string) {
    setBusy(prev => new Set(prev).add(id));
    try {
      await fbExportEntity(id);
      setDone(prev => new Set(prev).add(id));
      toast('success', 'Downloaded', `freshbooks_${id}.xlsx saved.`);
    } catch (err: any) {
      toast('error', 'Download failed', err.message);
    } finally {
      setBusy(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  async function downloadAll() {
    setAllBusy(true);
    try {
      await fbExportAll();
      setDone(new Set(MODULES.map(m => m.id)));
      toast('success', 'All modules downloaded', 'freshbooks_all.xlsx — each module is a separate sheet.');
    } catch (err: any) {
      toast('error', 'Download failed', err.message);
    } finally {
      setAllBusy(false);
    }
  }

  return (
    <div className="fetch-page">

      {/* ── header card ── */}
      <div className="card fetch-header">
        <div className="fetch-header__text">
          <h2>Fetch from FreshBooks</h2>
          <p>Download current records from any module as an Excel file.</p>
        </div>
        <button
          className="btn btn--primary fetch-header__btn"
          onClick={downloadAll}
          disabled={allBusy}
        >
          {allBusy
            ? <><Spin /> Downloading all…</>
            : <><DlIcon /> Download All Modules</>
          }
        </button>
      </div>

      {/* ── info strip ── */}
      <div className="fetch-info">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span><b>Download All</b> creates one Excel file with 13 sheets — one tab per module. Individual downloads save a separate file per module.</span>
      </div>

      {/* ── module grid ── */}
      <div className="fetch-grid">
        {MODULES.map(mod => {
          const isBusy = busy.has(mod.id);
          const isDone = done.has(mod.id);
          return (
            <div key={mod.id} className={`card fetch-card${isDone ? ' fetch-card--done' : ''}`}>
              <div className="fetch-card__top">
                <CatIcon cat={mod.cat} size={36} />
                <div className="fetch-card__meta">
                  <span className="fetch-card__name">{mod.name}</span>
                  <span className="fetch-card__desc">{mod.desc}</span>
                </div>
                {isDone && (
                  <svg className="fetch-card__check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </div>
              <button
                className="btn btn--ghost btn--block fetch-card__btn"
                onClick={() => downloadOne(mod.id)}
                disabled={isBusy || allBusy}
              >
                {isBusy ? <><Spin /> Fetching…</> : <><DlIcon /> Download</>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
