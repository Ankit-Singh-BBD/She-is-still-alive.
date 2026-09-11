/**
 * B05 s1 — Owner-supplied document ingestion + immutable artifact I/O.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@server/actions/registry.js';
import type { Database } from '@server/persistence/db.js';
import { ulid } from '@server/persistence/ids.js';
import { createHash } from 'node:crypto';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const MIME_ALLOW = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv']);
const MAX_BYTES = 256 * 1024;

export type DocIngestInput = { title: string; mediaType: string; content: string; identityId: string };
export type DocIngestOutput = { sourceId: string; hash: string };
export type DocReadInput = { sourceId: string };
export type DocReadOutput = { title: string; mediaType: string; content: string; hash: string };
export type ArtifactSaveInput = { jobId: string; stepId: string; kind: string; mediaType: string; content: string };
export type ArtifactSaveOutput = { artifactId: string; version: number; hash: string };

export function ensureDocTables(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS doc_source (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      title TEXT NOT NULL,
      media_type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc_blob (
      source_id TEXT PRIMARY KEY REFERENCES doc_source(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
  `);
}

export function ingestDocumentTool(deps: { db: Database }): ToolDefinition<DocIngestInput, DocIngestOutput> {
  return {
    id: 'doc.ingest',
    name: 'Ingest document',
    description: 'Store an owner-supplied document as a source with hash',
    inputSchema: z.object({ title: z.string().min(1).max(200), mediaType: z.string().min(1), content: z.string().min(1), identityId: z.string().min(1) }),
    outputSchema: z.object({ sourceId: z.string(), hash: z.string() }),
    clearanceRequired: 'all',
    retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, retryableErrors: [], retryOnDeadline: false },
    timeoutMs: 5000,
    execute: async (input) => {
      if (!MIME_ALLOW.has(input.mediaType)) throw new Error(`unsupported mediaType ${input.mediaType}`);
      if (Buffer.byteLength(input.content, 'utf8') > MAX_BYTES) throw new Error('document too large');
      ensureDocTables(deps.db);
      const hash = sha256(input.content);
      const id = ulid();
      deps.db.raw.prepare(`INSERT INTO doc_source (id, identity_id, title, media_type, content_hash, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.identityId, input.title, input.mediaType, hash, Buffer.byteLength(input.content, 'utf8'), Date.now());
      deps.db.raw.prepare(`INSERT INTO doc_blob (source_id, content) VALUES (?, ?)`).run(id, input.content);
      return { sourceId: id, hash };
    },
  };
}

export function readDocumentTool(deps: { db: Database }): ToolDefinition<DocReadInput, DocReadOutput> {
  return {
    id: 'doc.read',
    name: 'Read document',
    description: 'Read a stored document by sourceId',
    inputSchema: z.object({ sourceId: z.string().min(1) }),
    outputSchema: z.object({ title: z.string(), mediaType: z.string(), content: z.string(), hash: z.string() }),
    clearanceRequired: 'safe',
    retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, retryableErrors: ['temporary'], retryOnDeadline: true },
    timeoutMs: 5000,
    execute: async (input) => {
      ensureDocTables(deps.db);
      const row = deps.db.raw.prepare(`SELECT s.title, s.media_type, s.content_hash, b.content FROM doc_source s JOIN doc_blob b ON b.source_id=s.id WHERE s.id=?`).get(input.sourceId) as
        | { title: string; media_type: string; content_hash: string; content: string }
        | undefined;
      if (!row) throw new Error('source not found');
      if (sha256(row.content) !== row.content_hash) throw new Error('hash mismatch — stored bytes corrupted');
      return { title: row.title, mediaType: row.media_type, content: row.content, hash: row.content_hash };
    },
  };
}

export function saveArtifactTool(deps: { db: Database }): ToolDefinition<ArtifactSaveInput, ArtifactSaveOutput> {
  return {
    id: 'artifact.save',
    name: 'Save artifact',
    description: 'Persist an immutable artifact version',
    inputSchema: z.object({ jobId: z.string().min(1), stepId: z.string().min(1), kind: z.string().min(1), mediaType: z.string().min(1), content: z.string().min(1) }),
    outputSchema: z.object({ artifactId: z.string(), version: z.number(), hash: z.string() }),
    clearanceRequired: 'all',
    retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000, retryableErrors: [], retryOnDeadline: false },
    timeoutMs: 5000,
    execute: async (input) => {
      const hash = sha256(input.content);
      const artifactId = ulid();
      const ref = `artifact://${artifactId}/v1`;
      deps.db.raw
        .prepare(`INSERT INTO work_artifact (artifact_id, version, job_id, step_id, kind, media_type, content_hash, content_ref, created_at, verification_status, schema_version) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)`)
        .run(artifactId, input.jobId, input.stepId, input.kind, input.mediaType, hash, ref, Date.now());
      deps.db.raw.exec(`CREATE TABLE IF NOT EXISTS artifact_blob (artifact_id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
      deps.db.raw.prepare(`INSERT INTO artifact_blob (artifact_id, content) VALUES (?, ?)`).run(artifactId, input.content);
      return { artifactId, version: 1, hash };
    },
  };
}
