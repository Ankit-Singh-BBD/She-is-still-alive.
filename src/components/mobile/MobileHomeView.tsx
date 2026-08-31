// ===================================================================
// MOBILE HOME VIEW - Primary Mobile Stage with Luminous Orb & Composer
// ===================================================================

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Grid, Cloud, Mic, MessageSquare } from 'lucide-react';
import { MadhuritaOrb } from '../MadhuritaOrb.js';
import { QuickActionChips } from '../home/QuickActionChips.js';
import { Composer } from '../Composer.js';
import { InfoBar } from '../home/InfoBar.js';
import { Identity, LiveState } from '../../types.js';
import { useTimeOfDay, useWeather } from '../../hooks/useUIState.js';
import { getGreeting } from '../../utils/format.js';
import { MobileGridLauncher } from './MobileGridLauncher.js';
import { MobileWeatherView } from './MobileWeatherView.js';
import { StageKey } from '../../utils/stage.js';

interface MobileHomeViewProps {
  identity: Identity;
  liveState: LiveState;
  isThinking: boolean;
  onSendMessage: (text: string) => void;
  onToggleVoice: () => void;
  onQuickAction: (prompt: string) => void;
  onNavigate: (stage: StageKey) => void;
}

export function MobileHomeView({
  identity,
  liveState,
  isThinking,
  onSendMessage,
  onToggleVoice,
  onQuickAction,
  onNavigate,
}: MobileHomeViewProps) {
  const [chatInput, setChatInput] = useState('');
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [isWeatherViewOpen, setIsWeatherViewOpen] = useState(false);

  const { istHour } = useTimeOfDay();
  const greeting = getGreeting(istHour);
  const firstName = identity.name?.split(' ')[0] || 'there';

  const handleSubmit = () => {
    if (!chatInput.trim() || isThinking) return;
    onSendMessage(chatInput.trim());
    setChatInput('');
  };

  return (
    <div className="relative w-full h-full flex flex-col justify-between p-4 pb-20 overflow-hidden">
      {/* Top Mobile Bar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-orange-400/30 via-pink-400/30 to-violet-500/30 border border-white/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-white text-sm tracking-tight">Madhurita</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsWeatherViewOpen(true)}
            className="w-8 h-8 rounded-full glass flex items-center justify-center text-white/80 cursor-pointer"
            aria-label="Weather overview"
          >
            <Cloud className="w-4 h-4 text-sky-300" />
          </button>
          <button
            type="button"
            onClick={() => setIsLauncherOpen(true)}
            className="w-8 h-8 rounded-full glass flex items-center justify-center text-white/80 cursor-pointer"
            aria-label="App Launcher"
          >
            <Grid className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>

      {/* Center Hero: Greeting + Luminous Orb + Quick Actions */}
      <div className="flex-1 flex flex-col items-center justify-center my-auto min-h-0">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-4"
        >
          <h1 className="text-2xl font-bold tracking-tight text-white">
            {greeting.label}, <span className="text-gradient-sunset">{firstName}</span> {greeting.emoji}
          </h1>
          <p className="text-xs text-white/55 mt-1">How can I help you today?</p>
        </motion.div>

        {/* Central Luminous Orb */}
        <div className="my-2 cursor-pointer flex items-center justify-center" onClick={onToggleVoice}>
          <MadhuritaOrb
            state={liveState}
            size={220}
            onClick={onToggleVoice}
            showStateLabel
            isThinking={isThinking}
          />
        </div>

        {/* Quick Action Chips */}
        <div className="w-full mt-4">
          <QuickActionChips onAction={onQuickAction} disabled={isThinking} />
        </div>
      </div>

      {/* Bottom Floating Composer & Info Bar */}
      <div className="shrink-0 flex flex-col gap-2">
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

      {/* Full-Screen App Launcher Overlay */}
      <AnimatePresence>
        {isLauncherOpen && (
          <MobileGridLauncher
            onNavigate={onNavigate}
            onClose={() => setIsLauncherOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Weather Modal View */}
      <AnimatePresence>
        {isWeatherViewOpen && (
          <motion.div
            initial={{ opacity: 0, y: '100%' }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 260 }}
            className="fixed inset-0 z-50 glass-deep"
          >
            <MobileWeatherView onClose={() => setIsWeatherViewOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
