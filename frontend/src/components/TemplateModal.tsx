import type { TplCol } from '../data/entities';

interface Props { show: boolean; name: string; cols: TplCol[]; onClose: () => void; onDownload: () => void; }

export default function TemplateModal({ show, name, cols, onClose, onDownload }: Props) {
  if (!show) return null;
  return (
    <div className="overlay show" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal tpl-modal-box">
        <div className="modal__icon ico-blue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
        </div>
        <div className="modal__body">
          <h3 style={{ textAlign:'center' }}>{name} — template</h3>
          <p style={{ textAlign:'center' }}>Use these exact column headers. Required fields must not be empty.</p>
          <div className="tpl-cols">
            {cols.map((c, i) => (
              <div key={i} className="tpl-col">
                <span className="nm">{c.col}</span>
                <span className={`req ${c.req ? 'r' : 'o'}`}>{c.req ? 'Required' : 'Optional'}</span>
                <span className="ds">{c.ds} <em>e.g. {c.ex}</em></span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
          <button className="btn btn--primary" onClick={onDownload}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Download CSV template
          </button>
        </div>
      </div>
    </div>
  );
}
