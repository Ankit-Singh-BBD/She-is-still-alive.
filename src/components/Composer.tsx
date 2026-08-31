// ===================================================================
// COMPOSER - Floating glass message composer with mic pill
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, AudioLines, Mic, Sparkles } from 'lucide-react';
import { useRef, useEffect, FormEvent, KeyboardEvent } from 'react';
import { LiveState } from '../types.js';

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e?: FormEvent) => void;
  onToggleVoice: () => void;
  isProcessing?: boolean;
  liveState: LiveState;
  identityName?: string;
  className?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onToggleVoice,
  isProcessing = false,
  liveState,
  identityName,
  className = '',
}: ComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceActive = liveState === 'listening' || liveState === 'speaking';
  const connecting = liveState === 'connecting';

  useEffect(() => {
    if (!isProcessing) inputRef.current?.focus();
  }, [isProcessing]);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const canSend = value.trim().length > 0 && !isProcessing;

  return (
    <form
      onSubmit={onSubmit}
      className={`relative w-full max-w-2xl mx-auto ${className}`}
    >
      {/* Main glass bar */}
      <div
        className={`relative flex items-center gap-1.5 px-2.5 py-2 rounded-[20px] border transition-all duration-300 ${
          voiceActive
            ? 'glass border-indigo-300/35 shadow-[0_0_30px_rgba(99,102,241,0.18)]'
            : 'glass-deep border-white/12'
        } glass-edge`}
      >
        {/* Animated border on voice */}
        {voiceActive && (
          <motion.span
            className="absolute inset-0 rounded-[20px] pointer-events-none"
            style={{
              background:
                'linear-gradient(120deg, rgba(99,102,241,0.0), rgba(99,102,241,0.4), rgba(99,102,241,0.0))',
              backgroundSize: '200% 100%',
            }}
            animate={{ backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
          />
        )}

        {/* Mic button */}
        <motion.button
          type="button"
          onClick={onToggleVoice}
          disabled={connecting}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.92 }}
          className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all cursor-pointer press-scale ${
            voiceActive
              ? 'bg-indigo-400/25 text-indigo-100 shadow-[0_0_14px_rgba(99,102,241,0.45)]'
              : connecting
              ? 'bg-violet-400/15 text-violet-200 cursor-wait'
              : 'bg-white/8 text-white/70 hover:bg-white/14 hover:text-white'
          } ${connecting ? 'cursor-wait' : ''}`}
          aria-label={voiceActive ? 'Stop voice' : 'Start voice'}
        >
          {connecting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : voiceActive ? (
            <AudioLines className="w-4 h-4" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </motion.button>

        {/* Text input */}
        <input
          ref={inputRef}
          id="composer-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            voiceActive
              ? `Listening${identityName ? `, ${identityName.split(' ')[0]}` : ''}…`
              : `Message Madhurita${identityName ? `, ${identityName.split(' ')[0]}` : ''}…`
          }
          className="flex-1 min-w-0 bg-transparent outline-none text-[14px] text-white placeholder-white/40 px-1.5"
          autoComplete="off"
          spellCheck={false}
        />

        {/* Voice waveform indicator (when active) */}
        {voiceActive && (
          <div className="shrink-0 flex items-end gap-0.5 h-5 mr-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <motion.span
                key={i}
                className={`w-0.5 rounded-full ${
                  liveState === 'listening' ? 'bg-sky-300' : 'bg-orange-300'
                }`}
                animate={{
                  height: ['20%', '90%', '40%', '70%', '20%'],
                }}
                transition={{
                  duration: 0.9,
                  repeat: Infinity,
                  delay: i * 0.12,
                  ease: 'easeInOut',
                }}
                style={{ height: '20%' }}
              />
            ))}
          </div>
        )}

        {/* Send button */}
        <AnimatePresence mode="wait">
          {isProcessing ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-indigo-400/20 text-indigo-100"
            >
              <Sparkles className="w-4 h-4 animate-pulse" />
            </motion.div>
          ) : (
            <motion.button
              key="send"
              type="submit"
              disabled={!canSend}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              whileHover={{ scale: canSend ? 1.06 : 1 }}
              whileTap={{ scale: canSend ? 0.92 : 1 }}
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                canSend
                  ? 'bg-gradient-to-br from-white to-white/85 text-slate-900 cursor-pointer press-scale shadow-[0_0_20px_rgba(255,255,255,0.25)]'
                  : 'bg-white/5 text-white/30 cursor-not-allowed'
              }`}
              aria-label="Send message"
            >
              <Send className="w-4 h-4" strokeWidth={2.2} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Hint line */}
      <p className="mt-2 text-center text-[10.5px] text-white/35 tracking-wide">
        <kbd className="px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/55 text-[9.5px] font-mono">
          ⏎
        </kbd>{' '}
        to send ·{' '}
        <kbd className="px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/55 text-[9.5px] font-mono">
          mic
        </kbd>{' '}
        for voice · Madhurita learns as you talk
      </p>
    </form>
  );
}
