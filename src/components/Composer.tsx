import { FormEvent, KeyboardEvent } from 'react';
import { Plus, Mic, ArrowUp } from 'lucide-react';
import { LiveState } from '../types.js';

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e?: FormEvent) => void;
  onToggleVoice: () => void;
  onToggleConsole: () => void;
  isProcessing: boolean;
  liveState: LiveState;
  identityName: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onToggleVoice,
  onToggleConsole,
  isProcessing,
  liveState,
  identityName,
}: ComposerProps) {
  const voiceActive = liveState === 'listening' || liveState === 'speaking';

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Respect IME composition (CJK) before submitting on Enter
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      (e.nativeEvent as any).keyCode !== 229
    ) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="glass-panel rounded-[1.75rem] px-4 pt-4 pb-3 shadow-2xl shadow-black/30"
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Ask Madhurita anything…"
        aria-label={`Message Madhurita as ${identityName}`}
        className="w-full resize-none bg-transparent text-[15px] text-white placeholder:text-white/45 focus:outline-none leading-relaxed max-h-40 custom-scrollbar"
      />

      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onToggleConsole}
          className="w-9 h-9 rounded-full bg-white/[0.07] hover:bg-white/[0.14] border border-white/12 text-white/75 flex items-center justify-center transition-colors cursor-pointer"
          title="Conversation history & recall"
        >
          <Plus className="w-[18px] h-[18px]" />
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleVoice}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all cursor-pointer border ${
              voiceActive
                ? 'bg-gradient-to-br from-indigo-400 to-violet-500 border-white/20 text-white shadow-[0_0_20px_rgba(99,102,241,0.5)]'
                : 'bg-white/[0.09] hover:bg-white/[0.16] border-white/12 text-white/80'
            }`}
            title={voiceActive ? 'Stop voice' : 'Start voice'}
          >
            <Mic className="w-[18px] h-[18px]" />
          </button>

          <button
            type="submit"
            disabled={!value.trim() || isProcessing}
            className="w-10 h-10 rounded-full bg-white/[0.14] hover:bg-white/25 border border-white/15 text-white flex items-center justify-center transition-all disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
            title="Send"
          >
            <ArrowUp className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </form>
  );
}
