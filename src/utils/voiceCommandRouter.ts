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
// weather lookup, control (stop/continue/go back/close), re-display of
// existing data (find conversation), and the deletion-safety lifecycle
// (delete / restore / permanent-delete). Deletion commands always go
// through TARGET → SCOPE → SAFETY → CONFIRMATION → BIN/PROVENANCE
// CLEANUP before any state mutates; the host drives that flow against
// /api/bin/preview and /api/bin/move.

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
  // ----------------------------------------------------------------
  // DELETION-SAFETY COMMANDS
  // ----------------------------------------------------------------
  // None of these perform any destructive action on their own. They
  // are classified by the router and the host (App.tsx) drives the
  // full confirmation flow. The host MUST resolve scope (which
  // target? how many?), call /api/bin/preview to compute the
  // affected set, render a contextual confirmation surface, and
  // only THEN call /api/bin/move with confirm=true.
  // ----------------------------------------------------------------
  /** "delete this memory" / "forget that" / "remove my last memory" */
  | 'delete-memory'
  /** "delete that conversation" / "forget our chat" */
  | 'delete-conversation'
  /** "delete all my memories" / "forget everything you know about me" */
  | 'delete-all-memories'
  /** "delete all my conversations" / "clear my history" */
  | 'delete-all-conversations'
  /** "delete this task" / "remove my task about X" */
  | 'delete-task'
  /** "delete all my tasks" / "clear all tasks" */
  | 'delete-all-tasks'
  /** "delete this pattern" / "forget my habit of X" */
  | 'delete-pattern'
  /** "delete all my patterns" / "clear all learned habits" */
  | 'delete-all-patterns'
  /** "show me the bin" / "what have I deleted" / "open trash" */
  | 'show-bin'
  /** "restore that" / "undo the delete" */
  | 'restore-from-bin'
  /** "permanently delete" / "delete it forever" */
  | 'permanently-delete'
  /** confirmation to a pending delete (yes / do it / confirm) */
  | 'confirm-destructive'
  /** cancel a pending delete (no / cancel / never mind) */
  | 'cancel-destructive'
  // Control
  | 'stop'
  | 'continue'
  | 'repeat'
  | 'help'
  // Pass-through (let the backend handle it as a normal chat turn)
  | 'chat';

export type DeletionScope =
  | 'single_memory'
  | 'single_conversation'
  | 'all_memories'
  | 'all_conversations'
  | 'single_task'
  | 'all_tasks'
  | 'single_pattern'
  | 'all_patterns';

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
  /** For delete commands: the scope the router believes is intended. */
  deletionScope?: DeletionScope;
  /** For ambiguous single-target deletes: the user's reference query. */
  targetQuery?: string;
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
  // ===========================================================
  // DELETION COMMANDS
  // ===========================================================
  // SAFETY: ALL of these are "intent" only. The host (App.tsx)
  // must call /api/bin/preview, surface a contextual confirmation
  // to the user, and only call /api/bin/move with confirm=true
  // after explicit user consent. None of these patterns trigger
  // destructive actions on their own.
  // ===========================================================
  {
    kind: 'permanently-delete',
    patterns: [
      /^(permanently\s+(delete|remove|erase|wipe|forget)|delete\s+(forever|permanently)|erase\s+forever|empty\s+(this\s+item|this\s+entry|this\s+memory|this\s+conversation)\s+permanently)/i,
      /^(permanently\s+delete\s+(that|the|my|this)?\s*(conversation|memory|task|pattern)?)/i,
    ],
    payload: (_m, raw) => {
      const stripped = raw
        .replace(/^(permanently\s+(delete|remove|erase|wipe|forget)|delete\s+(forever|permanently)|erase\s+forever|empty\s+this\s+item\s+permanently)\s*/i, '')
        .replace(/^(that|the|my|our|this)\s+/i, '')
        .trim();
      return stripped || undefined;
    },
  },
  {
    kind: 'delete-all-memories',
    patterns: [
      /^(delete|remove|forget|erase|wipe|clear)\s+(all|every|each)\s+(my\s+|of my\s+)?(memories|notes|facts|things you (know|remember))/i,
      /^(forget|erase|wipe)\s+(everything|all)\s+(you\s+)?(know|remember|about me)/i,
      /^clear\s+(your|all)\s+(memory|memories)/i,
    ],
  },
  {
    kind: 'delete-all-conversations',
    patterns: [
      /^(delete|remove|clear|wipe|forget)\s+(all|every|each)\s+(my\s+|of my\s+)?(conversations?|chats?|talks?|discussions?|history|messages?)/i,
      /^clear\s+(my|all|our)\s+(history|conversations?|chats?)/i,
    ],
  },
  {
    kind: 'delete-all-tasks',
    patterns: [
      /^(delete|remove|clear|wipe)\s+(all|every|each)\s+(my\s+|of my\s+)?(tasks?|todos?|to-?dos?|reminders?|action items?)/i,
      /^clear\s+(all\s+)?(my\s+)?(tasks?|todos?)/i,
    ],
  },
  {
    kind: 'delete-all-patterns',
    patterns: [
      /^(delete|remove|forget|clear|wipe)\s+(all|every|each)\s+(my\s+|of my\s+)?(habits?|routines?|patterns?|preferences?)/i,
      /^forget\s+(all\s+)?(my\s+)?(habits?|routines?|patterns?)/i,
    ],
  },
  {
    kind: 'delete-task',
    patterns: [
      /^(delete|remove|clear|cancel|drop)\s+(this|that|the|my)?\s*(task|todo|to-?do|reminder)\b/i,
      /^(delete|remove)\s+(the\s+)?task\s+(about|to|for)\s+(.+)/i,
    ],
    payload: (_m, raw) => {
      const ref = raw.match(/(?:about|to|for|called|named)\s+(.+)$/i);
      return ref ? ref[1].trim() : undefined;
    },
  },
  {
    kind: 'delete-pattern',
    patterns: [
      /^(delete|remove|forget|erase)\s+(this|that|the|my)?\s*(habit|routine|pattern|preference)\b/i,
      /^(forget|delete)\s+(my\s+)?(habit|routine|pattern|preference)\s+(of|about|for)\s+(.+)/i,
    ],
    payload: (_m, raw) => {
      const ref = raw.match(/(?:of|about|for|that)\s+(.+)$/i);
      return ref ? ref[1].trim() : undefined;
    },
  },
  {
    kind: 'delete-conversation',
    patterns: [
      /^(delete|remove|forget|erase|wipe|clear|drop)\s+(this|that|the|my|our)?\s*(conversation|chat|talk|discussion|session|history)/i,
      /^(forget|erase|wipe)\s+(this|that|our|my)\s+(conversation|chat|talk|discussion)/i,
      /^can you (forget|delete|erase|remove)\s+(this|that|our|my)\s+(conversation|chat|talk|discussion)/i,
    ],
    payload: (_m, raw) => {
      const ref = raw.match(/(?:about|regarding|on|where we discussed|where we talked about)\s+(.+)$/i);
      return ref ? ref[1].trim() : undefined;
    },
  },
  {
    kind: 'delete-memory',
    patterns: [
      /^(delete|remove|forget|erase|wipe|clear|drop|do away with)\s+(this|that|the|my|our)?\s*(memory|note|fact|reminder)\b/i,
      /^(forget|erase|wipe|delete)\s+(this|that|it)\b/i,
      /^(delete|remove)\s+(this|that|it)\s+memory/i,
      /^can you (forget|delete|erase|remove)\s+(this|that|it|my|about)\b(.+)?/i,
      /^please (forget|delete|erase|remove)\s+(this|that|it|my|about)\b(.+)?/i,
    ],
    payload: (_m, raw) => {
      // Try to extract a free-form reference (e.g. "delete the memory about my project")
      const ref = raw.match(/(?:about|regarding|on)\s+(.+)$/i);
      return ref ? ref[1].trim() : undefined;
    },
  },
  {
    kind: 'show-bin',
    patterns: [
      /^(show|open|view|see|check)\s+(the\s+)?(bin|trash|recycle|deleted|deleted items|recently deleted)/i,
      /^(what have i deleted|what('?s| is) in (the )?(bin|trash))/i,
    ],
  },
  {
    kind: 'restore-from-bin',
    patterns: [
      /^(restore|undo|bring back|recover)\s+(this|that|the|it)?\s*(from (the )?(bin|trash))?/i,
      /^(undo|undo that delete)/i,
    ],
  },
  // Confirmation / cancellation of a pending destructive flow
  {
    kind: 'confirm-destructive',
    patterns: [
      /^(yes|yeah|yep|sure|do it|delete it|confirm|go ahead|proceed|ok|okay|fine)/i,
    ],
  },
  {
    kind: 'cancel-destructive',
    patterns: [
      /^(no|nope|nah|cancel|stop|never mind|nevermind|don't|do not|hold on)/i,
    ],
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
        const cmd: VoiceCommand = {
          kind: entry.kind,
          cleaned,
          payload,
          confident: true,
          raw: cleaned,
        };
        // Attach deletion-scope metadata so the host can drive the
        // safe-deletion flow without re-classifying.
        if (entry.kind === 'delete-memory') cmd.deletionScope = 'single_memory';
        else if (entry.kind === 'delete-conversation') cmd.deletionScope = 'single_conversation';
        else if (entry.kind === 'delete-all-memories') cmd.deletionScope = 'all_memories';
        else if (entry.kind === 'delete-all-conversations') cmd.deletionScope = 'all_conversations';
        else if (entry.kind === 'delete-task') cmd.deletionScope = 'single_task';
        else if (entry.kind === 'delete-all-tasks') cmd.deletionScope = 'all_tasks';
        else if (entry.kind === 'delete-pattern') cmd.deletionScope = 'single_pattern';
        else if (entry.kind === 'delete-all-patterns') cmd.deletionScope = 'all_patterns';
        if (
          payload &&
          (entry.kind === 'delete-memory' ||
            entry.kind === 'delete-conversation' ||
            entry.kind === 'delete-task' ||
            entry.kind === 'delete-pattern' ||
            entry.kind === 'permanently-delete')
        ) {
          cmd.targetQuery = payload;
        }
        return cmd;
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
    case 'show-bin':
    case 'restore-from-bin':
      return 'bin';
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
    // Destructive / sensitive commands: do not auto-navigate. The
    // host renders a confirmation surface; navigation is decided
    // by the host after the user has confirmed.
    case 'delete-memory':
    case 'delete-conversation':
    case 'delete-all-memories':
    case 'delete-all-conversations':
    case 'delete-task':
    case 'delete-all-tasks':
    case 'delete-pattern':
    case 'delete-all-patterns':
    case 'permanently-delete':
    case 'confirm-destructive':
    case 'cancel-destructive':
      return null;
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
    case 'delete-memory':
      return 'Let me find that memory and check what would be affected…';
    case 'delete-conversation':
      return 'Let me find that conversation and check what would be affected…';
    case 'delete-all-memories':
      return 'Let me check what would be affected…';
    case 'delete-all-conversations':
      return 'Let me check what would be affected…';
    case 'show-bin':
      return 'Opening your Bin…';
    case 'restore-from-bin':
      return 'Restoring from the Bin…';
    case 'permanently-delete':
      return 'Permanent delete needs your explicit confirmation…';
    case 'confirm-destructive':
      return 'Confirming…';
    case 'cancel-destructive':
      return 'Cancelling the deletion…';
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
      return 'You can say things like: open my memory, show my tasks, what is the weather, go back, stop, delete my last memory, restore from bin…';
    default:
      return 'Got it…';
  }
}
