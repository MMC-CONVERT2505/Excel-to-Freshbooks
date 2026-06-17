import { useState, useEffect } from 'react';
import { getEstimates } from '../lib/api';
// @ts-ignore
import XLSXStyle from 'xlsx-js-style';

const COLUMNS = [
  { key: 'estimateid',     label: 'ID' },
  { key: 'estimatenum',    label: 'Estimate #' },
  { key: 'status',         label: 'Status' },
  { key: 'clientid',       label: 'Client ID' },
  { key: 'organization',   label: 'Organization' },
  { key: 'fname',          label: 'First Name' },
  { key: 'lname',          label: 'Last Name' },
  { key: 'amount_amount',  label: 'Amount' },
  { key: 'currency_code',  label: 'Currency' },
  { key: 'create_date',    label: 'Created' },
  { key: 'expiry_date',    label: 'Expiry' },
  { key: 'notes',          label: 'Notes' },
  { key: 'terms',          label: 'Terms' },
];

function flatGet(obj: any, key: string): string {
  const val = obj?.[key] ?? obj?.amount?.[key.replace('amount_', '')] ?? '';
  return val === null || val === undefined ? '' : String(val);
}

function downloadExcel(rows: any[]) {
  const headers = COLUMNS.map(c => c.label);
  const HDR = {
    fill: { fgColor: { rgb: '4338CA' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: { top:{style:'thin',color:{rgb:'FFFFFF'}}, bottom:{style:'thin',color:{rgb:'FFFFFF'}}, left:{style:'thin',color:{rgb:'FFFFFF'}}, right:{style:'thin',color:{rgb:'FFFFFF'}} },
  };
  const ROW = (alt: boolean) => ({
    font: { sz: 11 },
    fill: { fgColor: { rgb: alt ? 'F8F9FB' : 'FFFFFF' } },
    border: { top:{style:'thin',color:{rgb:'E6EAF1'}}, bottom:{style:'thin',color:{rgb:'E6EAF1'}}, left:{style:'thin',color:{rgb:'E6EAF1'}}, right:{style:'thin',color:{rgb:'E6EAF1'}} },
  });

  const dataRows = rows.map(r => COLUMNS.map(c => flatGet(r, c.key)));
  const ws = XLSXStyle.utils.aoa_to_sheet([headers, ...dataRows]);
  ws['!cols'] = [6,14,12,10,24,14,14,12,10,12,12,28,20].map(wch => ({ wch }));
  ws['!rows'] = [{ hpt: 22 }];

  headers.forEach((_, i) => {
    const a = XLSXStyle.utils.encode_cell({ r: 0, c: i });
    if (ws[a]) ws[a].s = HDR;
  });
  dataRows.forEach((_, ri) => {
    headers.forEach((_, ci) => {
      const a = XLSXStyle.utils.encode_cell({ r: ri + 1, c: ci });
      if (ws[a]) ws[a].s = ROW(ri % 2 !== 0);
    });
  });

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, 'Estimates');
  XLSXStyle.writeFile(wb, 'freshbooks_estimates.xlsx');
}

export default function EstimatesPage() {
  const [rows, setRows]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  function load() {
    setLoading(true); setError(null);
    getEstimates()
      .then(d => { setRows(d.response.result.estimates); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="proj-wrap">
      <div className="proj-header">
        <div className="proj-header__text">
          <h2 className="proj-header__title">Estimates</h2>
          <p className="proj-header__sub">
            {loading ? 'Loading…' : `${rows.length} estimate${rows.length !== 1 ? 's' : ''} in this account`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn--primary btn--sm"
            onClick={() => downloadExcel(rows)}
            disabled={loading || rows.length === 0}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Excel
          </button>
          <button className="btn btn--ghost btn--sm" onClick={load} disabled={loading}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {loading && <div className="proj-state"><div className="proj-spinner" /><span>Fetching estimates…</span></div>}

      {!loading && error && (
        <div className="proj-state proj-state--error">
          <b>Failed to load estimates</b><span>{error}</span>
          <button className="btn btn--ghost btn--sm" onClick={load}>Try again</button>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="proj-state"><b>No estimates found</b><span>This FreshBooks account has no estimates yet.</span></div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="hist-table" style={{ minWidth: 700 }}>
            <thead>
              <tr>
                {COLUMNS.filter(c => ['estimatenum','status','organization','lname','amount_amount','currency_code','create_date'].includes(c.key)).map(c => (
                  <th key={c.key} className="hist-th">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {['estimatenum','status','organization','lname','amount_amount','currency_code','create_date'].map(k => (
                    <td key={k} className="hist-td">{flatGet(r, k) || '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
