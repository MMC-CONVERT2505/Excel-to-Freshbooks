import type { Entity, Issue } from '../data/entities';
import { issuesFor, countIssues } from '../data/entities';
import { useParams } from 'react-router-dom';
import { useToast } from '../context/ToastContext';

function IssueRow({ it }: { it: Issue }) {
  const ERR_SVG = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
  const WARN_SVG = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
  const CHECK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
  return (
    <div className={`issue issue--${it.sev}`}>
      <div className="issue__sev">{it.sev === 'error' ? ERR_SVG : WARN_SVG}</div>
      <div className="issue__body">
        <div className="issue__top">
          <span className="issue__row">Row {it.row}</span>
          <span className="issue__field">{it.field}</span>
          <span style={{ fontSize: '11.5px', color: 'var(--text-3)' }}>value: <b style={{ color: 'var(--text-2)' }}>{it.value}</b></span>
        </div>
        <div className="issue__msg">{it.msg}</div>
        <div className="issue__fix">{CHECK}<span>{it.fix}</span></div>
      </div>
    </div>
  );
}

interface Props {
  entity: Entity | null;
  issuesOverride?: Issue[];
  onClose: () => void;
}

export default function Drawer({ entity, issuesOverride, onClose }: Props) {
  const { workflow = 'qbd' } = useParams<{ workflow: string }>();
  const { toast } = useToast();
  const show = entity !== null;

  const list = entity ? (issuesOverride ?? issuesFor(entity.id)) : [];
  const c = entity
    ? issuesOverride
      ? {
          err: issuesOverride.filter(issue => issue.sev === 'error').length,
          warn: issuesOverride.filter(issue => issue.sev === 'warning').length,
        }
      : countIssues(entity.id)
    : { err: 0, warn: 0 };
  const errs = list.filter(i => i.sev === 'error');
  const warns = list.filter(i => i.sev === 'warning');

  function exportIssues() {
    if (!entity) return;
    const csv = 'row,severity,field,value,message,fix\n' + list.map(i => `${i.row},${i.sev},${i.field},"${i.value}","${i.msg}","${i.fix}"`).join('\n');
    const blob = new Blob([csv || 'no issues\n'], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${entity.id}_issues.csv`; a.click();
    toast('success', 'Issues exported', `${entity.name} issue list saved as CSV.`);
  }

  function rerun() {
    if (!entity) return;
    onClose();
    toast('success', `${entity.name} re-run queued`, 'Re-validating and pushing eligible records…');
  }

  return (
    <>
      <div className={`drawer-scrim${show ? ' show' : ''}`} onClick={onClose} />
      <aside className={`drawer${show ? ' show' : ''}`} aria-hidden={!show}>
        <div className="drawer__head">
          <div className="drawer__eyebrow">{entity?.name} · {workflow === 'qbd' ? 'QBD → FreshBooks' : 'Excel → FreshBooks'}</div>
          <div className="drawer__title">
            <h3>{entity?.name}</h3>
            <button className="drawer__close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="drawer__stats">
            <div className="drawer__stat"><div className="v g">{entity?.pushed ?? 0}</div><div className="l">Pushed</div></div>
            <div className="drawer__stat"><div className="v w">{c.warn}</div><div className="l">Warnings</div></div>
            <div className="drawer__stat"><div className="v e">{c.err}</div><div className="l">Errors</div></div>
          </div>
        </div>

        <div className="drawer__body">
          {list.length === 0 ? (
            <div className="drawer-clean">
              <div className="drawer-clean__ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <h4>No issues found</h4>
              <p>Every record in {entity?.name} passed validation and migrated cleanly.</p>
            </div>
          ) : (
            <>
              {errs.length > 0 && (
                <div className="drawer__group">
                  <div className="drawer__group-label" style={{ color: '#B42318' }}>{errs.length} blocking error{errs.length > 1 ? 's' : ''}</div>
                  {errs.map((it, i) => <IssueRow key={i} it={it} />)}
                </div>
              )}
              {warns.length > 0 && (
                <div className="drawer__group">
                  <div className="drawer__group-label" style={{ color: '#92400E' }}>{warns.length} warning{warns.length > 1 ? 's' : ''}</div>
                  {warns.map((it, i) => <IssueRow key={i} it={it} />)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="drawer__foot">
          <button className="btn btn--ghost btn--block" onClick={exportIssues}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Export issues
          </button>
          <button className="btn btn--primary btn--block" onClick={rerun}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Re-run entity
          </button>
        </div>
      </aside>
    </>
  );
}
