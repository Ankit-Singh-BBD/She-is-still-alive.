// ===================================================================
// QUICK ACTION CHIPS - Horizontally scrollable suggestion chips
// ===================================================================

import { motion } from 'motion/react';
import {
  Sparkles,
  Cloud,
  Brain,
  CalendarClock,
  ListTodo,
  Heart,
  Mic,
  Lightbulb,
  Search,
} from 'lucide-react';
import { useHomeMetrics } from '../../hooks/useUIState.js';
import { ReactNode } from 'react';

interface QuickAction {
  id: string;
  label: string;
  icon: ReactNode;
  prompt: string;
  /** Whether this chip should pulse gently to suggest action */
  emphasize?: boolean;
}

interface QuickActionChipsProps {
  onAction: (prompt: string) => void;
  disabled?: boolean;
}

export function QuickActionChips({ onAction, disabled }: QuickActionChipsProps) {
  const metrics = useHomeMetrics();

  // Adapt chips to context (single source of truth: backend metrics)
  const chips: QuickAction[] = [
    {
      id: 'summarize-day',
      label: 'Summarize my day',
      icon: <Sparkles className="w-3.5 h-3.5" />,
      prompt: 'Summarize my day',
    },
    {
      id: 'weather',
      label: "What's the weather?",
      icon: <Cloud className="w-3.5 h-3.5" />,
      prompt: "What's the weather like right now?",
    },
    {
      id: 'memory',
      label: 'Open my memory',
      icon: <Brain className="w-3.5 h-3.5" />,
      prompt: 'What do you remember about me?',
    },
    {
      id: 'plan-tomorrow',
      label: 'Plan tomorrow',
      icon: <CalendarClock className="w-3.5 h-3.5" />,
      prompt: 'Help me plan tomorrow',
    },
    {
      id: 'pending-tasks',
      label: 'Show my tasks',
      icon: <ListTodo className="w-3.5 h-3.5" />,
      prompt: 'Show me my pending tasks',
      emphasize: metrics.activeTasks > 0,
    },
    {
      id: 'how-are-you',
      label: 'How are you feeling?',
      icon: <Heart className="w-3.5 h-3.5" />,
      prompt: 'How are you feeling right now?',
    },
    {
      id: 'voice-demo',
      label: 'Try voice mode',
      icon: <Mic className="w-3.5 h-3.5" />,
      prompt: 'Let me talk to you',
    },
    {
      id: 'suggestion',
      label: 'Surprise me',
      icon: <Lightbulb className="w-3.5 h-3.5" />,
      prompt: 'Suggest something I might enjoy right now',
    },
    {
      id: 'recall-search',
      label: 'Search my past',
      icon: <Search className="w-3.5 h-3.5" />,
      prompt: 'What did we talk about recently?',
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4, duration: 0.5 }}
      className="w-full"
    >
      <div
        className="flex items-center gap-2 overflow-x-auto scrollbar-thin pb-1 -mx-2 px-2 no-scrollbar"
        style={{ scrollbarWidth: 'thin' }}
      >
        {chips.map((chip, i) => (
          <motion.button
            key={chip.id}
            type="button"
            onClick={() => !disabled && onAction(chip.prompt)}
            disabled={disabled}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 + i * 0.05, duration: 0.4 }}
            whileHover={{ scale: 1.04, y: -1 }}
            whileTap={{ scale: 0.96 }}
            className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-all cursor-pointer press-scale ${
              chip.emphasize
                ? 'glass border-indigo-300/30 text-indigo-100 shadow-[0_0_18px_rgba(99,102,241,0.18)]'
                : 'glass text-white/80 hover:text-white'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <span className={chip.emphasize ? 'text-indigo-200' : 'text-white/60'}>
              {chip.icon}
            </span>
            <span className="whitespace-nowrap">{chip.label}</span>
            {chip.emphasize && (
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-300 animate-soft-glow" />
            )}
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
