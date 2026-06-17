interface Props { show: boolean; onCancel: () => void; onConfirm: () => void; }

export default function Modal({ show, onCancel, onConfirm }: Props) {
  return (
    <div className={`overlay${show ? ' show' : ''}`} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal__icon ico-amber">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div className="modal__body">
          <h3>Migrate all 14 entities?</h3>
          <p>This will push every entity to FreshBooks in dependency order. This action writes live data and cannot be undone.</p>
          <div className="modal__list">
            Order: <b>Chart of Accounts → Expense Categories → Clients → Vendors → Items → Services → Expenses → Income → Journal Entries → Invoices → Bills → Credit Notes → Invoice Payments → Bill Payments</b>
          </div>
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn--danger" onClick={onConfirm}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Yes, migrate all
          </button>
        </div>
      </div>
    </div>
  );
}
