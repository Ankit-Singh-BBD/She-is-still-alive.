/**
 * Conversations.
 *
 * Every cycle record points at a conversation, and until now nothing in
 * `server/` ever created one. Each test inserted a row by hand, and the runtime
 * filled the gap with the literal string `'unknown'` — a fallback that can
 * never satisfy the foreign key, so in a running application every cycle failed
 * on its first insert. She could not have a conversation at all.
 *
 * This is the missing piece: the one place a conversation is opened, found,
 * and closed.
 */

import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';

export type ConversationChannel = 'text' | 'voice';
export type ConversationStatus = 'active' | 'ended';

export interface ConversationRow {
  id: string;
  identityId: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  startedAt: number;
  endedAt: number | undefined;
}

interface RawRow {
  id: string;
  identity_id: string;
  channel: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

/**
 * A SQLite timestamp column as epoch milliseconds.
 *
 * Exported because `message` has the same column convention and the transcript
 * reader next door must not grow a second parser that disagrees with this one.
 */
export function sqliteTimeToMillis(value: string): number {
  // Columns default to `datetime('now')`, which is a space-separated UTC
  // timestamp with no zone marker. Parsed as-is, JavaScript reads it as local
  // time and every conversation appears to have started hours off.
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mapRow(row: RawRow): ConversationRow {
  return {
    id: row.id,
    identityId: row.identity_id,
    channel: row.channel === 'voice' ? 'voice' : 'text',
    status: row.status === 'ended' ? 'ended' : 'active',
    startedAt: sqliteTimeToMillis(row.started_at),
    endedAt: row.ended_at === null ? undefined : sqliteTimeToMillis(row.ended_at),
  };
}

export class ConversationRepository {
  private readonly db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
  }

  /** Opens a new conversation and returns it. */
  open(identityId: string, channel: ConversationChannel = 'text'): ConversationRow {
    const id = ulid();
    const startedAt = new Date().toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO conversation (id, identity_id, channel, status, started_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .run(id, identityId, channel, startedAt);
    return {
      id,
      identityId,
      channel,
      status: 'active',
      startedAt: Date.parse(startedAt),
      endedAt: undefined,
    };
  }

  /**
   * Returns the id of the conversation `id`, opening it under that id if it
   * does not exist yet.
   *
   * A caller that supplies an id it invented — a client resuming what it thinks
   * is an existing thread — gets a real conversation rather than a foreign key
   * error. `TaskExecutor` already made this choice for the conversations it
   * needs; doing the same here keeps one rule instead of two. The cost is that
   * a mistyped id becomes an empty conversation rather than a loud failure,
   * which is the cheaper of the two mistakes.
   *
   * What it will *not* do is hand a caller a conversation that belongs to
   * someone else. The id comes from a stimulus, so it comes from outside; before
   * the transcript existed the worst that a borrowed id caused was a cycle
   * recorded in the wrong thread, and now it would mean a guest's prompt loading
   * whatever the owner had said in plain words. So a mismatch throws here,
   * before a cycle row exists, and the transcript read is scoped by identity as
   * well (`MessageRepository.recentForCaller`) so the guarantee does not rest on
   * this one check being on the path.
   */
  ensure(id: string, identityId: string, channel: ConversationChannel = 'text'): string {
    // Checked with a SELECT rather than `INSERT OR IGNORE`, because SQLite's
    // conflict resolution does not extend to foreign keys: an ignored insert
    // whose identity is absent would still raise.
    const existing = this.db.raw
      .prepare(`SELECT id, identity_id FROM conversation WHERE id = ?`)
      .get(id) as { id: string; identity_id: string } | undefined;
    if (existing) {
      if (existing.identity_id !== identityId) {
        throw new Error(
          `Conversation ${id} belongs to another identity; a caller may not join it. ` +
            'Omit conversationId to continue or open your own.',
        );
      }
      return existing.id;
    }

    this.db.raw
      .prepare(
        `INSERT INTO conversation (id, identity_id, channel, status, started_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .run(id, identityId, channel, new Date().toISOString());
    return id;
  }

  get(id: string): ConversationRow | null {
    const row = this.db.raw
      .prepare(`SELECT * FROM conversation WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * The conversation to continue for this caller, or null if they have none
   * open. Used to keep a returning caller in the thread they were already in
   * instead of starting a fresh one on every message.
   */
  mostRecentActive(identityId: string, channel?: ConversationChannel): ConversationRow | null {
    const row = (
      channel
        ? this.db.raw.prepare(
            `SELECT * FROM conversation
              WHERE identity_id = ? AND status = 'active' AND channel = ? AND deleted_at IS NULL
              ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
        : this.db.raw.prepare(
            `SELECT * FROM conversation
              WHERE identity_id = ? AND status = 'active' AND deleted_at IS NULL
              ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
    ).get(...(channel ? [identityId, channel] : [identityId])) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Continues the caller's open conversation, or opens their first one. */
  openOrContinue(identityId: string, channel: ConversationChannel = 'text'): ConversationRow {
    return this.mostRecentActive(identityId, channel) ?? this.open(identityId, channel);
  }

  listForIdentity(identityId: string, includeEnded = false): ConversationRow[] {
    const rows = this.db.raw
      .prepare(
        includeEnded
          ? `SELECT * FROM conversation WHERE identity_id = ? AND deleted_at IS NULL
               ORDER BY started_at DESC, id DESC`
          : `SELECT * FROM conversation WHERE identity_id = ? AND status = 'active'
               AND deleted_at IS NULL ORDER BY started_at DESC, id DESC`,
      )
      .all(identityId) as RawRow[];
    return rows.map(mapRow);
  }

  close(id: string): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE conversation SET status = 'ended', ended_at = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }
}
