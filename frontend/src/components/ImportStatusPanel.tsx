import { useState, useEffect, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────
export interface ErrorRow {
  rowNumber: number;
  field: string;
  value: string;
  reason: string;
}

export interface ImportJob {
  id: string;
  filename: string;
  destination: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  percent: number;
  totalRows: number;
  pushedRows: number;
  skippedRows: number;
  errors: ErrorRow[];
}

// ── Animated counter ───────────────────────────────────────────────────────────
function useCountUp(target: number) {
  const [val, setVal] = useState(target);
  const prev = useRef(target);

  useEffect(() => {
    if (prev.current === target) return;
    const from = prev.current;
    prev.current = target;
    const start = performance.now();
    const dur = 500;
    function tick(now: number) {
      const t = Math.min((now - start) / dur, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(from + (target - from) * ease));
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [target]);

  return val;
}

// ── Circular progress ring ─────────────────────────────────────────────────────
function ProgressRing({ percent, status }: { percent: number; status: string }) {
  const r    = 20;
  const circ = 2 * Math.PI * r;
  const off  = circ * (1 - percent / 100);
  const displayed = useCountUp(percent);

  const color =
    status === 'done'   ? '#10B981' :
    status === 'failed' ? '#EF4444' :
    status === 'cancelled' ? '#9CA3AF' : '#f06292';

  return (
    <svg width="56" height="56" viewBox="0 0 52 52" className="isp-ring">
      <circle cx="26" cy="26" r={r} fill="none" stroke="#E5E7EB" strokeWidth="4" />
      <circle
        cx="26" cy="26" r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={circ}
        strokeDashoffset={off}
        strokeLinecap="round"
        transform="rotate(-90 26 26)"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text x="26" y="30" textAnchor="middle" fontSize="11" fontWeight="bold" fill={color}>
        {displayed}%
      </text>
    </svg>
  );
}

// ── Done / Failed status circle (with bounce-in animation) ─────────────────────
function StatusCircleIcon({ status }: { status: 'done' | 'failed' | 'cancelled' }) {
  const bg = status === 'done' ? '#10B981' : status === 'failed' ? '#EF4444' : '#9CA3AF';
  return (
    <div className={`isp-icon isp-icon--${status}`} style={{ background: bg }}>
      {status === 'done' && (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {(status === 'failed' || status === 'cancelled') && (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      )}
    </div>
  );
}

// ── Expandable error table ─────────────────────────────────────────────────────
function ErrorTable({
  job,
  dismissedRows,
  onRetryRow,
  onRetryAll,
}: {
  job: ImportJob;
  dismissedRows: Set<string>;
  onRetryRow: (jobId: string, rowNum: number) => void;
  onRetryAll: (jobId: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  if (!job.errors.length) return (
    <div className="isp-exp__empty">✓ No errors recorded for this job.</div>
  );

  return (
    <div className="isp-exp" ref={bodyRef}>
      <div className="isp-exp__head">
        <span className="isp-exp__count">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          {job.errors.length} row{job.errors.length > 1 ? 's' : ''} had errors
        </span>
        {job.errors.length > 1 && (
          <button className="isp-btn isp-btn--indigo" onClick={() => onRetryAll(job.id)}>
            ↻ Retry All
          </button>
        )}
      </div>

      <div className="isp-exp__table">
        <div className="isp-exp__thead">
          <span>Row</span><span>Field</span><span>Value</span><span>Reason</span><span />
        </div>
        {job.errors.map((err, i) => {
          const key = `${job.id}-${err.rowNumber}`;
          const leaving = dismissedRows.has(key);
          return (
            <div
              key={key}
              className={`isp-exp__row${i % 2 === 1 ? ' isp-exp__row--alt' : ''}${leaving ? ' isp-exp__row--leaving' : ''}`}
            >
              <span className="isp-exp__rn">#{err.rowNumber}</span>
              <span className="isp-exp__field">{err.field}</span>
              <span className="isp-exp__val">{err.value || <em className="isp-exp__empty-val">(empty)</em>}</span>
              <span className="isp-exp__reason">{err.reason}</span>
              <button className="isp-btn isp-btn--amber" onClick={() => onRetryRow(job.id, err.rowNumber)}>
                ↻ Retry row
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Single job row ─────────────────────────────────────────────────────────────
function JobRow({
  job,
  expanded,
  leaving,
  dismissedRows,
  onToggle,
  onDismiss,
  onCancel,
  onRetryRow,
  onRetryAll,
}: {
  job: ImportJob;
  expanded: boolean;
  leaving: boolean;
  dismissedRows: Set<string>;
  onToggle: () => void;
  onDismiss: () => void;
  onCancel: () => void;
  onRetryRow: (jobId: string, rowNum: number) => void;
  onRetryAll: (jobId: string) => void;
}) {
  const expRef    = useRef<HTMLDivElement>(null);
  const [expH, setExpH] = useState(0);

  useEffect(() => {
    if (expRef.current) setExpH(expRef.current.scrollHeight);
  }, [expanded, job.errors.length]);

  const isDone      = job.status === 'done';
  const isFailed    = job.status === 'failed';
  const isRunning   = job.status === 'running';
  const isCancelled = job.status === 'cancelled';

  return (
    <div className={`isp-row${leaving ? ' isp-row--leaving' : ''}`}>
      <div className="isp-row__main">

        {/* Left: icon / ring */}
        <div className="isp-row__left">
          {(isDone || isFailed || isCancelled)
            ? <StatusCircleIcon status={isDone ? 'done' : isFailed ? 'failed' : 'cancelled'} />
            : <ProgressRing percent={job.percent} status={job.status} />
          }
        </div>

        {/* Middle: text */}
        <div className="isp-row__body">
          {isDone && <>
            <div className="isp-row__title isp-row__title--done">Import Complete!</div>
            <div className="isp-row__sub">Successfully imported {job.pushedRows.toLocaleString()} records</div>
            <div className="isp-row__details">
              <span>{job.totalRows.toLocaleString()} rows were processed</span>
              {job.skippedRows > 0 && <span>{job.skippedRows} row{job.skippedRows > 1 ? 's' : ''} were skipped or had issues</span>}
            </div>
          </>}

          {isFailed && <>
            <div className="isp-row__title isp-row__title--failed">Import Failed</div>
            <div className="isp-row__sub">{job.errors.length} error{job.errors.length > 1 ? 's' : ''} — {job.pushedRows} of {job.totalRows} rows pushed</div>
            <div className="isp-row__details">
              {job.skippedRows > 0 && <span>{job.skippedRows} rows skipped</span>}
            </div>
          </>}

          {isRunning && <>
            <div className="isp-row__title">{job.filename}</div>
            <div className="isp-row__sub">To {job.destination}</div>
            <div className="isp-row__details">
              <span>{job.pushedRows.toLocaleString()} of {job.totalRows.toLocaleString()} rows pushed</span>
            </div>
          </>}

          {isCancelled && <>
            <div className="isp-row__title isp-row__title--cancelled">Cancelled</div>
            <div className="isp-row__sub">{job.filename} — {job.pushedRows} rows pushed before cancel</div>
          </>}
        </div>

        {/* Right: actions */}
        <div className="isp-row__right">
          {isRunning  && <button className="isp-action isp-action--cancel" onClick={onCancel}>Cancel</button>}
          {isFailed   && <button className="isp-btn isp-btn--amber" style={{ fontSize:13 }} onClick={() => onRetryAll(job.id)}>↻ Retry</button>}
          {(isDone || isCancelled || isFailed) && (
            <button className="isp-action isp-action--dismiss" onClick={onDismiss}>Dismiss</button>
          )}
          {(job.errors.length > 0) && (
            <button className="isp-expand-btn" title={expanded ? 'Collapse' : 'Expand'} onClick={onToggle}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .25s' }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Collapsible error section */}
      {job.errors.length > 0 && (
        <div
          className="isp-collapse"
          style={{ maxHeight: expanded ? expH + 'px' : '0px', opacity: expanded ? 1 : 0 }}
        >
          <div ref={expRef}>
            <ErrorTable
              job={job}
              dismissedRows={dismissedRows}
              onRetryRow={onRetryRow}
              onRetryAll={onRetryAll}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────
export default function ImportStatusPanel({ jobs: initial }: { jobs: ImportJob[] }) {
  const [jobs,         setJobs]         = useState<ImportJob[]>(initial);
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());
  const [leaving,      setLeaving]      = useState<Set<string>>(new Set());
  const [dismissedRows, setDismissedRows] = useState<Set<string>>(new Set());

  // Auto-increment running jobs every 800ms
  useEffect(() => {
    const iv = setInterval(() => {
      setJobs(prev => prev.map(job => {
        if (job.status !== 'running') return job;
        const next = Math.min(job.percent + 1, 100);
        if (next >= 100) {
          return { ...job, percent: 100, status: 'done', pushedRows: job.totalRows };
        }
        return { ...job, percent: next, pushedRows: Math.round(job.totalRows * next / 100) };
      }));
    }, 800);
    return () => clearInterval(iv);
  }, []);

  function toggleExpand(id: string) {
    setExpanded(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function dismiss(id: string) {
    setLeaving(s => new Set([...s, id]));
    setTimeout(() => {
      setJobs(prev => prev.filter(j => j.id !== id));
      setLeaving(s => { const n = new Set(s); n.delete(id); return n; });
    }, 380);
  }

  function cancel(id: string) {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, status: 'cancelled' } : j));
  }

  function retryRow(jobId: string, rowNumber: number) {
    const key = `${jobId}-${rowNumber}`;
    setDismissedRows(s => new Set([...s, key]));
    setTimeout(() => {
      setJobs(prev => prev.map(j => j.id === jobId
        ? { ...j, errors: j.errors.filter(e => e.rowNumber !== rowNumber) }
        : j
      ));
      setDismissedRows(s => { const n = new Set(s); n.delete(key); return n; });
    }, 400);
  }

  function retryAll(jobId: string) {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    job.errors.forEach(e => {
      const key = `${jobId}-${e.rowNumber}`;
      setDismissedRows(s => new Set([...s, key]));
    });
    setTimeout(() => {
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, errors: [], status: 'done' } : j));
      setDismissedRows(new Set());
    }, 450);
  }

  const counts = { done: 0, running: 0, failed: 0, cancelled: 0 };
  jobs.forEach(j => counts[j.status as keyof typeof counts]++);

  return (
    <div className="isp-wrap">

      {/* Summary bar */}
      <div className="isp-summary-bar">
        {counts.done > 0 && (
          <span className="isp-sum isp-sum--done">
            <span className="isp-sum__dot" />
            {counts.done} complete
          </span>
        )}
        {counts.running > 0 && (
          <span className="isp-sum isp-sum--running">
            <span className="isp-sum__dot" />
            {counts.running} running
          </span>
        )}
        {counts.failed > 0 && (
          <span className="isp-sum isp-sum--failed">
            <span className="isp-sum__dot" />
            {counts.failed} failed
          </span>
        )}
        {counts.cancelled > 0 && (
          <span className="isp-sum isp-sum--cancelled">
            <span className="isp-sum__dot" />
            {counts.cancelled} cancelled
          </span>
        )}
        {jobs.length === 0 && (
          <span style={{ color:'var(--text-3)', fontSize:13 }}>No import jobs</span>
        )}
      </div>

      {/* Panel */}
      <div className="isp-panel">
        {jobs.map(job => (
          <JobRow
            key={job.id}
            job={job}
            expanded={expanded.has(job.id)}
            leaving={leaving.has(job.id)}
            dismissedRows={dismissedRows}
            onToggle={() => toggleExpand(job.id)}
            onDismiss={() => dismiss(job.id)}
            onCancel={() => cancel(job.id)}
            onRetryRow={retryRow}
            onRetryAll={retryAll}
          />
        ))}
        {jobs.length === 0 && (
          <div className="isp-panel__empty">All jobs cleared.</div>
        )}
      </div>
    </div>
  );
}

// ── Mock data export for demo ──────────────────────────────────────────────────
export const mockJobs: ImportJob[] = [
  {
    id: '1', filename: 'contacts_export.csv', destination: 'Main Contacts List',
    status: 'done', percent: 100, totalRows: 133, pushedRows: 130, skippedRows: 3,
    errors: [
      { rowNumber: 12, field: 'email',  value: 'john@@bad.com', reason: 'Invalid email format' },
      { rowNumber: 47, field: 'phone',  value: '99999',         reason: 'Too short' },
      { rowNumber: 91, field: 'name',   value: '',              reason: 'Required field empty' },
    ],
  },
  {
    id: '2', filename: 'my_peoples_v3.csv', destination: 'Invite Email Recipients List',
    status: 'running', percent: 40, totalRows: 200, pushedRows: 80, skippedRows: 0, errors: [],
  },
  {
    id: '3', filename: 'vendors_jan2025.csv', destination: 'Vendor Master',
    status: 'failed', percent: 67, totalRows: 90, pushedRows: 60, skippedRows: 5,
    errors: [
      { rowNumber: 3,  field: 'tax_id', value: 'XXXX',       reason: 'Invalid format' },
      { rowNumber: 18, field: 'email',  value: 'notanemail', reason: 'Invalid email' },
    ],
  },
];
