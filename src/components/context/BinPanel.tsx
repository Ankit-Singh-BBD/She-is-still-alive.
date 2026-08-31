// ===================================================================
// BIN PANEL - Recoverable Bin/Trash viewer.
//
// The Bin is the default destination for soft-deletions. This panel
// fetches the authoritative Bin from the server and exposes:
//   - grouped items (memories, conversation turns, sessions, etc.)
//   - per-item Restore (single confirmation) → /api/bin/restore
//   - per-item Permanent delete (extra confirmation gate) → /api/bin/permanent
//   - Empty Bin (owner-only, irreversible) → /api/bin/empty
//
// No item is destroyed client-side; the server is the single source
// of truth. After any mutation, the panel refetches.
// ===================================================================

import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trash2, RotateCcw, AlertTriangle, X, Inbox } from 'lucide-react';
import { Identity } from '../../types.js';
import { useBin, BinEntry } from '../../hooks/useBin.js';
import { GlassSheet } from '../sheets/GlassSheet.js';
import { PanelSkeleton, PanelError, PanelEmpty, PanelSection } from './PanelShell.js';
import { formatRelative } from '../../utils/format.js';

const TYPE_LABEL: Record<string, string> = {
  memory: 'Memory',
  conversation_turn: 'Conversation turn',
  session: 'Conversation',
  task: 'Task',
  note: 'Note',
  pattern: 'Pattern',
};

const TYPE_EMOJI: Record<string, string> = {
  memory: '🧠',
  conversation_turn: '💬',
  session: '🗂️',
  task: '✅',
  note: '📝',
  pattern: '✨',
};

interface BinPanelProps {
  identity: Identity;
  authToken?: string;
}

export function BinPanel({ identity, authToken }: BinPanelProps) {
  const { entries, isLoading, error, refetch, restore, permanentDelete, emptyBin } = useBin(
    identity?.id && identity.id !== 'UNKNOWN' ? identity : null,
    authToken,
  );

  const [confirming, setConfirming] = useState<{ binId: string; preview: string } | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const out: Record<string, BinEntry[]> = {};
    for (const e of entries) {
      const k = e.type || 'memory';
      if (!out[k]) out[k] = [];
      out[k].push(e);
    }
    return out;
  }, [entries]);

  const handleRestore = useCallback(
    async (binId: string) => {
      setIsMutating(true);
      setLastError(null);
      const r = await restore(binId);
      setIsMutating(false);
      if (!r.success) setLastError(r.error || 'Restore failed');
      else refetch();
    },
    [restore, refetch],
  );

  const handlePermanentDelete = useCallback(async () => {
    if (!confirming) return;
    setIsMutating(true);
    setLastError(null);
    const r = await permanentDelete(confirming.binId, { confirmed: true });
    setIsMutating(false);
    setConfirming(null);
    if (!r.success) setLastError(r.error || 'Permanent delete failed');
    else refetch();
  }, [confirming, permanentDelete, refetch]);

  const handleEmpty = useCallback(async () => {
    setIsMutating(true);
    setLastError(null);
    const r = await emptyBin({ confirmed: true });
    setIsMutating(false);
    setConfirmingEmpty(false);
    if (!r.success) setLastError(r.error || 'Empty bin failed');
    else refetch();
  }, [emptyBin, refetch]);

  return (
    <div>
      {/* Header summary + actions */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[10.5px] text-white/55">
          {entries.length} {entries.length === 1 ? 'item' : 'items'} in the Bin
        </div>
        {entries.length > 0 && identity?.role === 'owner' && (
          <button
            type="button"
            onClick={() => setConfirmingEmpty(true)}
            className="text-[10.5px] text-rose-300 hover:text-rose-200 flex items-center gap-1 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" /> Empty Bin
          </button>
        )}
      </div>

      {lastError && (
        <div className="mb-3 rounded-xl border border-rose-500/40 bg-rose-500/[0.10] px-3 py-2 text-[11.5px] text-rose-100/90">
          {lastError}
        </div>
      )}

      {isLoading ? (
        <PanelSkeleton rows={3} />
      ) : error ? (
        <PanelError message={error} onRetry={refetch} />
      ) : entries.length === 0 ? (
        <PanelEmpty
          title="Bin is empty"
          description="Deleted memories, conversations, and tasks land here for recovery."
          icon={<Inbox className="w-7 h-7 text-indigo-300/60 mx-auto" />}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {Object.keys(grouped).map((type) => (
            <div key={type}>
            <PanelSection
              title={TYPE_LABEL[type] || type}
              count={grouped[type].length}
            >
              <div className="flex flex-col gap-2">
                <AnimatePresence>
                  {grouped[type].map((e) => (
                    <motion.div
                      key={e.binId}
                      layout
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.18 }}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-3"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-base leading-none mt-0.5 shrink-0">
                          {TYPE_EMOJI[e.type] || '📦'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] text-white/85 leading-relaxed break-words">
                            {e.preview}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-white/45">
                            <span>Deleted {formatRelative(e.deletedAt)}</span>
                            {e.deletedAtIST && (
                              <>
                                <span>·</span>
                                <span className="tabular-nums">{e.deletedAtIST}</span>
                              </>
                            )}
                            {e.deleteReason && (
                              <>
                                <span>·</span>
                                <span className="italic">{e.deleteReason}</span>
                              </>
                            )}
                          </div>
                          <div className="mt-2 flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRestore(e.binId)}
                              disabled={isMutating}
                              className="px-2.5 py-1 rounded-lg text-[10.5px] font-medium bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200 hover:text-emerald-100 flex items-center gap-1 cursor-pointer press-scale transition-colors disabled:opacity-50"
                            >
                              <RotateCcw className="w-3 h-3" /> Restore
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setConfirming({ binId: e.binId, preview: e.preview })
                              }
                              disabled={isMutating}
                              className="px-2.5 py-1 rounded-lg text-[10.5px] font-medium bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-200 hover:text-rose-100 flex items-center gap-1 cursor-pointer press-scale transition-colors disabled:opacity-50"
                            >
                              <Trash2 className="w-3 h-3" /> Delete forever
                            </button>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </PanelSection>
            </div>
          ))}
        </div>
      )}

      {/* Per-item permanent-delete confirmation */}
      <GlassSheet
        isOpen={!!confirming}
        onClose={() => !isMutating && setConfirming(null)}
        title="Delete forever"
        subtitle="This action cannot be undone"
        icon={<AlertTriangle className="w-4 h-4" />}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/[0.10] px-4 py-3 text-[12.5px] text-rose-100/90 leading-relaxed">
            You are about to permanently remove this item. It will not be recoverable from the Bin.
          </div>
          {confirming && (
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-[12px] text-white/80 break-words">
              {confirming.preview}
            </div>
          )}
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={isMutating}
              className="px-4 py-2.5 rounded-xl text-[13px] font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-white/80 hover:text-white flex items-center justify-center gap-1.5 cursor-pointer press-scale transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
            <button
              type="button"
              onClick={handlePermanentDelete}
              disabled={isMutating}
              className="px-4 py-2.5 rounded-xl text-[13px] font-semibold bg-rose-500/85 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/30 flex items-center justify-center gap-1.5 cursor-pointer press-scale transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" /> Yes, delete forever
            </button>
          </div>
        </div>
      </GlassSheet>

      {/* Empty Bin confirmation (owner-only, irreversible) */}
      <GlassSheet
        isOpen={confirmingEmpty}
        onClose={() => !isMutating && setConfirmingEmpty(false)}
        title="Empty the Bin"
        subtitle="This is irreversible"
        icon={<AlertTriangle className="w-4 h-4" />}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/[0.10] px-4 py-3 text-[12.5px] text-rose-100/90 leading-relaxed">
            All {entries.length} {entries.length === 1 ? 'item' : 'items'} in the Bin will be
            permanently deleted. This cannot be undone.
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmingEmpty(false)}
              disabled={isMutating}
              className="px-4 py-2.5 rounded-xl text-[13px] font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-white/80 hover:text-white flex items-center justify-center gap-1.5 cursor-pointer press-scale transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
            <button
              type="button"
              onClick={handleEmpty}
              disabled={isMutating}
              className="px-4 py-2.5 rounded-xl text-[13px] font-semibold bg-rose-500/85 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/30 flex items-center justify-center gap-1.5 cursor-pointer press-scale transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" /> Yes, empty the Bin
            </button>
          </div>
        </div>
      </GlassSheet>
    </div>
  );
}
