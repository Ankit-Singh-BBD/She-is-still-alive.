// ===================================================================
// HOME STAGE — Cinematic hero: orb centred in the landscape
// ===================================================================
//
// Layout is deliberately sparse so the photograph behind it does the
// heavy lifting: greeting floats at the top with photographic text
// shadows, the orb sits on the optical centre of the frame (slightly
// above true centre, where the horizon glow is), and every control is a
// pane of glass resting on the scene.

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

  // Orb scale — grows a touch while the voice session is live
  const orbSize = isVoiceActive ? 320 : 288;

  return (
    <div className="relative h-full w-full flex flex-col">
      {/* ---- Top: greeting, floating directly on the photograph ------ */}
      <div className="px-5 lg:px-9 pt-5 lg:pt-8 shrink-0 text-cine">
        <GreetingBlock identityName={identity.name} role={identity.role} />
      </div>

      {/* ---- Centre: orb hero, or the conversation once it starts ---- */}
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
            <div className="relative w-full max-w-2xl flex flex-col items-center">
              {/* Orb — sits on the optical centre of the frame */}
              <motion.div
                ref={orbRef}
                className="relative cursor-pointer"
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
                initial={{ opacity: 0, scale: 0.92, filter: 'blur(10px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
              >
                <MadhuritaOrb
                  state={liveState}
                  size={orbSize}
                  onClick={onToggleVoice}
                  isThinking={isThinking}
                  showStateLabel
                />
                {/* Discrete expanding shockwave each time the session ticks */}
                {isVoiceActive && (
                  <motion.div
                    key={orbPulse}
                    className="absolute inset-0 rounded-full pointer-events-none"
                    initial={{ opacity: 0.45, scale: 0.72 }}
                    animate={{ opacity: 0, scale: 1.3 }}
                    transition={{ duration: 1.8, ease: 'easeOut' }}
                    style={{
                      background:
                        liveState === 'listening'
                          ? 'radial-gradient(circle, rgba(96,165,250,0) 52%, rgba(96,165,250,0.35) 68%, rgba(96,165,250,0) 78%)'
                          : 'radial-gradient(circle, rgba(251,146,60,0) 52%, rgba(251,146,60,0.35) 68%, rgba(251,146,60,0) 78%)',
                      mixBlendMode: 'screen',
                    }}
                  />
                )}
              </motion.div>

              {/* Voice pill — clears the orb's state label */}
              <div className="mt-9">
                <VoicePill state={liveState} onToggle={onToggleVoice} disabled={false} />
              </div>

              {/* Quick action chips */}
              <div className="mt-5 w-full">
                <QuickActionChips onAction={onQuickAction} disabled={isThinking} />
              </div>

              {/* Invitation to tune persona (owner only) */}
              {identity?.role === 'owner' && onOpenOnboarding && (
                <motion.button
                  type="button"
                  onClick={onOpenOnboarding}
                  className="mt-4 inline-flex items-center gap-1.5 text-[11.5px] text-amber-200/80 hover:text-amber-100 cursor-pointer press-scale text-cine"
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

      {/* ---- Bottom: composer + info bar ---------------------------- */}
      <div className="px-5 lg:px-9 pb-4 pt-2 shrink-0 flex flex-col gap-2.5">
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
