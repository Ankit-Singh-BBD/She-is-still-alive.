// ===================================================================
// MOBILE CHAT & MEMORY VIEW - Split Chat & Slide-Up Memory Drawer
// ===================================================================

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Brain, ChevronUp, ChevronDown, X, MessageSquare, ArrowLeft } from 'lucide-react';
import { ConversationStream } from '../chat/ConversationStream.js';
import { Composer } from '../Composer.js';
import { MemoryPanel } from '../context/MemoryPanel.js';
import { Identity, LiveState } from '../../types.js';

interface MobileChatMemoryViewProps {
  identity: Identity;
  authToken?: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
  }>;
  isThinking: boolean;
  liveState: LiveState;
  onSendMessage: (text: string) => void;
  onToggleVoice: () => void;
  onClose?: () => void;
}

export function MobileChatMemoryView({
  identity,
  authToken,
  messages,
  isThinking,
  liveState,
  onSendMessage,
  onToggleVoice,
  onClose,
}: MobileChatMemoryViewProps) {
  const [chatInput, setChatInput] = useState('');
  const [isMemoryDrawerOpen, setIsMemoryDrawerOpen] = useState(false);

  const handleSubmit = () => {
    if (!chatInput.trim() || isThinking) return;
    onSendMessage(chatInput.trim());
    setChatInput('');
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden pb-16">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full glass flex items-center justify-center text-white/80 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        ) : (
          <div className="w-8" />
        )}
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-orange-300" />
          <span className="text-xs font-semibold text-white">Conversation</span>
        </div>
        <button
          type="button"
          onClick={() => setIsMemoryDrawerOpen(!isMemoryDrawerOpen)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
            isMemoryDrawerOpen
              ? 'bg-purple-500/30 text-purple-200 border-purple-400/40'
              : 'glass text-white/70 border-white/10'
          }`}
        >
          <Brain className="w-3.5 h-3.5" />
          <span>Memory</span>
        </button>
      </div>

      {/* Main Conversation Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3">
        <ConversationStream messages={messages} isThinking={isThinking} />
      </div>

      {/* Composer Bar */}
      <div className="p-3 shrink-0">
        <Composer
          value={chatInput}
          onChange={setChatInput}
          onSubmit={handleSubmit}
          onToggleVoice={onToggleVoice}
          isProcessing={isThinking}
          liveState={liveState}
          identityName={identity.name}
        />
      </div>

      {/* Slide-Up Memory Drawer Sheet */}
      <AnimatePresence>
        {isMemoryDrawerOpen && (
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 280 }}
            className="absolute inset-x-0 bottom-0 top-12 z-50 glass-deep rounded-t-3xl border-t border-white/20 flex flex-col shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-purple-300" />
                <span className="text-xs font-semibold text-white">Active Memories</span>
              </div>
              <button
                type="button"
                onClick={() => setIsMemoryDrawerOpen(false)}
                className="w-7 h-7 rounded-full glass flex items-center justify-center text-white/70 cursor-pointer"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
              <MemoryPanel identity={identity} authToken={authToken} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
