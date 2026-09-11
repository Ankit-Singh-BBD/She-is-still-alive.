/**
 * B07 s2 — Workshop view: projection only, no invented progress.
 *
 * Shows goal, steps (verified/running/blocked/failed), latest verified artifact
 * with content_hash, elapsed time for indeterminate phase, and controls (pause/
 * resume/cancel) guarded by version+requestId. Hide is caller-owned (local only).
 */

import type { ReactElement } from 'react';

import type { WorkReading } from '../state/useWork.js';
import type { WorkSnapshot } from '../lib/api.js';
import { Notice } from './Notice.js';

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function stepDot(status: string): string {
  switch (status) {
    case 'verified': return '✓';
    case 'running': return '●';
    case 'failed': return '✕';
    case 'blocked': return '◐';
    case 'waiting_approval': return '…';
    case 'paused': return '‖';
    case 'cancelled': return '—';
    default: return '○';
  }
}

export interface WorkViewProps {
  jobId: string;
  reading: WorkReading;
  onHide: () => void;
}

export function WorkView({ jobId, reading, onHide }: WorkViewProps): ReactElement {
  const snap: WorkSnapshot | undefined = reading.snapshot;
  const job = snap?.job;
  const steps = snap?.steps ?? [];
  const artifacts = snap?.artifacts ?? [];
  const latest = artifacts.length ? artifacts[artifacts.length - 1] : undefined;

  // Current step = first non-terminal in position order, else last
  const current = steps.find((s) => s.status === 'running' || s.status === 'pending') ?? steps[steps.length - 1];
  const verified = steps.filter((s) => s.status === 'verified');

  return (
    <div className="work">
      <header className="work-bar">
        <div className="work-bar-left">
          <span className="work-title" title={job?.goal ?? jobId}>{job?.goal ?? jobId}</span>
          {job ? <span className="work-meta">{job.status} · v{job.version} · {fmtElapsed(reading.elapsedMs ?? 0)} · {reading.status}</span> : null}
        </div>
        <div className="work-bar-right">
          <button className="pill" type="button" onClick={onHide}>Hide</button>
          <button className="pill" type="button" onClick={() => void reading.refresh()}>Refresh</button>
        </div>
      </header>

      <Notice notice={reading.notice} />

      {job == null ? (
        <p className="work-empty">Loading job…</p>
      ) : (
        <>
          <section className="work-section">
            <h2 className="work-h">Steps</h2>
            <ol className="work-steps">
              {steps.map((s) => (
                <li key={s.id} className="work-step" data-status={s.status}>
                  <span className="work-dot" aria-hidden>{stepDot(s.status)}</span>
                  <span className="work-step-tool">{s.toolId}</span>
                  <span className="work-step-status">{s.status}</span>
                  {s.id === current?.id ? <span className="work-step-current">current</span> : null}
                </li>
              ))}
            </ol>
            <p className="work-summary">{verified.length} of {steps.length} verified{latest?.verificationStatus === 'verified' ? ' · latest verified' : ''}{job.controlIntent ? ` · control: ${job.controlIntent}` : ''}</p>
          </section>

          <section className="work-section">
            <h2 className="work-h">Latest artifact</h2>
            {latest == null ? (
              <p className="work-empty">No artifact yet — elapsed {fmtElapsed(reading.elapsedMs ?? 0)}.</p>
            ) : (
              <div className="work-artifact">
                <div className="work-artifact-head">
                  <span className="work-artifact-kind">{latest.kind}</span>
                  <span className="work-artifact-ver">v{latest.version}</span>
                  <span className={`work-badge ${latest.verificationStatus === 'verified' ? 'ok' : 'pending'}`}>{latest.verificationStatus}</span>
                </div>
                <div className="work-hash" title={latest.contentHash}>hash {latest.contentHash.slice(0, 16)}…</div>
                <div className="work-ref">{latest.contentRef}</div>
              </div>
            )}
          </section>

          {(snap as WorkSnapshot).blockers.length > 0 ? (
            <section className="work-section">
              <h2 className="work-h">Blockers</h2>
              <ul className="work-blockers">
                {(snap as WorkSnapshot).blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </section>
          ) : null}

          <section className="work-section work-controls">
            <h2 className="work-h">Controls</h2>
            <div className="work-actions">
              {(snap as WorkSnapshot).allowedControls.includes('pause') ? <button className="pill" type="button" onClick={() => void reading.control('pause')}>Pause</button> : null}
              {(snap as WorkSnapshot).allowedControls.includes('resume') ? <button className="pill" type="button" onClick={() => void reading.control('resume')}>Resume</button> : null}
              {(snap as WorkSnapshot).allowedControls.includes('cancel') ? <button className="pill" type="button" onClick={() => void reading.control('cancel')}>Cancel</button> : null}
              {(snap as WorkSnapshot).allowedControls.length === 0 ? <span className="work-empty">No controls available in {job.status}.</span> : null}
            </div>
            <p className="work-hint">Hide closes the view only — the job keeps running. Cancel is durable. Barge-in stops audio without cancelling.</p>
          </section>
        </>
      )}
    </div>
  );
}
