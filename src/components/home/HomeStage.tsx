// ===================================================================
// HOME STAGE - Main home view (greeting + orb + actions + composer)
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useRef, useState, FormEvent } from 'react';
import { Sparkles } from 'lucide-react';
import { Identity, LiveState } from '../../types.js';
import { GreetingBlock } from './GreetingBlock.js';
import { QuickActionChips } from './QuickActionChips.js';
import { VoicePill } from './VoicePill.js';
import { InfoBar } from './InfoBar.js';
import { ConversationStream } from '../chat/ConversationStream.js';
import { Composer } from '../Composer.js';
import { MadhuritaOrb } from '../MadhuritaOrb.js';
import { useWeather } from '../../hooks/useUIState.js';

interface HomeStageProps {
  identity: Identity;
  authToken?: string;
  liveState: LiveState;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
  isThinking: boolean;
  onSendMessage: (text: string) => void | Promise<void>;
  onToggleVoice: () => void;
  onQuickAction: (prompt: string) => void;
  onOpenOnboarding?: () => void;
}

export function HomeStage({
  identity,
  liveState,
  messages,
  isThinking,
  onSendMessage,
  onToggleVoice,
  onQuickAction,
  onOpenOnboarding,
}: HomeStageProps) {
  const weather = useWeather();
  const hasMessages = messages.length > 0;
  const isVoiceActive = liveState === 'listening' || liveState === 'speaking';
  const orbRef = useRef<HTMLDivElement>(null);
  const [orbPulse, setOrbPulse] = useState(0);

  // Local composer state (lifted from Composer — keep contained here for the home view)
  const [chatInput, setChatInput] = useState('');

  // Subtle pulse when voice is active
  useEffect(() => {
    if (!isVoiceActive) return;
    const id = setInterval(() => setOrbPulse((p) => p + 1), 2400);
    return () => clearInterval(id);
  }, [isVoiceActive]);

  // Auto-focus input when voice disconnects
  useEffect(() => {
    if (!isVoiceActive) {
      // no-op; Composer handles its own focus
    }
  }, [isVoiceActive]);

  const handleSubmit = (e?: FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || isThinking) return;
    onSendMessage(trimmed);
    setChatInput('');
  };

  return (
    <div className="relative h-full w-full flex flex-col">
      {/* Top: Greeting + Weather strip */}
      <div className="px-5 lg:px-8 pt-5 lg:pt-7 shrink-0">
        <GreetingBlock identityName={identity.name} role={identity.role} />
      </div>

      {/* Center: Orb (collapses when conversation has started) */}
      <AnimatePresence mode="wait">
        {!hasMessages ? (
          <motion.div
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="flex-1 min-h-0 flex flex-col items-center justify-center px-5"
          >
            <div className="relative w-full max-w-2xl flex flex-col items-center gap-5">
              {/* Orb */}
              <motion.div
                ref={orbRef}
                className="relative cursor-pointer"
                animate={{ scale: isVoiceActive ? [1, 1.03, 1] : 1 }}
                transition={{
                  duration: 2.4,
                  repeat: isVoiceActive ? Infinity : 0,
                  ease: 'easeInOut',
                }}
                onClick={onToggleVoice}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggleVoice();
                  }
                }}
                aria-label="Toggle voice"
              >
                <MadhuritaOrb
                  state={liveState}
                  size={isVoiceActive ? 300 : 260}
                  onClick={onToggleVoice}
                />
                {isVoiceActive && (
                  <motion.div
                    key={orbPulse}
                    className="absolute inset-0 rounded-full pointer-events-none"
                    initial={{ opacity: 0.55, scale: 1 }}
                    animate={{ opacity: 0, scale: 1.25 }}
                    transition={{ duration: 1.6, ease: 'easeOut' }}
                    style={{
                      background:
                        liveState === 'listening'
                          ? 'radial-gradient(circle, rgba(96,165,250,0.35) 0%, transparent 60%)'
                          : 'radial-gradient(circle, rgba(251,146,60,0.35) 0%, transparent 60%)',
                    }}
                  />
                )}
              </motion.div>

              {/* Voice pill */}
              <VoicePill state={liveState} onToggle={onToggleVoice} disabled={false} />

              {/* Quick action chips */}
              <QuickActionChips onAction={onQuickAction} disabled={isThinking} />

              {/* Invitation to tune persona (owner only) */}
              {identity?.role === 'owner' && onOpenOnboarding && (
                <motion.button
                  type="button"
                  onClick={onOpenOnboarding}
                  className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-amber-200/80 hover:text-amber-100 cursor-pointer press-scale"
                  whileTap={{ scale: 0.97 }}
                >
                  <Sparkles className="w-3 h-3" />
                  Tune Madhurita's persona
                </motion.button>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            <ConversationStream messages={messages} isThinking={isThinking} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom: composer + info bar */}
      <div className="px-5 lg:px-8 pb-4 pt-2 shrink-0 flex flex-col gap-3">
        <Composer
          value={chatInput}
          onChange={setChatInput}
          onSubmit={handleSubmit}
          onToggleVoice={onToggleVoice}
          isProcessing={isThinking}
          liveState={liveState}
          identityName={identity.name}
        />
        <InfoBar />
      </div>
    </div>
  );
}
