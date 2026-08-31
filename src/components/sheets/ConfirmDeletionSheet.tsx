// ===================================================================
// CONFIRM DELETION SHEET - Honest confirmation surface for the
// TARGET → SCOPE → SAFETY → CONFIRMATION → BIN flow.
//
// The Bin is the default destination. The user sees:
//
//   1. WHAT will be affected (scope summary, type, count).
//   2. HOW MUCH (per-type counts from the preview).
//   3. RELATED DATA (derived memories, sessions, turns).
//   4. REVERSIBILITY (recoverable from Bin / irreversible).
//   5. The source of the request (voice command / manual).
//
// The user must explicitly press "Move to Bin" or "Cancel" — no
// implicit confirmation, no timers, no auto-accept.
// ===================================================================

import { motion } from 'motion/react';
import { AlertTriangle, Trash2, X, Info, Sparkles, History } from 'lucide-react';
import type { ReactNode } from 'react';
import { GlassSheet } from './GlassSheet.js';
import type { DeletionPreview } from '../../hooks/useBin.js';

export interface ConfirmDeletionSheetProps {
  isOpen: boolean;
  preview: DeletionPreview | null;
  scopeLabel: string;
  /** Reason/why this deletion is happening (e.g. "voice: delete my last memory") */
  sourceLabel?: string;
  /** Disable the confirm button (e.g. while request in-flight) */
  isSubmitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeletionSheet({
  isOpen,
  preview,
  scopeLabel,
  sourceLabel,
  isSubmitting = false,
  onConfirm,
  onCancel,
}: ConfirmDeletionSheetProps) {
  if (!preview) {
    return (
      <GlassSheet isOpen={isOpen} onClose={onCancel} title="Confirm deletion" showClose>
        <div className="py-10 text-center text-[12.5px] text-white/55">
          Loading scope…
        </div>
      </GlassSheet>
    );
  }

  const affected = preview.affected || { memories: 0, turns: 0, sessions: 0, derivedMemories: 0, tasks: 0, patterns: 0 };
  const totalAffected =
    (affected.memories || 0) +
    (affected.turns || 0) +
    (affected.sessions || 0) +
    (affected.tasks || 0) +
    (affected.patterns || 0) +
    (affected.derivedMemories || 0);

  const recoverable = preview.reversibility === 'recoverable';
  const blocked = preview.safety === 'blocked';

  return (
    <GlassSheet
      isOpen={isOpen}
      onClose={onCancel}
      title="Confirm deletion"
      subtitle={scopeLabel}
      icon={<Trash2 className="w-4 h-4" />}
    >
      <div className="flex flex-col gap-4">
        {/* Honest human summary from the server */}
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-[12.5px] text-amber-100/90 leading-relaxed">
          {preview.message || 'Review the scope below before continuing.'}
        </div>

        {/* WHAT — counts per type */}
        <section>
          <SectionLabel icon={<Info className="w-3.5 h-3.5" />}>What will be affected</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <CountTile label="Memories" value={affected.memories} />
            <CountTile label="Conversation turns" value={affected.turns} />
            <CountTile label="Sessions" value={affected.sessions} />
            <CountTile label="Derived memories" value={affected.derivedMemories} />
            {(affected.tasks || 0) > 0 && <CountTile label="Tasks" value={affected.tasks || 0} />}
            {(affected.patterns || 0) > 0 && <CountTile label="Patterns" value={affected.patterns || 0} />}
          </div>
          {totalAffected === 0 && (
            <p className="mt-2 text-[11.5px] text-white/55">
              Nothing matches the current scope.
            </p>
          )}
        </section>

        {/* RELATED — derived/dependent data */}
        {affected.derivedMemories > 0 && (
          <section>
            <SectionLabel icon={<Sparkles className="w-3.5 h-3.5" />}>Related data</SectionLabel>
            <p className="text-[12px] text-white/70 leading-relaxed">
              {affected.derivedMemories} derived memor{affected.derivedMemories === 1 ? 'y' : 'ies'}
              {' '}will be moved to the Bin. Any cache, summary, or learning that was
              derived from these sources will be invalidated and not appear in retrieval.
            </p>
          </section>
        )}

        {/* REVERSIBILITY */}
        <section>
          <SectionLabel icon={<History className="w-3.5 h-3.5" />}>Reversibility</SectionLabel>
          <div
            className={`rounded-xl border px-3.5 py-2.5 text-[12px] leading-relaxed ${
              recoverable
                ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-100/90'
                : 'border-rose-500/40 bg-rose-500/[0.10] text-rose-100/90'
            }`}
          >
            {recoverable
              ? 'This moves the affected data to the Bin. You can restore it from there. Use "Empty Bin" only when you are sure.'
              : 'This action is irreversible. There is no recovery path.'}
          </div>
        </section>

        {/* Source label — for transparency */}
        {sourceLabel && (
          <p className="text-[10.5px] text-white/40">
            Request source: <span className="text-white/60">{sourceLabel}</span>
          </p>
        )}

        {/* Blocked / error states */}
        {blocked && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/[0.10] px-3.5 py-2.5 text-[12px] text-rose-100/90">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-rose-300" />
            <span>
              This scope is blocked. {preview.message}
            </span>
          </div>
        )}

        {/* ACTION ROW — explicit Yes / Cancel */}
        <div className="mt-2 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2.5 rounded-xl text-[13px] font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-white/80 hover:text-white flex items-center justify-center gap-1.5 cursor-pointer press-scale transition-colors disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting || blocked || totalAffected === 0}
            className="px-4 py-2.5 rounded-xl text-[13px] font-semibold bg-rose-500/85 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/30 flex items-center justify-center gap-1.5 cursor-pointer press-scale transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white"
              />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            {recoverable ? 'Move to Bin' : 'Permanently delete'}
          </button>
        </div>
      </div>
    </GlassSheet>
  );
}

function SectionLabel({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-white/45">
      {icon}
      {children}
    </div>
  );
}

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
      <div className="text-[18px] font-semibold tabular-nums text-white leading-none">
        {value}
      </div>
      <div className="mt-1 text-[10.5px] text-white/55">{label}</div>
    </div>
  );
}
