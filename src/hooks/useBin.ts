// ===================================================================
// useBin - Single source of truth for the recoverable Bin/Trash.
//
// The Bin lives on the server (POST /api/bin/move + GET /api/bin/list
// + POST /api/bin/restore + DELETE /api/bin/permanent). The hook is a
// thin reactive wrapper that:
//   1. fetches the current Bin entries
//   2. exposes a high-level `requestDelete()` that runs the FULL
//      TARGET → SCOPE → SAFETY → CONFIRMATION → BIN flow:
//        a. calls /api/bin/preview (no data moved)
//        b. if the scope is ambiguous, returns the candidate list
//           so the host can render a chooser
//        c. if the scope is resolved but requires confirmation,
//           returns a `pending` state with the affected set + message
//        d. if `confirmed=true` is passed, calls /api/bin/move
//           (which itself re-resolves scope at execution time, so
//           stale UI cannot move the wrong object)
//   3. exposes restore() and permanentDelete() with the same
//      defence-in-depth confirmation gate.
// ===================================================================

import { useCallback } from 'react';
import { useApi } from './useApi.js';
import { sanitizeAuthToken } from '../utils/auth.js';
import type { Identity } from '../types.js';

export interface BinEntry {
  binId: string;
  ownerId: string;
  type: 'memory' | 'conversation_turn' | 'session' | 'task' | 'note' | 'pattern';
  payload: any;
  preview: string;
  deletedAt: string;
  deletedAtIST: string;
  deletedBy: string;
  deleteReason?: string;
  sourceCommand?: string;
  originalId: string;
  expiresAt?: string;
}

export type DeletionScope =
  | 'single_memory'
  | 'single_conversation'
  | 'all_memories'
  | 'all_conversations'
  | 'single_task'
  | 'all_tasks'
  | 'single_pattern'
  | 'all_patterns';

export interface DeletionPreviewCandidate {
  id: string;
  preview: string;
  type: string;
  meta?: string;
}

export interface DeletionPreview {
  resolved: boolean;
  ambiguous?: boolean;
  candidates?: DeletionPreviewCandidate[];
  affected?: {
    memories: number;
    turns: number;
    sessions: number;
    tasks?: number;
    patterns?: number;
    derivedMemories: number;
  };
  reversibility: 'recoverable' | 'permanent' | 'n/a';
  safety: 'safe' | 'requires_confirm' | 'blocked';
  message: string;
}

export interface UseBinResult {
  entries: BinEntry[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;

  /**
   * Run the full safe-deletion flow.
   *
   *  - On the first call, omit `confirmed`. The hook will call
   *    /api/bin/preview and return a `pending` result with the
   *    resolved scope, candidate set, and reversibility so the UI
   *    can render an honest confirmation surface.
   *  - On the second call, pass `confirmed: true` only if the user
   *    has explicitly said "yes / do it / confirm". The hook will
   *    call /api/bin/move with confirm=true. Scope is re-resolved
   *    server-side at execution time, so a stale UI cannot move the
   *    wrong object.
   *  - Pass `confirmed: false` to cancel a pending deletion.
   */
  requestDelete: (args: {
    scope: DeletionScope;
    target?: string;
    targetQuery?: string;
    confirmed?: boolean;
    sourceCommand?: string;
  }) => Promise<
    | { state: 'pending'; preview: DeletionPreview }
    | { state: 'ambiguous'; preview: DeletionPreview }
    | { state: 'done'; result: any; preview: DeletionPreview }
    | { state: 'cancelled' }
    | { state: 'error'; error: string }
  >;

  /** Restore a single Bin entry. */
  restore: (binId: string) => Promise<{ success: boolean; error?: string }>;

  /**
   * Permanent delete a single Bin entry. The UI must surface an
   * explicit, irreversible-warning confirmation surface and only
   * then call this with confirmed=true. The server enforces the
   * same gate.
   */
  permanentDelete: (binId: string, opts: { confirmed: boolean }) => Promise<{ success: boolean; error?: string }>;

  /** Clear the entire Bin for the current identity. Owner-only. */
  emptyBin: (opts: { confirmed: boolean }) => Promise<{ success: boolean; removed?: number; error?: string }>;
}

function buildHeaders(authToken: string | undefined, identityId: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cleanToken = sanitizeAuthToken(authToken);
  if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
  if (identityId && identityId !== 'UNKNOWN') headers['X-User-Id'] = identityId;
  return headers;
}

export function useBin(
  identity: Identity | null,
  authToken?: string
): UseBinResult {
  const { data, isLoading, error, refetch } = useApi<{ entries: BinEntry[]; count: number }>(
    identity?.id && identity.id !== 'UNKNOWN' ? '/api/bin/list' : null,
    identity ?? ({ id: 'UNKNOWN' } as Identity),
    authToken,
    { refreshMs: 15000 }
  );

  const entries: BinEntry[] = Array.isArray(data?.entries) ? data.entries : [];

  // ----- requestDelete: TARGET → SCOPE → SAFETY → CONFIRM → BIN -----
  const requestDelete = useCallback(
    async (args: {
      scope: DeletionScope;
      target?: string;
      targetQuery?: string;
      confirmed?: boolean;
      sourceCommand?: string;
    }): Promise<any> => {
      if (!identity?.id || identity.id === 'UNKNOWN') {
        return { state: 'error', error: 'UNKNOWN_USER: Cannot delete without established identity' };
      }
      if (args.confirmed === false) {
        return { state: 'cancelled' as const };
      }
      try {
        if (!args.confirmed) {
          // Phase 1: preview (no data moved)
          const previewResp = await fetch(`/api/bin/preview`, {
            method: 'POST',
            headers: buildHeaders(authToken, identity.id),
            body: JSON.stringify({
              identityId: identity.id,
              scope: args.scope,
              target: args.target,
              query: args.targetQuery,
            }),
          });
          const preview = await previewResp.json();
          if (!previewResp.ok) {
            return { state: 'error', error: preview.error || 'Preview failed' };
          }
          if (preview.ambiguous) {
            return { state: 'ambiguous', preview };
          }
          if (!preview.resolved || preview.safety === 'blocked') {
            return { state: 'error', error: preview.message || 'Scope not resolved' };
          }
          return { state: 'pending', preview };
        }
        // Phase 2: confirmed → call /api/bin/move. The server
        // re-resolves scope at execution time so a stale UI cannot
        // move the wrong object.
        const moveResp = await fetch(`/api/bin/move`, {
          method: 'POST',
          headers: buildHeaders(authToken, identity.id),
          body: JSON.stringify({
            identityId: identity.id,
            scope: args.scope,
            target: args.target,
            confirm: true,
            sourceCommand: args.sourceCommand,
          }),
        });
        const moveResult = await moveResp.json();
        if (!moveResp.ok) {
          return { state: 'error', error: moveResult.error || 'Move to bin failed' };
        }
        // Refresh the Bin list so the UI is in sync
        refetch();
        return {
          state: 'done',
          result: moveResult,
          preview: {
            resolved: true,
            safety: 'safe' as const,
            reversibility: 'recoverable' as const,
            message: 'Moved to Bin.',
          },
        };
      } catch (e: any) {
        return { state: 'error', error: e.message || 'Network error' };
      }
    },
    [identity?.id, authToken, refetch]
  );

  // ----- restore -----
  const restore = useCallback(
    async (binId: string) => {
      try {
        const r = await fetch(`/api/bin/restore`, {
          method: 'POST',
          headers: buildHeaders(authToken, identity?.id || 'UNKNOWN'),
          body: JSON.stringify({ binId }),
        });
        const result = await r.json();
        if (!r.ok) return { success: false, error: result.error || 'Restore failed' };
        refetch();
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message || 'Network error' };
      }
    },
    [authToken, refetch, identity?.id]
  );

  // ----- permanentDelete (extra confirmation gate) -----
  const permanentDelete = useCallback(
    async (binId: string, opts: { confirmed: boolean }) => {
      if (!opts.confirmed) {
        return { success: false, error: 'CONFIRMATION_REQUIRED' };
      }
      try {
        const r = await fetch(`/api/bin/permanent`, {
          method: 'DELETE',
          headers: buildHeaders(authToken, identity?.id || 'UNKNOWN'),
          body: JSON.stringify({ binId, confirm: true }),
        });
        const result = await r.json();
        if (!r.ok) return { success: false, error: result.error || 'Permanent delete failed' };
        refetch();
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message || 'Network error' };
      }
    },
    [authToken, refetch, identity?.id]
  );

  // ----- emptyBin (owner-only utility) -----
  const emptyBin = useCallback(
    async (opts: { confirmed: boolean }) => {
      if (!opts.confirmed) {
        return { success: false, error: 'CONFIRMATION_REQUIRED' };
      }
      try {
        const r = await fetch(`/api/bin/empty`, {
          method: 'DELETE',
          headers: buildHeaders(authToken, identity?.id || 'UNKNOWN'),
          body: JSON.stringify({ identityId: identity?.id, confirm: true }),
        });
        const result = await r.json();
        if (!r.ok) return { success: false, error: result.error || 'Empty bin failed' };
        refetch();
        return { success: true, removed: result.removed };
      } catch (e: any) {
        return { success: false, error: e.message || 'Network error' };
      }
    },
    [authToken, refetch, identity?.id]
  );

  return {
    entries,
    isLoading,
    error: typeof error === 'string' ? error : null,
    refetch: refetch as () => void,
    requestDelete,
    restore,
    permanentDelete,
    emptyBin,
  };
}
