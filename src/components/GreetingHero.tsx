import { motion } from 'motion/react';
import { FileText, BellRing, Search, Code2 } from 'lucide-react';

interface GreetingHeroProps {
  identityName: string;
  onQuickAction: (text: string) => void;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

const QUICK_ACTIONS = [
  { icon: FileText, primary: 'Summary', secondary: 'of my day', prompt: 'Give me a summary of my day' },
  { icon: BellRing, primary: 'Remind me', secondary: 'about meeting', prompt: 'Remind me about my meeting' },
  { icon: Search, primary: 'Search', secondary: 'the web', prompt: 'Search the web for the latest news' },
  { icon: Code2, primary: 'Open', secondary: 'VS Code', prompt: 'Open VS Code' },
];

export function GreetingHero({ identityName, onQuickAction }: GreetingHeroProps) {
  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="flex flex-col items-center text-center max-w-2xl mx-auto">
      <p className="text-[13px] font-medium text-white/50 tracking-wide">{dateLabel}</p>

      {/* Avatar face */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="relative mt-6 mb-6"
      >
        <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-indigo-500/40 via-violet-500/40 to-fuchsia-500/40 blur-2xl scale-125" />
        <div className="relative w-[92px] h-[92px] rounded-full bg-gradient-to-br from-sky-300/80 via-violet-400/80 to-fuchsia-400/80 flex items-center justify-center border border-white/30 glass-inset shadow-2xl shadow-violet-900/40">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-3.5 rounded-full bg-violet-950/70" />
            <span className="w-2.5 h-3.5 rounded-full bg-violet-950/70" />
          </div>
        </div>
      </motion.div>

      <motion.h1
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.5 }}
        className="text-4xl sm:text-5xl font-semibold tracking-tight text-balance"
      >
        <span className="text-gradient">
          {getGreeting()}, {identityName}
        </span>
      </motion.h1>

      {/* Removed: "How can I help you today?" — that's prompted behavior, not natural intelligence.
          Madhurita speaks when she has something to say, stays silent otherwise. */}

      {/* Quick action chips */}
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.26, duration: 0.5 }}
        className="mt-8 flex flex-wrap items-center justify-center gap-2.5"
      >
        {QUICK_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.primary}
              type="button"
              onClick={() => onQuickAction(action.prompt)}
              className="glass glass-hover rounded-2xl px-4 py-3 flex items-center gap-3 text-left cursor-pointer group"
            >
              <Icon className="w-[18px] h-[18px] text-indigo-200/90 group-hover:text-indigo-100 shrink-0" />
              <span className="leading-tight">
                <span className="block text-sm font-semibold text-white">{action.primary}</span>
                <span className="block text-[12px] text-white/55">{action.secondary}</span>
              </span>
            </button>
          );
        })}
      </motion.div>
    </div>
  );
}
