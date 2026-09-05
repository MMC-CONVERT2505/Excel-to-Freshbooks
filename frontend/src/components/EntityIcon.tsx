/**
 * One distinct icon and tint per entity, so a card is recognisable at a glance
 * rather than every tile looking the same. Tints are soft backgrounds behind a
 * saturated stroke — the same treatment across the set, only the hue changes.
 */

type Spec = { fg: string; bg: string; path: React.ReactNode };

const S: Record<string, Spec> = {
  'chart-of-accounts': {
    fg: '#2563EB', bg: '#E7EFFE',
    path: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  },
  'clients': {
    fg: '#059669', bg: '#E3F5EE',
    path: <><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  },
  'vendors': {
    fg: '#EA580C', bg: '#FDEDE1',
    path: <><rect x="1" y="6" width="13" height="11" rx="1"/><path d="M14 10h4l3 3v4h-7z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/></>,
  },
  'items': {
    fg: '#6366F1', bg: '#EAEBFD',
    path: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/></>,
  },
  'services': {
    fg: '#7C3AED', bg: '#EFE9FD',
    path: <><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></>,
  },
  'expenses': {
    fg: '#DC2626', bg: '#FCE9E9',
    path: <><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 1V2l-1 1-3-2-3 2-3-2-3 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="14" x2="14" y2="14"/></>,
  },
  'income': {
    fg: '#059669', bg: '#E3F5EE',
    path: <><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></>,
  },
  'invoices': {
    fg: '#2563EB', bg: '#E7EFFE',
    path: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></>,
  },
  'sales-receipts': {
    fg: '#0891B2', bg: '#E0F2F7',
    path: <><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="14" y2="13"/><line x1="7" y1="17" x2="11" y2="17"/></>,
  },
  'bills': {
    fg: '#D97706', bg: '#FCF0DC',
    path: <><path d="M20 21V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16l3-2 3 2 3-2 3 2z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="14" x2="13" y2="14"/></>,
  },
  'credit-notes': {
    fg: '#DB2777', bg: '#FCE7F1',
    path: <><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></>,
  },
  'invoice-payments': {
    fg: '#059669', bg: '#E3F5EE',
    path: <><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="5" y1="15" x2="9" y2="15"/></>,
  },
  'bill-payments': {
    fg: '#E11D48', bg: '#FCE7EB',
    path: <><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="15" x2="12" y2="15"/></>,
  },
  'journal-entries': {
    fg: '#7C3AED', bg: '#EFE9FD',
    path: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="16" y2="7"/><line x1="9" y1="11" x2="14" y2="11"/></>,
  },
};

const FALLBACK: Spec = {
  fg: '#475569', bg: '#EEF1F6',
  path: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
};

export function EntityIcon({ id, size = 46 }: { id: string; size?: number }) {
  const s = S[id] ?? FALLBACK;
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.28,
      display: 'grid', placeItems: 'center',
      background: s.bg, color: s.fg, flexShrink: 0,
    }}>
      <svg
        viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5}
        fill="none" stroke="currentColor" strokeWidth="1.9"
        strokeLinecap="round" strokeLinejoin="round"
      >
        {s.path}
      </svg>
    </div>
  );
}
