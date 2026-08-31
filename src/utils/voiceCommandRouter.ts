// ===================================================================
// VOICE COMMAND ROUTER - Maps natural-language commands to UI actions
// ===================================================================
//
// Voice and manual interaction trigger the SAME underlying application
// actions and the SAME authoritative state. This module is the single
// command/action layer: both `useChat` (typed) and `useVoice` (voice
// transcripts) route through here before mutating UI state.
//
// The router is intentionally lightweight — it pattern-matches on common
// phrasings and returns a Command object that the host (App.tsx) executes
// against the same state setters the manual UI uses (setStage, etc.).
//
// Capabilities: navigation (open memory/tasks/settings/...), search,
// weather lookup, control (stop/continue/go back/close), and re-display
// of existing data (find conversation).

import { StageKey } from '../hooks/useStage.js';

export type CommandKind =
  // Navigation
  | 'open-memory'
  | 'open-search'
  | 'open-tasks'
  | 'open-calendar'
  | 'open-devices'
  | 'open-identity'
  | 'open-settings'
  | 'go-home'
  | 'go-back'
  | 'close-panel'
  // Search / retrieval
  | 'search-query'
  | 'recall-conversation'
  // Quick info
  | 'show-weather'
  | 'summarize-day'
  // Tasks
  | 'show-tasks'
  | 'add-task'
  // Control
  | 'stop'
  | 'continue'
  | 'repeat'
  | 'help'
  // Pass-through (let the backend handle it as a normal chat turn)
  | 'chat';

export interface VoiceCommand {
  kind: CommandKind;
  /** The cleaned, normalized command text */
  cleaned: string;
  /** Free-form payload (e.g. search query, task text) */
  payload?: string;
  /** Whether this command is high-confidence (true) or a guess (false) */
  confident: boolean;
  /** Original user text (for analytics / acknowledgement) */
  raw: string;
}

const PATTERNS: Array<{
  kind: CommandKind;
  patterns: RegExp[];
  payload?: (match: RegExpMatchArray, raw: string) => string | undefined;
}> = [
  {
    kind: 'open-memory',
    patterns: [
      /^(check|open|show|see|view|load|recall|look at|find)\s+(my\s+)?(memory|memories|notes|reminders)/i,
      /^(what do you remember|what (have you|'ve you) (learned|remembered|noted))/i,
    ],
  },
  {
    kind: 'open-search',
    patterns: [
      /^(search|find|look\s*up|query)\b/i,
      /^(search (my|for|through)\s+)/i,
    ],
  },
  {
    kind: 'open-tasks',
    patterns: [
      /^(open|show|see|view|list|check)\s+(my\s+)?(tasks?|todos?|to-?dos?|action items?)/i,
    ],
  },
  {
    kind: 'show-tasks',
    patterns: [
      /^(what|which)\s+(are\s+)?(my\s+)?(pending\s+)?(tasks?|todos?)/i,
      /^tasks?\??$/i,
    ],
  },
  {
    kind: 'open-calendar',
    patterns: [
      /^(open|show)\s+(the\s+)?calendar/i,
      /^(my\s+)?schedule/i,
    ],
  },
  {
    kind: 'open-devices',
    patterns: [
      /^(open|show)\s+(my\s+)?(devices?|connected|gadgets?)/i,
    ],
  },
  {
    kind: 'open-identity',
    patterns: [
      /^(switch|change)\s+(identity|profile|user|account)/i,
      /^who am i\b/i,
    ],
  },
  {
    kind: 'open-settings',
    patterns: [
      /^(open|show|go to)\s+(the\s+)?settings/i,
      /^(change|tune|configure|update)\s+(my\s+)?(persona|voice|preferences?|settings)/i,
    ],
  },
  {
    kind: 'go-home',
    patterns: [
      /^(go\s+)?home\b/i,
      /^(back to (home|the start|main))$/i,
    ],
  },
  {
    kind: 'go-back',
    patterns: [
      /^(go\s+)?back$/i,
      /^(back|previous)\s*$/i,
      /^return$/i,
    ],
  },
  {
    kind: 'close-panel',
    patterns: [
      /^(close|hide|dismiss|minimize|collapse)\s+(this|that|the)?\s*(panel|window|screen|view)?/i,
    ],
  },
  {
    kind: 'search-query',
    patterns: [
      /^(search|find|look\s*up)\s+(for\s+)?(.+)/i,
    ],
    payload: (_m, raw) => raw.replace(/^(search|find|look\s*up)\s+(for\s+)?/i, '').trim(),
  },
  {
    kind: 'recall-conversation',
    patterns: [
      /^(what did we (talk|chat|discuss) about|recall our conversation|previous conversation)/i,
      /^(find (that|our)\s+conversation)/i,
    ],
    payload: (_m, raw) => {
      const m = raw.match(/(?:about|on|where we)\s+(.+)$/i);
      return m ? m[1].trim() : raw;
    },
  },
  {
    kind: 'show-weather',
    patterns: [
      /^(what('?s| is)\s+)?(the\s+)?weather(\s+like)?\s*(today|right now|now)?\??$/i,
      /^(show|tell me|how('?s| is))\s+(the\s+)?weather/i,
    ],
  },
  {
    kind: 'summarize-day',
    patterns: [
      /^(summarize|recap|review)\s+(my\s+)?(day|morning|afternoon|evening|today)/i,
    ],
  },
  {
    kind: 'add-task',
    patterns: [
      /^(add|create|new|make|set up)\s+(a\s+)?(task|todo|to-?do|reminder)/i,
      /^(remind me to|don't let me forget to)\s+(.+)/i,
    ],
    payload: (_m, raw) => {
      const cleaned = raw
        .replace(/^(add|create|new|make|set up)\s+(a\s+)?(task|todo|to-?do|reminder)\s+(to\s+)?/i, '')
        .replace(/^(remind me to|don't let me forget to)\s+/i, '')
        .trim();
      return cleaned || undefined;
    },
  },
  {
    kind: 'stop',
    patterns: [
      /^stop$/i,
      /^(cancel|never mind|nevermind)$/i,
      /^(shut up|quiet|silence)$/i,
    ],
  },
  {
    kind: 'continue',
    patterns: [
      /^(continue|go on|proceed|keep going|carry on)$/i,
    ],
  },
  {
    kind: 'repeat',
    patterns: [
      /^(repeat|say that again|again|do that again)$/i,
    ],
  },
  {
    kind: 'help',
    patterns: [
      /^(help|what can you do|commands?|what('?s| is) (available|possible))$/i,
    ],
  },
];

/**
 * Classify a natural-language input into a structured command.
 * Returns a chat-fallback command if no pattern matches.
 */
export function routeVoiceCommand(raw: string): VoiceCommand {
  const cleaned = (raw || '').trim();
  if (!cleaned) {
    return { kind: 'chat', cleaned: '', confident: false, raw };
  }

  for (const entry of PATTERNS) {
    for (const pattern of entry.patterns) {
      const m = cleaned.match(pattern);
      if (m) {
        const payload = entry.payload ? entry.payload(m, cleaned) : undefined;
        return {
          kind: entry.kind,
          cleaned,
          payload,
          confident: true,
          raw: cleaned,
        };
      }
    }
  }

  return { kind: 'chat', cleaned, confident: false, raw: cleaned };
}

/** Which stage a command maps to (null = no nav). */
export function stageForCommand(cmd: VoiceCommand): StageKey | null {
  switch (cmd.kind) {
    case 'open-memory':
      return 'memory';
    case 'open-search':
    case 'search-query':
    case 'recall-conversation':
      return 'search';
    case 'open-tasks':
    case 'show-tasks':
    case 'add-task':
      return 'tasks';
    case 'open-calendar':
      return 'calendar';
    case 'open-devices':
      return 'devices';
    case 'open-identity':
      return 'identity';
    case 'open-settings':
      return 'settings';
    case 'go-home':
    case 'close-panel':
      return 'home';
    case 'go-back':
      return null; // caller decides
    default:
      return null;
  }
}

/** Human-friendly acknowledgement for a command. */
export function acknowledgeCommand(cmd: VoiceCommand): string {
  switch (cmd.kind) {
    case 'open-memory':
      return 'Opening your memory…';
    case 'open-search':
      return 'Opening search…';
    case 'search-query':
      return `Searching for "${cmd.payload ?? ''}"…`;
    case 'recall-conversation':
      return `Looking for that conversation…`;
    case 'open-tasks':
    case 'show-tasks':
      return 'Pulling up your tasks…';
    case 'add-task':
      return cmd.payload
        ? `Adding: "${cmd.payload}"…`
        : 'Adding a task…';
    case 'open-calendar':
      return 'Opening your calendar…';
    case 'open-devices':
      return 'Looking at your devices…';
    case 'open-identity':
      return 'Switching identity…';
    case 'open-settings':
      return 'Opening settings…';
    case 'show-weather':
      return "Checking the weather for you…";
    case 'summarize-day':
      return 'Let me piece your day together…';
    case 'go-home':
      return 'Bringing you home…';
    case 'close-panel':
      return 'Closing…';
    case 'go-back':
      return 'Going back…';
    case 'stop':
      return 'Stopping…';
    case 'continue':
      return 'Continuing…';
    case 'repeat':
      return 'Repeating that…';
    case 'help':
      return 'You can say things like: open my memory, show my tasks, what is the weather, go back, stop…';
    default:
      return 'Got it…';
  }
}
