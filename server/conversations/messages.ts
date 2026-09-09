/**
 * The conversation transcript.
 *
 * The `message` table has existed since migration `0003_domain.sql` and until
 * now nothing in the repository wrote to it or read from it — verified by
 * grepping every `.ts` file for `INSERT INTO message` and `FROM message`. Two
 * things followed from that, both of them bad:
 *
 *   1. She could not see the previous turn of the conversation she was in. Each
 *      cycle assembled a working context out of *memory* — durable facts,
 *      preferences, habits — and nothing at all out of what had just been said.
 *      So "and the other one?" had no referent, and never could have.
 *   2. `LearningPipeline.processCycle(cycle, messages)` had no production source
 *      for its `messages` argument. The out-of-band learner could only ever be
 *      handed a transcript someone synthesised by hand.
 *
 * This module is the writer and the reader. The writer is a plain function
 * rather than only a method because stage 12 (PERSIST) must write the turns
 * inside the transaction it already opens for the rest of the cycle — the same
 * arrangement `appendAuditEntries` uses, and for the same reason: a cycle must
 * not split its story across two commits.
 */

import { ulid } from 'ulid';

import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';

import { sqliteTimeToMillis } from './repository.js';

export type MessageRole = 'user' | 'assistant' | 'system';

/** One line of a conversation, as stored. */
export interface ConversationTurn {
  id: string;
  conversationId: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  audioRef?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** One line of a conversation, as offered for storage. */
export interface TurnDraft {
  role: MessageRole;
  text: string;
  /** Defaults to now. Stage 12 passes the times the cycle actually recorded. */
  timestamp?: number | undefined;
  audioRef?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * What stage 3 needs of this module.
 *
 * Declared as an interface so the stage can be tested against a fake transcript
 * without a database, and so nothing downstream depends on the class.
 */
export interface TranscriptReader {
  recentForCaller(
    conversationId: string,
    identityId: string,
    limit: number,
  ): ConversationTurn[];
}

interface RawRow {
  id: string;
  conversation_id: string;
  role: string;
  text: string;
  audio_ref: string | null;
  metadata_json: string | null;
  timestamp: string;
}

function roleOf(value: string): MessageRole {
  return value === 'assistant' || value === 'system' ? value : 'user';
}

/**
 * `metadata_json` is read back defensively: it is written by this module, but a
 * row could also have been inserted by a migration, a fixture or a future
 * import, and one unparseable column must not cost the caller the whole turn.
 */
function metadataOf(value: string | null): Record<string, unknown> | undefined {
  if (value === null || value.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mapRow(row: RawRow): ConversationTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: roleOf(row.role),
    text: row.text,
    timestamp: sqliteTimeToMillis(row.timestamp),
    ...(row.audio_ref === null ? {} : { audioRef: row.audio_ref }),
    ...(() => {
      const metadata = metadataOf(row.metadata_json);
      return metadata ? { metadata } : {};
    })(),
  };
}

/**
 * Appends turns to a conversation, in the order given.
 *
 * Synchronous and transaction-agnostic on purpose: better-sqlite3 runs every
 * statement on one connection, so these inserts join whatever transaction is
 * already open on `db`. Stage 12 calls this from inside the cycle's transaction;
 * `MessageRepository.append` calls it from outside one, where each insert is its
 * own implicit transaction. Neither caller needs to know what the other does.
 *
 * A turn with no text is skipped rather than stored as an empty line — `text` is
 * `NOT NULL` and an empty string is not something anybody said. The return value
 * lists what was actually written, so a caller counting turns counts rows.
 */
export function appendTurns(
  db: Database,
  conversationId: string,
  drafts: readonly TurnDraft[],
): ConversationTurn[] {
  const insert = db.raw.prepare(
    `INSERT INTO message (id, conversation_id, role, text, audio_ref, metadata_json, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const written: ConversationTurn[] = [];
  for (const draft of drafts) {
    const text = draft.text.trim();
    if (text === '') continue;

    const id = ulid();
    const timestamp = draft.timestamp ?? Date.now();
    insert.run(
      id,
      conversationId,
      draft.role,
      text,
      draft.audioRef ?? null,
      draft.metadata ? JSON.stringify(draft.metadata) : null,
      new Date(timestamp).toISOString(),
    );

    written.push({
      id,
      conversationId,
      role: draft.role,
      text,
      timestamp,
      ...(draft.audioRef === undefined ? {} : { audioRef: draft.audioRef }),
      ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
    });
  }
  return written;
}

export class MessageRepository implements TranscriptReader {
  private readonly db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
  }

  /** Appends one turn and returns it. */
  append(conversationId: string, draft: TurnDraft): ConversationTurn | undefined {
    return appendTurns(this.db, conversationId, [draft])[0];
  }

  /** Appends several turns in one transaction. */
  appendTurns(conversationId: string, drafts: readonly TurnDraft[]): ConversationTurn[] {
    return this.db.raw.transaction(() => appendTurns(this.db, conversationId, drafts))();
  }

  /**
   * The last `limit` turns of a conversation, oldest first, for a caller who
   * owns it.
   *
   * The identity is a required argument, not a convenience. `conversationId`
   * arrives from a stimulus — which is to say from outside — and the transcript
   * of a conversation is the least redacted thing about it: whatever the owner
   * said to her in plain words, with no sensitivity column to filter on. So the
   * read is scoped by the conversation's own `identity_id` and a caller asking
   * for someone else's thread gets nothing rather than someone else's words.
   * `ConversationRepository.ensure` refuses the same mismatch loudly; this is
   * the structural half of the same guarantee, so a caller that reaches stage 3
   * by another path is still scoped.
   *
   * Ordered by `timestamp` then `rowid`: two turns of one cycle can land in the
   * same millisecond, and `rowid` is insertion order, so the user's line cannot
   * sort after the answer to it. Row ids are ULIDs, whose ordering inside one
   * millisecond is random, which is why they are not the tiebreak.
   */
  recentForCaller(
    conversationId: string,
    identityId: string,
    limit: number,
  ): ConversationTurn[] {
    if (limit <= 0) return [];
    const rows = this.db.raw
      .prepare(
        `SELECT m.id, m.conversation_id, m.role, m.text, m.audio_ref, m.metadata_json, m.timestamp
           FROM message m
           JOIN conversation c ON c.id = m.conversation_id
          WHERE m.conversation_id = ?
            AND c.identity_id = ?
            AND m.deleted_at IS NULL
            AND c.deleted_at IS NULL
          ORDER BY m.timestamp DESC, m.rowid DESC
          LIMIT ?`,
      )
      .all(conversationId, identityId, limit) as RawRow[];

    // Queried newest-first so `LIMIT` keeps the *recent* end, then reversed so
    // the caller reads the exchange in the order it happened.
    return rows.reverse().map(mapRow);
  }

  /** How many turns a conversation holds. */
  countFor(conversationId: string): number {
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM message
          WHERE conversation_id = ? AND deleted_at IS NULL`,
      )
      .get(conversationId) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
