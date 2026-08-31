// ===================================================================
// CHAT BUBBLE - Single message bubble
// ===================================================================

import { motion } from 'motion/react';
import { Bot, User } from 'lucide-react';

export interface ChatBubbleData {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface ChatBubbleProps {
  message: ChatBubbleData;
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-start gap-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-400/30 via-fuchsia-400/30 to-pink-400/30 border border-white/15 text-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-4 h-4" />
        </div>
      )}
      <div
        className={`relative px-4 py-2.5 rounded-2xl max-w-[80%] text-[13.5px] leading-relaxed ${
          isUser
            ? 'glass text-white border-white/20'
            : 'bg-white/[0.06] border border-white/10 text-white/90'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-white/10 border border-white/15 text-white/80 flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-4 h-4" />
        </div>
      )}
    </motion.div>
  );
}

export function ThinkingBubble() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex items-start gap-2.5"
    >
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-400/30 via-fuchsia-400/30 to-pink-400/30 border border-white/15 text-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="w-4 h-4" />
      </div>
      <div className="px-4 py-3 rounded-2xl bg-white/[0.06] border border-white/10">
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-indigo-300/80"
              animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }}
              transition={{
                duration: 1.1,
                repeat: Infinity,
                delay: i * 0.18,
                ease: 'easeInOut',
              }}
            />
          ))}
          <span className="ml-2 text-[11.5px] text-white/55">Madhurita is thinking…</span>
        </div>
      </div>
    </motion.div>
  );
}
