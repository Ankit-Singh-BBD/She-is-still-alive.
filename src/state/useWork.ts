/**
 * B07 s2/s3 — Work projection: snapshot first, then SSE with version + dedup.
 *
 * Mirrors usePresence's shape deliberately: snapshot read gives the live version
 * even when the stream's first frame is minutes away; EventSource supplies the
 * cursor-resumable feed after it. Hide is local only — this hook never cancels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiFailure, api, type WorkSnapshot } from '../lib/api.js';
import { noticeFrom, type Notice } from './notice.js';

export type WorkStatus = 'idle' | 'loading' | 'live' | 'reconnecting' | 'unavailable' | 'closed';

export interface WorkReading {
  snapshot: WorkSnapshot | undefined;
  status: WorkStatus;
  notice: Notice | undefined;
  clearNotice: () => void;
  /** Controls — version-guarded (409 on stale), requestId-deduped. */
  control: (action: 'pause' | 'resume' | 'cancel') => Promise<boolean>;
  /** Force re-read of snapshot (e.g. after 409). */
  refresh: () => Promise<void>;
  /** Elapsed ms since job created (for indeterminate phase — no fake %). */
  elapsedMs: number | undefined;
}

function newRequestId(): string {
  // No extra dep — crypto.randomUUID is available in all targets here.
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function useWork(jobId: string | null, active: boolean): WorkReading {
  const [snapshot, setSnapshot] = useState<WorkSnapshot | undefined>(undefined);
  const [status, setStatus] = useState<WorkStatus>('idle');
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const versionRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  const fetchSnapshot = useCallback(async () => {
    if (!jobId) return;
    try {
      const snap = await api.workSnapshot(jobId);
      // Monotonic version: never apply an older snapshot over a newer one
      // (SSE and fetch can race; version is the single ordering word).
      if (snap.job.version < versionRef.current) return;
      versionRef.current = snap.job.version;
      setSnapshot(snap);
    } catch (e) {
      if (e instanceof ApiFailure && e.isAuth) throw e;
      setNotice(noticeFrom(e));
    }
  }, [jobId]);

  const refresh = useCallback(async () => {
    await fetchSnapshot();
  }, [fetchSnapshot]);

  const control = useCallback(
    async (action: 'pause' | 'resume' | 'cancel'): Promise<boolean> => {
      if (!jobId || !snapshot) return false;
      try {
        const res = await api.workControl(jobId, action, {
          expectedVersion: snapshot.job.version,
          requestId: newRequestId(),
        });
        // Deduplicated is still success — original control already applied.
        void res;
        await fetchSnapshot();
        return true;
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 409) {
          await fetchSnapshot();
          setNotice(noticeFrom(new Error('Version conflict — refreshed latest state. Try again.')));
          return false;
        }
        setNotice(noticeFrom(e));
        return false;
      }
    },
    [jobId, snapshot, fetchSnapshot],
  );

  useEffect(() => {
    if (!active || !jobId) {
      esRef.current?.close();
      esRef.current = null;
      setSnapshot(undefined);
      versionRef.current = 0;
      setStatus('closed');
      return;
    }

    let live = true;
    const seen = new Set<string>();
    setStatus('loading');

    void (async () => {
      try {
        const snap = await api.workSnapshot(jobId);
        if (!live) return;
        versionRef.current = snap.job.version;
        setSnapshot(snap);
        setStatus('live');
      } catch {
        if (!live) return;
        setStatus('unavailable');
      }
      if (!live) return;

      // SSE — cursor is the version of the snapshot we just displayed.
      const cursor = versionRef.current;
      let url = `/api/work/${encodeURIComponent(jobId)}/events`;
      if (cursor) url += `?cursor=${cursor}`;

      // EventSource only exists in browser; jsdom tests get unavailable.
      const ES = (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource;
      if (!ES) {
        setStatus('unavailable');
        return;
      }

      try {
        const es = new ES(url);
        esRef.current = es;

        const onSnapshot = (ev: MessageEvent<string>) => {
          try {
            const snap = JSON.parse(ev.data) as WorkSnapshot;
            const v = snap.job.version;
            if (v < versionRef.current) return;
            const id = `snapshot:${v}`;
            if (seen.has(id)) return;
            seen.add(id);
            versionRef.current = v;
            setSnapshot(snap);
            setStatus('live');
          } catch {
            /* ignore malformed */
          }
        };

        const onAny = (ev: MessageEvent<string>) => {
          // Generic work.* events — re-read snapshot after any.
          // Dedup by SSE id (Last-Event-ID / eventId).
          const id = (ev as MessageEvent<string> & { lastEventId?: string }).lastEventId ?? `${(ev as unknown as { type?: string }).type ?? 'evt'}:${ev.data.slice(0, 32)}`;
          if (id && seen.has(id)) return;
          if (id) seen.add(id);
          void fetchSnapshot();
        };

        es.addEventListener('snapshot', onSnapshot as EventListener);
        // Work lifecycle events — any of them means state moved.
        for (const name of ['work.accepted', 'work.progress', 'work.verified', 'work.failed', 'work.paused', 'work.resumed', 'work.cancelled', 'work.completed']) {
          es.addEventListener(name, onAny as EventListener);
        }
        es.onopen = () => {
          if (live) setStatus('live');
        };
        es.onerror = () => {
          // EventSource auto-reconnects; gap will be caught on next snapshot.
          if (live) setStatus('reconnecting');
          // If stream closed permanently (e.g. 503), close and refetch gap.
          const esAny = es as unknown as { readyState?: number };
          if (esAny.readyState === 2 /* CLOSED */) {
            es.close();
            void fetchSnapshot().then(() => {
              if (live) setStatus('unavailable');
            });
          }
        };
      } catch {
        if (live) setStatus('unavailable');
      }
    })();

    return () => {
      live = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [active, jobId, fetchSnapshot]);

  const elapsedMs =
    snapshot !== undefined ? Math.max(0, Date.now() - snapshot.job.createdAt) : undefined;

  return {
    snapshot,
    status,
    notice,
    clearNotice: useCallback(() => setNotice(undefined), []),
    control,
    refresh,
    elapsedMs,
  };
}
