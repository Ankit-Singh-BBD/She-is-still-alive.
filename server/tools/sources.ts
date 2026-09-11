/**
 * B05 s2/s3 — Brief recipe + approved network source fetching (bounded).
 */
import { z } from 'zod';
import type { ToolDefinition } from '@server/actions/registry.js';
import type { Database } from '@server/persistence/db.js';
import { ulid } from '@server/persistence/ids.js';
import { createHash } from 'node:crypto';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export type BriefInput = { sourceIds: string[]; goal: string; jobId: string; stepId: string };
export type BriefOutput = { artifactId: string; version: number; citations: string[] };
export type FetchInput = { url: string; identityId: string; maxBytes?: number | undefined };
export type FetchOutput = { sourceId: string; hash: string; bytes: number };

export function composeBriefTool(deps: { db: Database }): ToolDefinition<BriefInput, BriefOutput> {
  return {
    id: 'brief.compose',
    name: 'Compose brief',
    description: 'Read sources, extract cited claims, validate references, save artifact',
    inputSchema: z.object({ sourceIds: z.array(z.string()).min(1).max(8), goal: z.string().min(1), jobId: z.string().min(1), stepId: z.string().min(1) }),
    outputSchema: z.object({ artifactId: z.string(), version: z.number(), citations: z.array(z.string()) }),
    clearanceRequired: 'all',
    retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, retryableErrors: [], retryOnDeadline: false },
    timeoutMs: 15000,
    execute: async (input) => {
      const sources: { id: string; title: string; content: string; hash: string }[] = [];
      for (const sid of input.sourceIds) {
        const row = deps.db.raw.prepare(`SELECT s.title, s.content_hash, b.content FROM doc_source s JOIN doc_blob b ON b.source_id=s.id WHERE s.id=?`).get(sid) as
          | { title: string; content_hash: string; content: string }
          | undefined;
        if (!row) throw new Error(`source not found: ${sid}`);
        if (sha256(row.content) !== row.content_hash) throw new Error(`hash mismatch for ${sid}`);
        sources.push({ id: sid, title: row.title, content: row.content, hash: row.content_hash });
      }
      const claims = sources.map((s) => `Source "${s.title}" [${s.id}]: ${s.content.slice(0, 200)}`);
      const citations = sources.map((s) => s.id);
      const body = `# Brief: ${input.goal}\n\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nCitations: ${citations.join(', ')}`;
      const artifactId = ulid();
      const hash = sha256(body);
      deps.db.raw
        .prepare(`INSERT INTO work_artifact (artifact_id, version, job_id, step_id, kind, media_type, content_hash, content_ref, created_at, verification_status, schema_version) VALUES (?, 1, ?, ?, 'brief', 'text/markdown', ?, ?, ?, 'pending', 1)`)
        .run(artifactId, input.jobId, input.stepId, hash, `artifact://${artifactId}/v1`, Date.now());
      deps.db.raw.exec(`CREATE TABLE IF NOT EXISTS artifact_blob (artifact_id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
      try {
        deps.db.raw.prepare(`INSERT INTO artifact_blob (artifact_id, content) VALUES (?, ?)`).run(artifactId, body);
      } catch {
        // if already exists from concurrent, ignore
      }
      return { artifactId, version: 1, citations };
    },
  };
}

export function fetchSourceTool(deps: { db: Database }): ToolDefinition<FetchInput, FetchOutput> {
  return {
    id: 'source.fetch',
    name: 'Fetch source',
    description: 'Fetch an approved network source with bounded size/time',
    inputSchema: z.object({ url: z.string().url(), identityId: z.string().min(1), maxBytes: z.number().int().positive().optional() }),
    outputSchema: z.object({ sourceId: z.string(), hash: z.string(), bytes: z.number() }),
    clearanceRequired: 'all',
    retryPolicy: { maxAttempts: 1, baseDelayMs: 200, maxDelayMs: 2000, retryableErrors: ['network', 'ETIMEDOUT', 'ECONNREFUSED'], retryOnDeadline: false },
    timeoutMs: 10_000,
    execute: async (input) => {
      const cap = input.maxBytes ?? 128 * 1024;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      let text: string;
      try {
        const res = await fetch(input.url, { signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > cap) throw new Error(`response too large: ${buf.length} > ${cap}`);
        text = new TextDecoder().decode(buf);
      } finally {
        clearTimeout(t);
      }
      const hash = sha256(text);
      const sourceId = ulid();
      deps.db.raw.exec(`CREATE TABLE IF NOT EXISTS doc_source (id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, title TEXT NOT NULL, media_type TEXT NOT NULL, content_hash TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
      deps.db.raw.exec(`CREATE TABLE IF NOT EXISTS doc_blob (source_id TEXT PRIMARY KEY REFERENCES doc_source(id) ON DELETE CASCADE, content TEXT NOT NULL)`);
      deps.db.raw.prepare(`INSERT INTO doc_source (id, identity_id, title, media_type, content_hash, bytes, created_at) VALUES (?, ?, ?, 'text/plain', ?, ?, ?)`).run(sourceId, input.identityId, input.url, hash, Buffer.byteLength(text, 'utf8'), Date.now());
      deps.db.raw.prepare(`INSERT INTO doc_blob (source_id, content) VALUES (?, ?)`).run(sourceId, text);
      return { sourceId, hash, bytes: Buffer.byteLength(text, 'utf8') };
    },
  };
}
