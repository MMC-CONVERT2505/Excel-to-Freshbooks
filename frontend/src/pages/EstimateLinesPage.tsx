import { useState, useEffect } from 'react';
import { getEstimateLines } from '../lib/api';
// @ts-ignore
import XLSXStyle from 'xlsx-js-style';

const COLS = [
  { key: 'estimate_number', label: 'Estimate #',   wch: 14 },
  { key: 'organization',    label: 'Organization', wch: 28 },
  { key: 'estimate_date',   label: 'Date',         wch: 13 },
  { key: 'status',          label: 'Status',       wch: 10 },
  { key: 'item_name',       label: 'Item',         wch: 28 },
  { key: 'description',     label: 'Description',  wch: 36 },
  { key: 'qty',             label: 'Qty',          wch: 8  },
  { key: 'unit_cost',       label: 'Unit Cost',    wch: 12 },
  { key: 'total_amount',    label: 'Amount',       wch: 12 },
  { key: 'currency',        label: 'Currency',     wch: 10 },
];

function downloadExcel(rows: any[]) {
  const HDR = {
    fill: { fgColor: { rgb: '4338CA' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: { top:{style:'thin',color:{rgb:'FFFFFF'}}, bottom:{style:'thin',color:{rgb:'FFFFFF'}}, left:{style:'thin',color:{rgb:'FFFFFF'}}, right:{style:'thin',color:{rgb:'FFFFFF'}} },
  };
  const ROW = (alt: boolean) => ({
    font: { sz: 11 },
    fill: { fgColor: { rgb: alt ? 'F8F9FB' : 'FFFFFF' } },
    alignment: { vertical: 'center' },
    border: { top:{style:'thin',color:{rgb:'E6EAF1'}}, bottom:{style:'thin',color:{rgb:'E6EAF1'}}, left:{style:'thin',color:{rgb:'E6EAF1'}}, right:{style:'thin',color:{rgb:'E6EAF1'}} },
  });

  const headers  = COLS.map(c => c.label);
  const dataRows = rows.map(r => COLS.map(c => r[c.key] ?? ''));

  const ws = XLSXStyle.utils.aoa_to_sheet([headers, ...dataRows]);
  ws['!cols'] = COLS.map(c => ({ wch: c.wch }));
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
  XLSXStyle.utils.book_append_sheet(wb, ws, 'Estimate Items');
  XLSXStyle.writeFile(wb, 'freshbooks_estimate_items.xlsx');
}

export default function EstimateLinesPage() {
  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  function load() {
    setLoading(true); setError(null);
    getEstimateLines()
      .then(d => { setRows(d.lines); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="proj-wrap">
      <div className="proj-header">
        <div className="proj-header__text">
          <h2 className="proj-header__title">Estimate Items</h2>
          <p className="proj-header__sub">
            {loading ? 'Loading…' : `${rows.length} line item${rows.length !== 1 ? 's' : ''} across all estimates`}
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

      {loading && <div className="proj-state"><div className="proj-spinner" /><span>Fetching estimate items from FreshBooks…</span></div>}

      {!loading && error && (
        <div className="proj-state proj-state--error">
          <b>Failed to load</b><span>{error}</span>
          <button className="btn btn--ghost btn--sm" onClick={load}>Try again</button>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="proj-state"><b>No estimate line items found</b></div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="hist-table" style={{ minWidth: 800 }}>
            <thead>
              <tr>{COLS.map(c => <th key={c.key} className="hist-th">{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {COLS.map(c => <td key={c.key} className="hist-td">{r[c.key] ?? '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
