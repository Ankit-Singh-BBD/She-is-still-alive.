// ===================================================================
// CONVERSATION STREAM - Chat messages list
// ===================================================================

import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { ChatBubble, ThinkingBubble, ChatBubbleData } from './ChatBubble.js';

interface ConversationStreamProps {
  messages: ChatBubbleData[];
  isThinking?: boolean;
}

export function ConversationStream({ messages, isThinking }: ConversationStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, isThinking]);

  if (messages.length === 0 && !isThinking) {
    return null;
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-1 pt-2 pb-3"
    >
      <div className="flex flex-col gap-3 max-w-2xl mx-auto">
        {messages.map((m) => (
          <div key={m.id}>
            <ChatBubble message={m} />
          </div>
        ))}
        <AnimatePresence>{isThinking && <div key="thinking"><ThinkingBubble /></div>}</AnimatePresence>
      </div>
    </div>
  );
}
