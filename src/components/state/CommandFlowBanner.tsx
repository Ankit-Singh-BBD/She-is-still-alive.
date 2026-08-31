// ===================================================================
// COMMAND FLOW BANNER - Visualises voice/manual command lifecycle
// UNDERSTAND → ACT → SHOW PROGRESS → RESULT → ACKNOWLEDGE → RETURN
// ===================================================================

import { AnimatePresence, motion } from 'motion/react';
import { Loader2, Check, ArrowLeft, Sparkles, Activity } from 'lucide-react';
import { CommandFlowState, CommandPhase } from '../../hooks/useCommandFlow.js';
import { acknowledgeCommand } from '../../utils/voiceCommandRouter.js';

interface CommandFlowBannerProps {
  state: CommandFlowState;
  onSkipReturn?: () => void;
}

const PHASE_LABEL: Record<CommandPhase, string> = {
  idle: '',
  understand: 'Understanding',
  act: 'Working on it',
  'show-progress': 'In progress',
  result: 'Ready',
  acknowledge: 'Done',
  returning: 'Returning',
};

const PHASE_ICON: Record<CommandPhase, typeof Loader2> = {
  idle: Sparkles,
  understand: Activity,
  act: Loader2,
  'show-progress': Loader2,
  result: Check,
  acknowledge: Check,
  returning: ArrowLeft,
};

export function CommandFlowBanner({ state, onSkipReturn }: CommandFlowBannerProps) {
  if (state.phase === 'idle') return null;

  const Icon = PHASE_ICON[state.phase];
  const isWorking = state.phase === 'act' || state.phase === 'show-progress' || state.phase === 'understand';
  const isReturning = state.phase === 'returning';

  const text = state.command
    ? state.phase === 'acknowledge' || state.phase === 'returning'
      ? 'Done'
      : acknowledgeCommand(state.command)
    : '';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] max-w-md w-[92%]"
      >
        <div
          className={`relative glass-deep rounded-2xl border px-4 py-3 flex items-center gap-3 shadow-2xl shadow-black/40 ${
            isReturning
              ? 'border-indigo-300/30'
              : isWorking
              ? 'border-orange-300/30 shadow-[0_0_28px_rgba(255,138,101,0.18)]'
              : 'border-emerald-300/30 shadow-[0_0_22px_rgba(52,211,153,0.18)]'
          }`}
        >
          {/* Phase ring */}
          <div className="relative shrink-0 w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center">
            <Icon
              className={`w-4 h-4 ${
                isReturning
                  ? 'text-indigo-200'
                  : isWorking
                  ? 'text-orange-200'
                  : 'text-emerald-200'
              } ${isWorking ? 'animate-spin' : ''}`}
            />
            {isWorking && (
              <motion.span
                className="absolute inset-0 rounded-full border-2 border-orange-300/50"
                animate={{ scale: [1, 1.4], opacity: [0.6, 0] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }}
              />
            )}
          </div>

          {/* Text + phase bar */}
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-white leading-tight truncate">
              {text}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <PhaseBar phase={state.phase} />
              <span className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-medium">
                {PHASE_LABEL[state.phase]}
              </span>
            </div>
          </div>

          {/* Skip return button */}
          {isReturning && onSkipReturn && (
            <button
              type="button"
              onClick={onSkipReturn}
              className="shrink-0 text-[10.5px] text-white/60 hover:text-white px-2 py-1 rounded-md hover:bg-white/[0.06] cursor-pointer"
            >
              Stay here
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function PhaseBar({ phase }: { phase: CommandPhase }) {
  const STEPS: CommandPhase[] = [
    'understand',
    'act',
    'show-progress',
    'result',
    'acknowledge',
  ];
  const stepIndex = STEPS.indexOf(phase);
  const isReturning = phase === 'returning';

  if (isReturning) {
    return (
      <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
        <motion.div
          className="h-full bg-gradient-to-r from-indigo-400 to-violet-400"
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: 0.6 }}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center gap-0.5">
      {STEPS.map((step, i) => {
        const done = i <= stepIndex;
        const active = i === stepIndex;
        return (
          <div
            key={step}
            className={`flex-1 h-1 rounded-full transition-colors ${
              done
                ? active
                  ? 'bg-orange-300 animate-soft-glow'
                  : 'bg-emerald-300/70'
                : 'bg-white/10'
            }`}
          />
        );
      })}
    </div>
  );
}
