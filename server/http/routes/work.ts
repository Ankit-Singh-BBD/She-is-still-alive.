/**
 * B07 s1/s3 — Work read + SSE + control (pause/resume/cancel).
 */
import type { Router } from 'express';
import type { RouteDeps } from '../deps.js';
import { asyncRoute, HttpError } from '../errors.js';
import { requireCaller } from '../guard.js';

export function mountWorkRoutes(router: Router, deps: RouteDeps): void {
  router.get(
    '/api/work',
    asyncRoute('GET /api/work', deps.report, async (req, res) => {
      const caller = requireCaller(req, deps);
      const rows = deps.db.raw
        .prepare(`SELECT id FROM work_job WHERE identity_id=? ORDER BY created_at DESC LIMIT 50`)
        .all(caller.identity.id) as { id: string }[];
      const repo = deps.workRepo;
      const items = repo
        ? rows.map((r) => repo.getSnapshot((r as unknown as Record<string, string>)['id'] as string)).filter(Boolean)
        : rows.map((r) => ({ job: { id: (r as unknown as Record<string, string>)['id'] as string } }));
      res.json({ items });
    }),
  );

  router.get(
    '/api/work/:id',
    asyncRoute('GET /api/work/:id', deps.report, async (req, res) => {
      const repo = deps.workRepo;
      if (!repo) throw new HttpError('not_available', 'work not available');
      const snap = repo.getSnapshot((req.params as Record<string, string>)['id'] as string);
      if (!snap) throw new HttpError('not_found', 'job not found');
      res.json(snap);
    }),
  );

  router.get(
    '/api/work/:id/events',
    asyncRoute('GET /api/work/:id/events', deps.report, async (req, res) => {
      const jobId = (req.params as Record<string, string>)['id'] as string;
      const cursor = req.query['cursor'] ? Number(req.query['cursor']) : 0;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const repo = deps.workRepo;
      const snap = repo?.getSnapshot(jobId);
      if (snap) {
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      }

      const seen = new Set<string>();
      const unsub = deps.eventBus.subscribe((evt) => {
        const e = evt as { type: string; payload: Record<string, unknown>; sequence?: number };
        const payload = e.payload ?? {};
        const jid = (payload['jobId'] as string) ?? (payload['job_id'] as string);
        if (jid && jid !== jobId) return;
        const eventId = `${e.type}:${e.sequence ?? Date.now()}`;
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (Number(e.sequence ?? 0) < cursor) return;
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(evt)}\nid: ${String(e.sequence ?? '')}\n\n`);
      });

      req.on('close', () => {
        try {
          unsub();
        } catch {
          /* ignore */
        }
        res.end();
      });
    }),
  );

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    router.post(
      `/api/work/:id/${action}`,
      asyncRoute(`POST /api/work/:id/${action}`, deps.report, async (req, res) => {
        requireCaller(req, deps);
        const coord = deps.workCoordinator;
        if (!coord) throw new HttpError('not_available', 'coordinator not available');
        const body = (req.body ?? {}) as { expectedVersion?: number; requestId?: string };
        const expectedVersion = Number(body.expectedVersion);
        if (!Number.isFinite(expectedVersion)) throw new HttpError('invalid_request', 'expectedVersion required');
        if (body.requestId) {
          const existing = deps.db.raw
            .prepare(`SELECT id FROM work_outbox WHERE payload_json LIKE ? LIMIT 1`)
            .get(`%${body.requestId}%`) as { id: string } | undefined;
          if (existing) {
            res.json({ ok: true, deduplicated: true });
            return;
          }
        }
        const ok = coord.control((req.params as Record<string, string>)['id'] as string, expectedVersion, action);
        if (!ok) throw new HttpError('invalid_request', 'version conflict — fetch latest snapshot and retry');
        res.json({ ok: true });
      }),
    );
  }
}
