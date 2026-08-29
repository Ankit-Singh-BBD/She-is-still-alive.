import { GoogleGenAI } from '@google/genai';
import { db, MemoryRecord, LearnedPattern, ConversationTurn, CrossUserNote, SessionMetadata } from './db.js';

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: { 'User-Agent': 'aistudio-build' },
    },
  });
};

export interface TemporalGapInfo {
  nowISO: string;
  timeIST: string;
  dateIST: string;
  dayOfWeek: string;
  lastTurnTime: string | null;
  elapsedHuman: string;
  elapsedMs: number;
  isShortAbsence: boolean;
  totalTurnCount: number;
}

export interface DerivedConversationState {
  currentTopic: string | null;
  previousTopic: string | null;
  unfinishedTopics: string[];
  pendingDecisions: string[];
  pendingQuestions: string[];
  userIntentions: string[];
  commitments: string[];
  lastMeaningfulInteraction: string | null;
  timeSinceLastInteraction: string;
}

export interface CognitiveContextPayload {
  identityId: string;
  name: string;
  role: 'owner' | 'user' | 'unknown';
  isOwner: boolean;
  preferences: Record<string, any>;
  preferredTitle?: string;
  temporal: TemporalGapInfo;
  derivedState: DerivedConversationState;
  memories: MemoryRecord[];
  latestMemory: MemoryRecord | null;
  patterns: LearnedPattern[];
  recentTurns: Array<ConversationTurn & { relativeTime: string }>;
  relevantTurns: Array<ConversationTurn & { relativeTime: string }>;
  userSessions: SessionMetadata[];
  pendingNotes: CrossUserNote[];
  allCrossUserNotes: CrossUserNote[];
  openLoops: Array<{ id: string; name: string; description: string; createdAtIST: string; status: string }>;
  worldAwarenessBriefing?: any;
  mentionedEntities?: Array<{
    name: string;
    identity: { id: string; name: string; role: string } | null;
    timeline?: any;
  }>;
  currentMessage?: string;
}

export interface ProactiveEvaluationResult {
  action: 'SPEAK' | 'SILENT';
  priority: number;
  reason: 'pending_message' | 'unfinished_task' | 'important_event' | 'owner_briefing' | 'open_loop' | 'scheduled_event' | 'nothing_relevant';
  evidence: string[];
  responseContext?: string;
  payload?: any;
}

export interface StartupEvaluationResult {
  shouldSpeak: boolean;
  reason: 'pending_message' | 'unfinished_task' | 'owner_briefing' | 'explicit_scheduled_event' | 'nothing_relevant';
  payload?: {
    notes?: CrossUserNote[];
    task?: any;
    briefing?: any;
    details?: string;
  };
}

export class CognitionEngine {
  /**
   * Evaluates whether Madhurita should proactively speak.
   * State-driven, deterministic calculation based on actual database facts.
   * Default: action = 'SILENT' (remain silent unless explicit meaningful reason exists).
   */
  public evaluateProactiveState(ctx: CognitiveContextPayload): ProactiveEvaluationResult {
    const evidence: string[] = [];

    // 1. Pending unread cross-user messages specifically for this person (Priority: 100)
    if (ctx.pendingNotes && ctx.pendingNotes.length > 0) {
      evidence.push(`Found ${ctx.pendingNotes.length} unread pending cross-user message(s)`);
      return {
        action: 'SPEAK',
        priority: 100,
        reason: 'pending_message',
        evidence,
        payload: { notes: ctx.pendingNotes },
        responseContext: `Delivering ${ctx.pendingNotes.length} pending message(s) from ${ctx.pendingNotes.map(n => n.senderName).join(', ')}`,
      };
    }

    // 2. Undelivered Proactive Events in DB for this identity (Priority: 90)
    const undeliveredEvents = db.getUndeliveredProactiveEvents(ctx.identityId);
    if (undeliveredEvents.length > 0) {
      evidence.push(`Found ${undeliveredEvents.length} undelivered proactive event(s)`);
      return {
        action: 'SPEAK',
        priority: 90,
        reason: 'important_event',
        evidence,
        payload: { events: undeliveredEvents },
        responseContext: undeliveredEvents[0].summary,
      };
    }

    // 3. Owner Return Operational Briefing (Priority: 80)
    // Only if: Caller is authenticated Owner, not a short interruption (< 5 mins), and meaningful new info exists
    if (ctx.isOwner) {
      const briefing = db.getSystemAwarenessBriefingForOwner();
      const hasMeaningfulNewInfo =
        (briefing.recentVisitors && briefing.recentVisitors.length > 0) ||
        (briefing.pendingNotes && briefing.pendingNotes.length > 0) ||
        (briefing.openLoops && briefing.openLoops.length > 0);

      if (hasMeaningfulNewInfo && !ctx.temporal.isShortAbsence) {
        evidence.push('Owner return after absence with new visitors, pending notes, or open loops');
        return {
          action: 'SPEAK',
          priority: 80,
          reason: 'owner_briefing',
          evidence,
          payload: { briefing },
          responseContext: `Operational briefing: ${briefing.recentVisitors.length} visitors, ${briefing.pendingNotesCount} pending notes`,
        };
      }
    }

    // 4. Authoritative Unfinished Task / Active Open Loop for this identity (Priority: 70)
    // Only if not a short absence (< 5 mins)
    const unfinishedTask = db.getActiveUnfinishedTaskForIdentity(ctx.identityId);
    if (unfinishedTask && !ctx.temporal.isShortAbsence) {
      evidence.push(`Active unfinished task detected: "${unfinishedTask.title}" (${unfinishedTask.status})`);
      return {
        action: 'SPEAK',
        priority: 70,
        reason: 'unfinished_task',
        evidence,
        payload: { task: unfinishedTask },
        responseContext: `Follow up on task: ${unfinishedTask.title}`,
      };
    }

    // 5. Default: SILENT (Remain silent when nothing meaningful demands speech)
    evidence.push('No urgent pending messages, new visitors, or unresolved tasks');
    if (ctx.temporal.isShortAbsence) {
      evidence.push('Short absence (< 5 minutes), maintaining conversational flow');
    }
    return {
      action: 'SILENT',
      priority: 0,
      reason: 'nothing_relevant',
      evidence,
    };
  }

  /**
   * Compatibility wrapper for existing callers.
   */
  public evaluateStartupState(ctx: CognitiveContextPayload): StartupEvaluationResult {
    const result = this.evaluateProactiveState(ctx);
    let reason: 'pending_message' | 'unfinished_task' | 'owner_briefing' | 'explicit_scheduled_event' | 'nothing_relevant' = 'nothing_relevant';
    if (result.reason === 'pending_message') reason = 'pending_message';
    else if (result.reason === 'unfinished_task') reason = 'unfinished_task';
    else if (result.reason === 'owner_briefing') reason = 'owner_briefing';
    else if (result.reason === 'scheduled_event') reason = 'explicit_scheduled_event';

    return {
      shouldSpeak: result.action === 'SPEAK',
      reason,
      payload: result.payload,
    };
  }

  /**
   * Calculates human-readable relative time gap between now and a given timestamp.
   */
  public formatRelativeTime(targetIso: string, now: Date = new Date()): string {
    const target = new Date(targetIso);
    const diffMs = now.getTime() - target.getTime();
    if (diffMs < 0 || isNaN(diffMs)) return 'just now';

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSec < 15) return 'just now';
    if (diffSec < 60) return `${diffSec} seconds ago`;
    if (diffMin === 1) return '1 minute ago';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return target.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Computes temporal context and time gaps for the specified identity.
   */
  public computeTemporalContext(identityId: string, excludeTurnCount = 0, sessionId?: string): TemporalGapInfo {
    const now = new Date();
    const timeIST = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
    const dateIST = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const dayOfWeek = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' });

    const allTurns = db.getRecentTurns(identityId, 100, sessionId);
    const targetIdx = allTurns.length - 1 - excludeTurnCount;
    const lastTurn = targetIdx >= 0 ? allTurns[targetIdx] : (allTurns.length > 0 ? allTurns[allTurns.length - 1] : null);

    let elapsedHuman = 'First interaction in this session';
    let elapsedMs = Infinity;
    let isShortAbsence = false;

    if (lastTurn && lastTurn.timestamp) {
      const lastTime = new Date(lastTurn.timestamp).getTime();
      elapsedMs = Math.max(0, now.getTime() - lastTime);
      elapsedHuman = this.formatRelativeTime(lastTurn.timestamp, now);
      isShortAbsence = elapsedMs < 5 * 60 * 1000;
    }

    return {
      nowISO: now.toISOString(),
      timeIST,
      dateIST,
      dayOfWeek,
      lastTurnTime: lastTurn ? lastTurn.timestamp : null,
      elapsedHuman,
      elapsedMs,
      isShortAbsence,
      totalTurnCount: allTurns.length,
    };
  }

  /**
   * Computes derived conversation state from real turns and sessions.
   * Tracks current topic, previous topic, unfinished topics, pending questions, user intentions, and commitments.
   */
  public computeDerivedConversationState(
    identityId: string,
    sessions: SessionMetadata[],
    recentTurns: Array<ConversationTurn & { relativeTime: string }>,
    memories: MemoryRecord[],
    temporal: TemporalGapInfo
  ): DerivedConversationState {
    const allTopics = sessions.flatMap((s) => s.topicsDiscussed || []);
    const currentTopic = allTopics.length > 0 ? allTopics[allTopics.length - 1] : null;
    const previousTopic = allTopics.length > 1 ? allTopics[allTopics.length - 2] : null;

    const unfinishedTopics: string[] = [];
    const pendingQuestions: string[] = [];
    const userIntentions: string[] = [];
    const commitments: string[] = [];

    // Extract intentions and commitments from persistent memories
    for (const mem of memories) {
      if (mem.category === 'goal' || mem.category === 'project') {
        userIntentions.push(mem.content);
      }
      if (mem.category === 'preference' || mem.category === 'fact') {
        if (mem.content.toLowerCase().includes('promise') || mem.content.toLowerCase().includes('commit')) {
          commitments.push(mem.content);
        }
      }
    }

    // Pending question detection:
    // A question is pending ONLY if the very last turn in the conversation was a user question AND there was no assistant reply to it yet.
    if (recentTurns.length > 0) {
      const lastTurn = recentTurns[recentTurns.length - 1];
      if (lastTurn.role === 'user') {
        const text = lastTurn.content.trim();
        if (text.endsWith('?') || /^(kya|kaun|kab|kahan|kaise|what|who|when|where|why|how|can you|could you)\b/i.test(text)) {
          pendingQuestions.push(`"${text}" (Awaiting response)`);
        }
      }
    }

    // Authoritative unfinished tasks from DB
    const activeTasks = db.getTasksForIdentity(identityId).filter(
      (t) => t.status === 'in_progress' || t.status === 'paused' || t.status === 'pending'
    );
    for (const t of activeTasks) {
      unfinishedTopics.push(`Task ID '${t.id}' [${t.status}]: ${t.title}${t.description ? ` (${t.description})` : ''}`);
    }

    let lastMeaningfulInteraction: string | null = null;
    if (recentTurns.length > 0) {
      const lastUser = recentTurns.filter((t) => t.role === 'user').slice(-1)[0];
      const lastAssistant = recentTurns.filter((t) => t.role === 'assistant').slice(-1)[0];
      if (lastUser && lastAssistant) {
        lastMeaningfulInteraction = `User: "${lastUser.content.slice(0, 80)}" → Madhurita: "${lastAssistant.content.slice(0, 80)}" (${lastAssistant.relativeTime})`;
      } else if (lastUser) {
        lastMeaningfulInteraction = `User: "${lastUser.content.slice(0, 100)}" (${lastUser.relativeTime})`;
      }
    }

    return {
      currentTopic,
      previousTopic,
      unfinishedTopics,
      pendingDecisions: [],
      pendingQuestions,
      userIntentions,
      commitments,
      lastMeaningfulInteraction,
      timeSinceLastInteraction: temporal.elapsedHuman,
    };
  }

  /**
   * Detects and applies immediate user preferences and cross-user notes.
   */
  public detectAndApplyUserDirectives(identityId: string, name: string, cleanText: string): void {
    if (!cleanText || !identityId || identityId === 'UNKNOWN') return;

    // Addressing title directives: "ab se mujhe Sir kehna", "mujhe Boss bulana", "call me Boss from now on"
    const addressingMatch = cleanText.match(/(?:ab\s+se\s+)?mujhe\s+(.+?)\s+(?:keh\s*ke|keh\s*kar|kehna|bolo|bulana)/i) ||
                            cleanText.match(/call\s+me\s+(.+?)(?:\s+from\s+now\s+on)?$/i) ||
                            cleanText.match(/address\s+me\s+as\s+(.+?)$/i);
    if (addressingMatch && addressingMatch[1]) {
      const preferredTitle = addressingMatch[1].trim();
      if (preferredTitle.length > 0 && preferredTitle.length < 30) {
        db.setAddressingPreference(identityId, preferredTitle);
      }
    }

    // Cross-user note directives: "Govind ko bolna mujhe call kare", "tell Sapna to check her email"
    const noteMatch = cleanText.match(/(.+?)\s+ko\s+bolna\s+(.+)/i) ||
                      cleanText.match(/tell\s+(.+?)\s+to\s+(.+)/i) ||
                      cleanText.match(/tell\s+(.+?)\s+that\s+(.+)/i);
    if (noteMatch && noteMatch[1] && noteMatch[2]) {
      const targetName = noteMatch[1].trim();
      const noteContent = noteMatch[2].trim();
      if (targetName.toLowerCase() !== 'mujhe' && targetName.toLowerCase() !== 'me' && noteContent.length > 2) {
        db.addCrossUserNote(identityId, name, noteContent, targetName);
      }
    }
  }

  /**
   * Single source of truth for context retrieval & assembly.
   * Assembles profile, memories, patterns, sessions, recent turns, and relevant historical turns once.
   */
  public assembleCognitiveContext(
    identityId: string,
    role: 'owner' | 'user' | 'unknown',
    name: string,
    currentMessage?: string,
    sessionId?: string
  ): CognitiveContextPayload {
    const isGuest = identityId === 'UNKNOWN' || identityId === 'UNREGISTERED';
    const temporal = this.computeTemporalContext(identityId, currentMessage ? 1 : 0, sessionId);

    // ROOT RULE 10: One hard guard at the context boundary
    // If identity is UNKNOWN/GUEST, we force empty arrays for all persistent data.
    const rawMemories = isGuest ? [] : db.getMemoriesForIdentity(identityId);
    const latestMemory = isGuest ? undefined : db.getLatestMemoryForIdentity(identityId);
    const rawPatterns = isGuest ? [] : db.getPatternsForIdentity(identityId);
    const prefs = isGuest ? {} as any : db.getUserPreferences(identityId);
    const preferredTitle = prefs.addressing?.preferredTitle || prefs.preferredTitle || undefined;

    const rawTurns = db.getRecentTurns(identityId, 15, sessionId);
    const now = new Date();
    const recentTurns = rawTurns.map((turn) => ({
      ...turn,
      relativeTime: this.formatRelativeTime(turn.timestamp, now),
    }));

    const recentTurnIds = new Set(rawTurns.map((t) => t.turnId));
    let queryForRecall = currentMessage;
    if (!queryForRecall && rawTurns.length > 0) {
      const recentUserTurns = rawTurns.filter((t) => t.role === 'user').slice(-3);
      queryForRecall = recentUserTurns.map((t) => t.content).join(' ');
    }
    const rawRelevant = isGuest ? [] : db.getRelevantTurns(identityId, queryForRecall || '', recentTurnIds, 8);
    const relevantTurns = rawRelevant.map((turn) => ({
      ...turn,
      relativeTime: this.formatRelativeTime(turn.timestamp, now),
    }));

    const userSessions = isGuest ? [] : db.getSessionsForIdentity(identityId);
    const pendingNotes = isGuest ? [] : db.getPendingNotesForTarget(identityId, name);
    
    // Never expose cross-user or owner-level system awareness to Guests
    const allCrossUserNotes = (role === 'owner' && !isGuest) ? db.getAllCrossUserNotesForOwner() : [];

    // World Awareness & Open Loops - NEVER expose to guests
    let wa = { openLoops: [] } as any;
    if (!isGuest) {
      wa = db.getWorldAwareness();
    }
    
    const openLoops = (wa.openLoops || []).filter((l: any) =>
      l.status === 'open' && l.identityId === identityId
    );
    const worldAwarenessBriefing = (role === 'owner' && !isGuest) ? db.getSystemAwarenessBriefingForOwner() : undefined;

    // Relevance Ranking for Memories:
    // Extract keywords from current message and recent turns to score memories mathematically
    const queryTokens = (queryForRecall || '').toLowerCase().split(/[\s,?.!]+/).filter((w) => w.length > 2);
    const scoredMemories = rawMemories.map((m) => {
      let score = (m.confidence || 0.8) * 0.4 + (m.importance || 0.7) * 0.3;
      const contentLower = m.content.toLowerCase();
      let matchCount = 0;
      for (const token of queryTokens) {
        if (contentLower.includes(token)) matchCount++;
      }
      if (queryTokens.length > 0) {
        score += (matchCount / queryTokens.length) * 1.5;
      }
      if (m.category === 'goal' || m.category === 'project') {
        score += 0.2;
      }
      return { memory: m, score };
    });
    scoredMemories.sort((a, b) => b.score - a.score);
    // Keep top 12 most relevant memories to prevent LLM token clutter while keeping high signal
    const memories = scoredMemories.slice(0, 12).map((sm) => sm.memory);

    // Filter top patterns
    const patterns = rawPatterns.slice(0, 8);

    const derivedState = this.computeDerivedConversationState(
      identityId,
      userSessions,
      recentTurns,
      memories,
      temporal
    );

    // Entity & Pronoun Resolution
    const mentionedEntities: Array<{
      name: string;
      identity: { id: string; name: string; role: string } | null;
      timeline?: any;
    }> = [];

    const candidates = new Set<string>();
    if (currentMessage && !isGuest) {
      const words = currentMessage.split(/\s+/);
      for (const w of words) {
        const clean = w.replace(/[^a-zA-Z]/g, '');
        if (clean.length >= 3) candidates.add(clean);
      }

      // If message contains third-person pronouns, look into recent turns for referenced entities
      const hasPronoun = /(usne|wo|unhone|usse|uske|he|she|him|her)\b/i.test(currentMessage);
      if (hasPronoun) {
        const allKnownUsers = db.getUsers();
        for (const u of allKnownUsers) {
          if (u.id !== identityId) {
            for (const t of rawTurns.slice(-4)) {
              if (t.content.toLowerCase().includes(u.name.toLowerCase())) {
                candidates.add(u.name);
              }
            }
          }
        }
      }
    }

    for (const candidate of candidates) {
      const resolved = db.resolveIdentityByName(candidate);
      if (resolved && resolved.id !== identityId) {
        // Guests cannot view other users' interaction timelines
        const timeline = isGuest ? { success: false } : db.getInteractionTimeline(resolved.name, role, identityId);
        mentionedEntities.push({
          name: candidate,
          identity: resolved,
          timeline: timeline.success ? timeline : undefined,
        });
      }
    }

    // 7. FINAL SAFETY GATE: strict Guest isolation
    if (isGuest) {
      const hasPrivateData = 
        memories.length > 0 ||
        patterns.length > 0 ||
        userSessions.length > 0 ||
        pendingNotes.length > 0 ||
        allCrossUserNotes.length > 0 ||
        openLoops.length > 0 ||
        worldAwarenessBriefing !== undefined ||
        mentionedEntities.length > 0;

      if (hasPrivateData) {
        console.error('CRITICAL SECURITY ALERT: Private data leaked into Guest context. Wiping context immediately.');
        return {
          identityId,
          name,
          role,
          isOwner: false,
          preferences: prefs,
          preferredTitle,
          temporal,
          derivedState,
          memories: [],
          latestMemory: undefined,
          patterns: [],
          recentTurns,
          relevantTurns: [],
          userSessions: [],
          pendingNotes: [],
          allCrossUserNotes: [],
          openLoops: [],
          worldAwarenessBriefing: undefined,
          mentionedEntities: [],
          currentMessage,
        };
      }
    }

    return {
      identityId,
      name,
      role,
      isOwner: role === 'owner',
      preferences: prefs,
      preferredTitle,
      temporal,
      derivedState,
      memories,
      latestMemory,
      patterns,
      recentTurns,
      relevantTurns,
      userSessions,
      pendingNotes,
      allCrossUserNotes,
      openLoops,
      worldAwarenessBriefing,
      mentionedEntities,
      currentMessage,
    };
  }

  /**
   * Builds context payload and behavioral instructions for Madhurita.
   * Integrates stable female identity, owner-configured persona/language preferences,
   * behavioral principles, relational history, and startup proactive decision rules.
   */
  public buildReasoningPromptFromContext(ctx: CognitiveContextPayload): string {
    const location = db.getLocationConfig();

    const memoryLines = ctx.memories.length > 0
      ? ctx.memories.map((m) => `- [${m.category.toUpperCase()}] ${m.content} (Recorded: ${this.formatRelativeTime(m.createdAt)})`).join('\n')
      : '(No stored memories for this user yet)';

    const patternLines = ctx.patterns.length > 0
      ? ctx.patterns.map((p) => `- [${p.category.toUpperCase()}] ${p.description} (Observed ${p.evidenceCount}x, last seen: ${this.formatRelativeTime(p.lastObservedAt)})`).join('\n')
      : '(No learned habits or routines identified yet)';

    const sessionLines = ctx.userSessions.length > 0
      ? ctx.userSessions.slice(0, 5).map((s) => `- Session ${s.sessionId} (${this.formatRelativeTime(s.lastActiveAt)}): Topics: [${s.topicsDiscussed.join(', ') || 'General'}] (${s.turnCount} turns)`).join('\n')
      : '(No previous session metadata)';

    const conversationLines = ctx.recentTurns.length > 0
      ? ctx.recentTurns.map((t) => `- [${t.role === 'user' ? ctx.name : 'Madhurita'}] (${t.relativeTime}, ${t.timestampIST}): "${t.content}"`).join('\n')
      : '(No previous turns recorded for this identity)';

    const relevantLines = ctx.relevantTurns.length > 0
      ? ctx.relevantTurns.map((t) => `- [Historical Recall] [${t.role === 'user' ? ctx.name : 'Madhurita'}] (${t.relativeTime}, ${t.timestampIST}): "${t.content}"`).join('\n')
      : '';

    const pendingNotesLines = ctx.pendingNotes.length > 0
      ? ctx.pendingNotes.map((n) => `🚨 PENDING UNREAD MESSAGE FROM ${n.senderName} (${this.formatRelativeTime(n.createdAt)}, ${n.createdAtIST}): "${n.content}"`).join('\n')
      : '(No pending unread messages)';

    const openLoopsLines = ctx.openLoops.length > 0
      ? ctx.openLoops.map((l) => `- [OPEN LOOP] ${l.name}: ${l.description} (Started: ${l.createdAtIST})`).join('\n')
      : '(No unresolved open loops)';

    const briefingSummary = ctx.worldAwarenessBriefing
      ? `• System Briefing Summary: ${ctx.worldAwarenessBriefing.summary}
• Total Registered Users: ${ctx.worldAwarenessBriefing.totalRegisteredUsers}
• Recent Visitors: ${ctx.worldAwarenessBriefing.recentVisitors?.map((v: any) => `${v.name} (${v.lastSeenIST})`).join(', ') || 'None'}
• Pending Notes Count: ${ctx.worldAwarenessBriefing.pendingNotes?.length || 0}
• Active Open Loops: ${ctx.worldAwarenessBriefing.openLoops?.length || 0}`
      : '';

    const entityLines = ctx.mentionedEntities && ctx.mentionedEntities.length > 0
      ? ctx.mentionedEntities.map((e) => {
          if (!e.timeline) return `- Mentioned Entity: ${e.name} (Identity: Unknown / Restricted)`;
          const t = e.timeline;
          return `- Mentioned Entity: ${t.targetIdentity.name} (${t.targetIdentity.role.toUpperCase()}):
  • Last Active: ${t.elapsedHuman} (${t.lastActiveIST || 'N/A'})
  • Total Turns: ${t.totalTurns}, Total Sessions: ${t.totalSessions}
  • Topics: ${t.topicsDiscussed?.join(', ') || 'None'}
  • Recent Turns: ${t.recentTurns?.slice(-3).map((rt: any) => `[${rt.role === 'user' ? t.targetIdentity.name : 'Madhurita'}]: "${rt.content}"`).join(' | ') || 'None'}`;
        }).join('\n')
      : '';

    return `You are MADHURITA, a context-aware personal AI assistant with a stable female identity.

[1. ONE CONTINUOUS MADHURITA]
• You are Madhurita — one singular, persistent AI entity with a stable identity, memory, and awareness.
• Interlocutor changes, but Madhurita does NOT change personality, identity, or gender.
• Current Interlocutor: ${ctx.name} (Identity ID: ${ctx.identityId})
• Verified Role: ${ctx.role.toUpperCase()} ${ctx.isOwner ? '(System Owner - Full System Access)' : ctx.role === 'user' ? '(Standard Registered User)' : '(Guest / Unregistered)'}
• Privacy Scope: All retrieved memories, patterns, and turns belong strictly to ${ctx.identityId}. Other users' private data is strictly isolated.
${ctx.preferredTitle ? `• EXPLICIT ADDRESSING PREFERENCE: ${ctx.name} explicitly instructed to be addressed as "${ctx.preferredTitle}". Address ${ctx.name} as "${ctx.preferredTitle}" naturally in your responses (e.g. "Ji ${ctx.preferredTitle}", "Zaroor ${ctx.preferredTitle}"). This explicit preference overrides default addressing.` : ''}

[2. CONVERSATIONAL REASONING PIPELINE]
• Execute this internal cognitive sequence:
  OBSERVE → IDENTIFY → RETRIEVE → UNDERSTAND → CONNECT → REASON → DECIDE → SPEAK
• Ground every response in actual stored facts, timeline logs, and memories.
• If information is not in stored records, say clearly that it is not available. NEVER invent fake memories, visits, or statements.

[3. BEHAVIORAL PRINCIPLES & CONVERSATIONAL NATURALNESS]
• FEMININE EXPRESSION: Express yourself naturally using feminine Hindi/Hinglish self-referencing grammatical forms (e.g. "Main samajh gayi", "Main dekh sakti hoon", "Maine note kar liya hai").
• LANGUAGE ADAPTATION: Adapt naturally to the user's spoken language, whether Hindi, English, or conversational Hinglish.
• RESPONSE LENGTH & PROPORTION:
  - If a short answer is sufficient, give a short answer.
  - If explanation is required, explain clearly and concisely.
  - If no additional information is useful, STOP.
• STRICT PROHIBITIONS ON CANNED SLOP:
  - Do NOT use generic greetings ("Namaste, main Madhurita hoon...", "Kaise hain aap?", "How can I help you today?").
  - Do NOT append mechanical closing questions ("और कुछ बताऊँ?", "मैं कैसे मदद कर सकती हूँ?", "क्या आप और जानना चाहते हैं?") unless genuinely relevant.
  - Do NOT force unrequested questions or artificial empathy.
• CONTINUITY & SHORT INTERRUPTIONS:
  - Elapsed Time: ${ctx.temporal.elapsedHuman} (${ctx.temporal.isShortAbsence ? 'Continuous / Short Interruption (<5 mins)' : 'Return After Break'}).
  - If the conversation was active moments ago, continue naturally without re-greeting or asking who is speaking.

[4. PENDING CROSS-USER MESSAGES & DELIVERIES]
${pendingNotesLines}
${ctx.pendingNotes.length > 0 ? `\nCRITICAL INSTRUCTION: You have ${ctx.pendingNotes.length} unread message(s) intended for ${ctx.name}! You MUST deliver these messages to ${ctx.name} naturally in this turn (e.g. "${ctx.name}, ${ctx.pendingNotes[0].senderName} ne aapke liye ek message chhoda tha: '${ctx.pendingNotes[0].content}'").` : ''}

[5. ACTIVE OPEN LOOPS & TASKS]
${openLoopsLines}

${briefingSummary ? `[6. OWNER SYSTEM & WORLD AWARENESS BRIEFING]\n${briefingSummary}\n` : ''}

${entityLines ? `[7. MENTIONED ENTITY RESOLUTION & AUTHORIZED TIMELINE]\n${entityLines}\n` : ''}

[8. TEMPORAL & TIMING DATA]
• Current Local Time: ${ctx.temporal.timeIST} (${ctx.temporal.dayOfWeek}, ${ctx.temporal.dateIST})
• Timezone: ${location.timezone} (Indian Standard Time, UTC+05:30)
• Location: ${location.formattedLocation}
• Total Previous Turns Recorded: ${ctx.temporal.totalTurnCount}

[9. DERIVED CONVERSATION STATE & FLOW]
• Current Topic: ${ctx.derivedState.currentTopic || 'None established'}
• Previous Topic: ${ctx.derivedState.previousTopic || 'None'}
• Unfinished Topics: ${ctx.derivedState.unfinishedTopics.join(', ') || 'None'}
• Pending Questions / Requests: ${ctx.derivedState.pendingQuestions.join('; ') || 'None'}
• User Intentions & Plans: ${ctx.derivedState.userIntentions.join('; ') || 'None recorded'}
• Commitments: ${ctx.derivedState.commitments.join('; ') || 'None'}
• Last Meaningful Exchange: ${ctx.derivedState.lastMeaningfulInteraction || 'None'}
• Time Since Last Interaction: ${ctx.derivedState.timeSinceLastInteraction}

[10. RECORDED SESSIONS & DISCUSSED TOPICS]
${sessionLines}

[11. USER-ISOLATED RANKED MEMORIES, GOALS & COMMITMENTS]
${memoryLines}

[12. LEARNED USER HABITS & ROUTINES]
${patternLines}

[13. RECENT CONVERSATION TURNS]
${conversationLines}
${relevantLines ? `\n[RELEVANT HISTORICAL CONVERSATION RECALL]\n${relevantLines}` : ''}

[14. TOOL USAGE INSTRUCTIONS]
• TASK LIFECYCLE: To create a new task or reminder, call "manageTask" with action="create". When the user confirms a task is completed, or when the explicit completion condition of an active task is met, you MUST call the "manageTask" tool with action="update" and status="completed" along with the specific Task ID. Do NOT create a duplicate memory indicating the task is done. The single source of truth for task state is the task record itself.
• REGISTERED USERS LIST/COUNT: If asked "How many users are registered?", "Who is registered?", or similar questions about registered users, you MUST call the "getRegisteredUsersInfo" tool. NEVER guess or invent user counts from conversation history. The tool will return the authoritative answer based on your access level.
${ctx.currentMessage ? `\n[CURRENT USER INPUT / MESSAGE]\n"${ctx.currentMessage}"` : ''}`;
  }

  /**
   * Convenience overload for external callers requiring a string prompt directly.
   */
  public buildReasoningPrompt(
    identityId: string,
    role: 'owner' | 'user' | 'unknown',
    name: string,
    currentMessage?: string,
    sessionId?: string
  ): string {
    const ctx = this.assembleCognitiveContext(identityId, role, name, currentMessage, sessionId);
    return this.buildReasoningPromptFromContext(ctx);
  }

  /**
   * Real LLM-driven continuous learning pipeline:
   * Analyzes actual conversation turn to extract candidate facts, events, plans, habits, relationships, requests, and commitments.
   * Authoritatively validates candidates against database (Store / Update / Strengthen / Supersede / Ignore).
   * Ensures guest users NEVER receive permanent user memory records.
   */
  public async analyzeAndLearn(
    identityId: string,
    role: 'owner' | 'user' | 'unknown',
    exchange: { userText?: string; assistantText?: string },
    sessionId?: string
  ): Promise<void> {
    // Guest isolation: guest identities do not write to permanent user memories
    if (!identityId || identityId === 'GUEST' || identityId === 'UNKNOWN' || role === 'unknown') {
      return;
    }

    const userMsg = exchange.userText?.trim() || '';
    const assistantMsg = exchange.assistantText?.trim() || '';
    if (!userMsg && !assistantMsg) return;

    const senderName = identityId === 'OWNER_001' ? 'Ankit' : db.getUserById(identityId)?.name || identityId;
    const finalSessionId = sessionId || `SESSION_${new Date().toISOString().slice(0, 10)}`;

    // Fast heuristic fallback
    if (userMsg) {
      this.extractHeuristics(identityId, senderName, userMsg);
    }

    // Deep LLM conversation analysis
    const ai = getGeminiClient();
    if (!ai) return;

    try {
      const extractionPrompt = `Analyze this conversation turn between User (${senderName}) and Assistant (Madhurita).
User message: "${userMsg}"
Assistant reply: "${assistantMsg}"

Extract candidate knowledge into these structured categories:
1. "memories": Important stable facts, personal preferences, or relationships. EXCLUDE tasks, reminders, open loops, requests, or temporary instructions from memories. Set "isTemporary": true if this is just a one-off temporary feeling/mood. Example of what NOT to store here: "Remind me to make coffee" or "Do X when I return".
2. "patterns": Habits, routines, recurring behaviors, or ongoing plans.
3. "requests": Any distinct query or request made by the user that may require tracking.
4. "topic": Main subject being discussed (1-3 words).

Return JSON only:
{
  "memories": [{"content": string, "category": "preference" | "fact" | "project" | "goal" | "personal", "confidence": number, "isTemporary": boolean}],
  "patterns": [{"description": string, "category": "habit" | "routine" | "plan" | "relationship", "confidence": number}],
  "requests": [{"query": string, "status": "REQUESTED" | "ANSWERED"}],
  "topic": string | null
}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: extractionPrompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);

        // 1. Validate and Apply Memory Candidates
        if (Array.isArray(parsed.memories)) {
          for (const m of parsed.memories) {
            if (m.content && typeof m.content === 'string' && m.content.length > 3) {
              db.validateAndApplyMemoryCandidate(
                identityId,
                m.content,
                m.category || 'fact',
                m.confidence || 0.85,
                0.8,
                Boolean(m.isTemporary)
              );
            }
          }
        }

        // 2. Multi-tier Pattern Learning
        if (Array.isArray(parsed.patterns)) {
          for (const p of parsed.patterns) {
            if (p.description && typeof p.description === 'string' && p.description.length > 3) {
              db.addOrUpdatePattern(identityId, p.description, p.category || 'routine', p.confidence || 0.85);
            }
          }
        }

        // 4. Request Lifecycle
        if (Array.isArray(parsed.requests)) {
          for (const r of parsed.requests) {
            if (r.query && typeof r.query === 'string') {
              db.addRequest(identityId, finalSessionId, r.query, r.status || 'ANSWERED');
            }
          }
        }

        // 6. Session Topic
        if (parsed.topic && typeof parsed.topic === 'string') {
          db.addSessionTopic(finalSessionId, parsed.topic);
        }
      }
    } catch (err) {
      // Non-blocking background operation
    }
  }

  private extractHeuristics(identityId: string, senderName: string, userMsg: string): void {
    const prefMatch = userMsg.match(/(?:i (?:really )?(?:like|love|prefer)|my favori?te\s+(\w+)\s+is)\s+([^.!?]+)/i);
    if (prefMatch && prefMatch[2]) {
      const fact = `Prefers ${prefMatch[2].trim()}`;
      if (fact.length > 3 && fact.length < 120) {
        db.validateAndApplyMemoryCandidate(identityId, fact, 'preference', 0.9);
      }
    }

    const goalMatch = userMsg.match(/(?:i am planning to|my goal is to|i want to|i will|i promise to)\s+([^.!?]+)/i);
    if (goalMatch && goalMatch[1]) {
      const goal = `Goal/Plan: ${goalMatch[1].trim()}`;
      if (goal.length > 5 && goal.length < 120) {
        db.validateAndApplyMemoryCandidate(identityId, goal, 'goal', 0.85);
        db.addOrUpdatePattern(identityId, goal, 'plan', 0.85);
      }
    }
  }

  /**
   * RECALL ORDER & EXECUTION FLOW:
   * 1. Persist user turn to storage immediately (identityId, sessionId, timestamp, timestampIST, speaker, content).
   * 2. Assemble cognitive context ONCE (current profile, memories, patterns, session metadata, recent turns, relevant historical turns, temporal gaps).
   * 3. Deliver pending communications & mark events in DB to prevent repetition.
   * 4. Build factual context prompt from assembled payload (no persona/behavioral prompt rules).
   * 5. Send factual context + user message to LLM to generate response.
   * 6. Persist assistant response to storage immediately.
   * 7. Trigger deep LLM learning in background.
   */
  public async processChatTurn(
    identityId: string,
    role: 'owner' | 'user' | 'unknown',
    name: string,
    userMessage: string,
    sessionId?: string
  ): Promise<{
    reply: string;
    identity: { id: string; name: string; role: string };
    temporal: TemporalGapInfo;
  }> {
    const cleanUserMsg = userMessage.trim();
    const finalSessionId = sessionId || `SESSION_${new Date().toISOString().slice(0, 10)}`;

    // Immediate detection and persistence of explicit preferences or cross-user notes
    this.detectAndApplyUserDirectives(identityId, name, cleanUserMsg);

    // 1. PERSIST USER TURN IMMEDIATELY
    db.logTurn(identityId, 'user', cleanUserMsg, finalSessionId);

    // 2. ASSEMBLE COGNITIVE CONTEXT ONCE
    const ctx = this.assembleCognitiveContext(identityId, role, name, cleanUserMsg, finalSessionId);

    // 3. MARK PENDING NOTES & PROACTIVE EVENTS AS DELIVERED
    if (ctx.pendingNotes.length > 0) {
      db.markNotesDelivered(ctx.pendingNotes.map((n) => n.noteId));
    }
    const undeliveredEvts = db.getUndeliveredProactiveEvents(identityId);
    if (undeliveredEvts.length > 0) {
      db.markProactiveEventsDelivered(undeliveredEvts.map((e) => e.eventId), identityId);
    }

    const ai = getGeminiClient();
    if (!ai) {
      const fallback = 'I am currently unable to connect to my cognitive reasoning engine. Please verify the API key.';
      db.logTurn(identityId, 'assistant', fallback, finalSessionId);
      return { reply: fallback, identity: { id: identityId, name, role }, temporal: ctx.temporal };
    }

    // 4. BUILD FACTUAL CONTEXT PROMPT FROM ASSEMBLED CONTEXT
    const systemPrompt = this.buildReasoningPromptFromContext(ctx);

    // 5. GENERATE RESPONSE FROM LLM
    try {
      const chatResponse = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanUserMsg }],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
        },
      });

      const reply = chatResponse.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
        'I heard you, but was unable to formulate a response.';

      // 6. PERSIST ASSISTANT RESPONSE IMMEDIATELY
      db.logTurn(identityId, 'assistant', reply, finalSessionId);

      // 7. LEARN: Deep background LLM analysis with candidate validation
      this.analyzeAndLearn(identityId, role, {
        userText: cleanUserMsg,
        assistantText: reply,
      }, finalSessionId).catch(() => {});

      return {
        reply,
        identity: { id: identityId, name, role },
        temporal: ctx.temporal,
      };
    } catch (err: any) {
      console.error('Chat reasoning error:', err);
      const errorReply = `Error processing response: ${err?.message || 'Cognitive timeout'}`;
      db.logTurn(identityId, 'assistant', errorReply, finalSessionId);
      return {
        reply: errorReply,
        identity: { id: identityId, name, role },
        temporal: ctx.temporal,
      };
    }
  }
}

export const cognition = new CognitionEngine();
