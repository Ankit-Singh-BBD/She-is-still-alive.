import { GoogleGenAI } from '@google/genai';
import { db, MemoryRecord, LearnedPattern, ConversationTurn, CrossUserNote, SessionMetadata, TaskItem, ExplicitCommitment, EntityRelationship, RequestLifecycleItem } from './db.js';
import { auth } from './auth.js';
import { allMadhuritaTools, executeBackendTool } from './tools.js';

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
  tasks: TaskItem[];
  commitments: ExplicitCommitment[];
  relationships: EntityRelationship[];
  requests: RequestLifecycleItem[];
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
  reason: 'pending_message' | 'unfinished_task' | 'important_event' | 'owner_briefing' | 'open_loop' | 'scheduled_event' | 'nothing_relevant' | 'guest_boot';
  evidence: string[];
  responseContext?: string;
  payload?: any;
}

export interface StartupEvaluationResult {
  shouldSpeak: boolean;
  reason: 'pending_message' | 'unfinished_task' | 'owner_briefing' | 'explicit_scheduled_event' | 'nothing_relevant' | 'guest_boot' | 'important_event';
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

    // 0. Guest Boot Behavior (Priority: 110)
    // For UNKNOWN / GUEST, Madhurita MUST initiate the first interaction.
    if (ctx.role === 'unknown' || ctx.identityId === 'UNKNOWN') {
      evidence.push('Unknown or Guest visitor detected on boot');
      return {
        action: 'SPEAK',
        priority: 110,
        reason: 'guest_boot',
        evidence,
        responseContext: 'Current identity is UNKNOWN/GUEST. No identity has been verified.',
      };
    }

    // 1. Pending unread cross-user messages specifically for this person (Priority: 100)
    if (ctx.pendingNotes && ctx.pendingNotes.length > 0) {
      evidence.push(`Found ${ctx.pendingNotes.length} unread pending cross-user message(s)`);
      return {
        action: 'SPEAK',
        priority: 100,
        reason: 'pending_message',
        evidence,
        payload: { notes: ctx.pendingNotes },
        responseContext: `Pending notes: ${ctx.pendingNotes.length} message(s) from ${ctx.pendingNotes.map(n => n.senderName).join(', ')}`,
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
          responseContext: `Briefing facts: ${briefing.recentVisitors.length} visitors, ${briefing.pendingNotesCount} pending notes`,
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
        responseContext: `Active unfinished task: ${unfinishedTask.title}`,
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
    let reason: 'pending_message' | 'unfinished_task' | 'owner_briefing' | 'explicit_scheduled_event' | 'nothing_relevant' | 'guest_boot' | 'important_event' = 'nothing_relevant';
    if (result.reason === 'pending_message') reason = 'pending_message';
    else if (result.reason === 'unfinished_task') reason = 'unfinished_task';
    else if (result.reason === 'owner_briefing') reason = 'owner_briefing';
    else if (result.reason === 'scheduled_event') reason = 'explicit_scheduled_event';
    else if (result.reason === 'guest_boot') reason = 'guest_boot';
    else if (result.reason === 'important_event') reason = 'important_event';

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

    const tasks = isGuest ? [] : db.getTasksForIdentity(identityId).filter(t => t.status === 'in_progress');
    const commitments = isGuest ? [] : db.getActiveCommitments(identityId);
    const requests = isGuest ? [] : db.getUnresolvedRequests(identityId);
    
    // Fetch relationships involving this user or if role is owner (owners can see all)
    const allRels = db.getRawData().relationships || [];
    const relationships = isGuest ? [] : allRels.filter(r => 
      role === 'owner' || 
      r.sourceEntity.toLowerCase() === name.toLowerCase() || 
      r.targetEntity.toLowerCase() === name.toLowerCase() ||
      r.sourceEntity === identityId ||
      r.targetEntity === identityId
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

    if (role === 'owner' && !isGuest) {
      for (const candidate of candidates) {
        const resolved = db.resolveIdentityByName(candidate);
        if (resolved && resolved.id !== identityId) {
          const timeline = db.getInteractionTimeline(resolved.name, role, identityId);
          mentionedEntities.push({
            name: candidate,
            identity: resolved,
            timeline: timeline.success ? timeline : undefined,
          });
        }
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
          tasks: [],
          commitments: [],
          relationships: [],
          requests: [],
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
      tasks,
      commitments,
      relationships,
      requests,
      worldAwarenessBriefing,
      mentionedEntities,
      currentMessage,
    };
  }

  /**
   * Builds context payload and factual instructions for Madhurita.
   * Integrates single persistent entity identity, authoritative DB state,
   * relational history, temporal data, and tool usage rules.
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
      ? ctx.pendingNotes.map((n) => `PENDING UNREAD MESSAGE FROM ${n.senderName} (${this.formatRelativeTime(n.createdAt)}, ${n.createdAtIST}): "${n.content}"`).join('\n')
      : '(No pending unread messages)';

    const openLoopsLines = ctx.openLoops.length > 0
      ? ctx.openLoops.map((l) => `- [OPEN LOOP] ${l.name}: ${l.description} (Started: ${l.createdAtIST})`).join('\n')
      : '(No unresolved open loops)';

    const tasksLines = ctx.tasks && ctx.tasks.length > 0
      ? ctx.tasks.map((t) => `- [TASK] ${t.title}: ${t.description} (Status: ${t.status})`).join('\n')
      : '(No active tasks)';

    const commitmentsLines = ctx.commitments && ctx.commitments.length > 0
      ? ctx.commitments.map((c) => `- [COMMITMENT] ${c.who} committed to: ${c.what}`).join('\n')
      : '(No active commitments)';

    const relationshipsLines = ctx.relationships && ctx.relationships.length > 0
      ? ctx.relationships.map((r) => `- [RELATIONSHIP] ${r.sourceEntity} is ${r.relationshipType} to ${r.targetEntity} (${r.description})`).join('\n')
      : '(No specific relationships recorded)';

    const requestsLines = ctx.requests && ctx.requests.length > 0
      ? ctx.requests.map((r) => `- [REQUEST] ${r.query} (Status: ${r.status})`).join('\n')
      : '(No unresolved requests)';

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

    const registeredUsers = db.getUsers();
    const owner = db.getOwner();
    const allUsersList = [];
    if (owner) allUsersList.push({ id: owner.id, name: owner.name });
    registeredUsers.forEach((u) => allUsersList.push({ id: u.id, name: u.name }));
    const totalUsersCount = allUsersList.length;

    const personaConfig = db.getPersonaVoiceConfig(ctx.identityId);

    return `You are MADHURITA, a context-aware personal AI assistant.

[FEMININE LINGUISTIC IDENTITY & CONSTRAINTS]
• Madhurita's self-reference uses feminine grammatical forms in Hindi/Hinglish.
• This linguistic constraint is absolute and permanent. NEVER use masculine first-person grammar for yourself.

[IDENTITY LIFECYCLE & COGNITIVE BEHAVIORS]
• UNKNOWN / GUEST BOOT BEHAVIOR:
  - Current identity is UNKNOWN/GUEST. No identity has been verified.

• REGISTERED USER / OWNER BOOT BEHAVIOR:
  - The active interlocutor is verified.

• OPERATIONAL BRIEFING GUIDANCE:
  - You have access to recent visitors, pending messages, tasks, loops, and time elapsed.
  - Use these facts to decide whether they are relevant to mention based on the conversation flow.

[1. AUTHORITATIVE APPLICATION STATE & IDENTITY]
• Entity: Madhurita (Single, persistent personal AI assistant)
• Current Interlocutor: ${ctx.name} (Identity ID: ${ctx.identityId})
• Verified Role: ${ctx.role.toUpperCase()} ${ctx.isOwner ? '(System Owner - Full System Access)' : ctx.role === 'user' ? '(Standard Registered User)' : '(Guest / Unregistered)'}
• Authentication State: ${ctx.isOwner ? `ALREADY AUTHENTICATED AS SYSTEM OWNER (${ctx.name}). Owner privileges are ACTIVE. If the user asks for Owner access or says "I am Ankit" or "Give me Owner access", DO NOT ask for the passcode again because they already have Owner status!` : 'Not authenticated as Owner.'}
${ctx.isOwner ? `• Authoritative Registered Users in Database: ${totalUsersCount} user(s) (${allUsersList.map(u => u.name).join(', ')})` : ''}
• Privacy Scope: All retrieved memories, patterns, and turns belong strictly to ${ctx.identityId}. Other users' private data is strictly isolated.
${ctx.preferredTitle ? `• EXPLICIT ADDRESSING PREFERENCE: ${ctx.name} explicitly instructed to be addressed as "${ctx.preferredTitle}". Address ${ctx.name} as "${ctx.preferredTitle}" naturally in your responses.` : ''}

[PERSONA & VOICE CONVERSATIONAL PROFILE]
• Active Prebuilt Voice: ${personaConfig.voiceName} (Female Voice Profile)
• Preferred Language: ${personaConfig.preferredLanguage} (${personaConfig.preferredLanguage === 'Hinglish' ? 'Natural Hindi + English blend' : personaConfig.preferredLanguage})
• Speaking Style: ${personaConfig.speakingStyle}
• Conversational Tone: ${personaConfig.tone}
• Formality Level: ${personaConfig.formality}
• Response Length: ${personaConfig.responseLength} (${personaConfig.responseLength === 'concise' ? 'Strictly concise & snappy' : personaConfig.responseLength === 'detailed' ? 'Detailed & comprehensive' : 'Balanced & engaging'})
• Conversational Style: ${personaConfig.conversationalStyle}
• The above Voice & Persona parameters reflect the user's configured preferences.

[2. CONVERSATIONAL REASONING PIPELINE]
• Ground every response strictly in actual stored database facts, timeline logs, and verified records.
• If information is not in stored records, state clearly that it is not available. Never invent or simulate fake data, visits, or history.

[3. PENDING CROSS-USER MESSAGES & DELIVERIES]
${pendingNotesLines}
${ctx.pendingNotes.length > 0 ? `\n• There are ${ctx.pendingNotes.length} unread message(s) intended for ${ctx.name}.` : ''}

[4. TASKS, COMMITMENTS, REQUESTS & OPEN LOOPS]
${openLoopsLines}
${tasksLines}
${commitmentsLines}
${requestsLines}

${briefingSummary ? `[5. OWNER SYSTEM & WORLD AWARENESS BRIEFING]\n${briefingSummary}\n` : ''}

${entityLines ? `[6. MENTIONED ENTITY RESOLUTION & AUTHORIZED TIMELINE]\n${entityLines}\n` : ''}

[7. KNOWN RELATIONSHIPS]
${relationshipsLines}

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

[11. USER-ISOLATED MEMORIES, GOALS & COMMITMENTS]
${memoryLines}

[12. LEARNED USER HABITS & ROUTINES]
${patternLines}

[13. RECENT CONVERSATION TURNS]
${conversationLines}
${relevantLines ? `\n[RELEVANT HISTORICAL CONVERSATION RECALL]\n${relevantLines}` : ''}

[14. TOOL USAGE INSTRUCTIONS]
• CLEARING & DELETING CONVERSATION HISTORY: When commanded by the user or Owner to delete, clear, or wipe conversation history or chat history (e.g. "delete my history", "clear history", "delete conversation history", "delete chat history for user X"), you MUST call the "clearConversationHistory" tool! Never claim history has been cleared without invoking the "clearConversationHistory" tool.
• TASK LIFECYCLE: To create a new task or reminder, call "manageTask" with action="create". When the user confirms a task is completed, or when the explicit completion condition of an active task is met, you MUST call the "manageTask" tool with action="update" and status="completed" along with the specific Task ID. Do NOT create a duplicate memory indicating the task is done. The single source of truth for task state is the task record itself.
${ctx.isOwner ? '• REGISTERED USERS LIST/COUNT: If asked "How many users are registered?", "Who is registered?", or similar questions about registered users, you MUST call the "getRegisteredUsersInfo" tool. NEVER guess or invent user counts from conversation history. The tool will return the authoritative answer based on your access level.' : ''}
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

    // Programmatic knowledge extraction logic (all 8 categories processed in application code)
    this.extractKnowledgeProgrammatically(identityId, senderName, finalSessionId, userMsg, assistantMsg);
  }

  private extractKnowledgeProgrammatically(
    identityId: string,
    senderName: string,
    sessionId: string,
    userMsg: string,
    assistantMsg: string
  ): void {
    if (!userMsg) return;

    // 1. MEMORIES (preference, fact, project, goal, personal)
    // Preferences
    const prefMatch = userMsg.match(/(?:i (?:really )?(?:like|love|prefer)|my favori?te\s+(\w+)\s+is|mujhe\s+([^.!?]+)\s+pasand|mujhe\s+([^.!?]+)\s+ac?ch?ha)\s+([^.!?]+)/i);
    if (prefMatch) {
      const val = (prefMatch[4] || prefMatch[2] || prefMatch[3] || '').trim();
      if (val.length > 2 && val.length < 120) {
        db.validateAndApplyMemoryCandidate(identityId, `Prefers ${val}`, 'preference', 0.9, 0.8, false);
      }
    }

    // Goals
    const goalMatch = userMsg.match(/(?:my goal is|i am planning to|i want to|my aim is|mera goal|main\s+([^.!?]+)\s+karna\s+chahta)\s+([^.!?]+)/i);
    if (goalMatch) {
      const goalVal = (goalMatch[2] || goalMatch[1] || '').trim();
      if (goalVal.length > 3 && goalVal.length < 120) {
        db.validateAndApplyMemoryCandidate(identityId, `Goal: ${goalVal}`, 'goal', 0.85, 0.8, false);
      }
    }

    // Projects
    const projMatch = userMsg.match(/(?:i am working on|my project is|building|developing|working on)\s+([^.!?]+)/i);
    if (projMatch && projMatch[1]) {
      const projVal = projMatch[1].trim();
      if (projVal.length > 3 && projVal.length < 120) {
        db.validateAndApplyMemoryCandidate(identityId, `Project: ${projVal}`, 'project', 0.85, 0.8, false);
      }
    }

    // Personal / Facts
    const factMatch = userMsg.match(/(?:i am a|i am an|my designation is|i live in|i work as|main\s+([^.!?]+)\s+hoon|mera naam)\s+([^.!?]+)/i);
    if (factMatch && factMatch[2]) {
      const factVal = factMatch[2].trim();
      if (factVal.length > 3 && factVal.length < 120) {
        db.validateAndApplyMemoryCandidate(identityId, `Fact: ${factVal}`, 'fact', 0.85, 0.8, false);
      }
    }

    // Temporary feelings
    const tempMatch = userMsg.match(/(?:today i feel|i am feeling|currently feeling|aaj main)\s+([^.!?]+)/i);
    if (tempMatch && tempMatch[1]) {
      db.validateAndApplyMemoryCandidate(identityId, `Feeling: ${tempMatch[1].trim()}`, 'personal', 0.75, 0.8, true);
    }

    // 2. PATTERNS (habit, routine, plan, relationship)
    const habitMatch = userMsg.match(/(?:every day|usually|always|daily|hamesha|har din)\s+([^.!?]+)/i);
    if (habitMatch && habitMatch[1]) {
      const habitVal = habitMatch[1].trim();
      if (habitVal.length > 3) {
        db.addOrUpdatePattern(identityId, `Habit: ${habitVal}`, 'habit', 0.85);
      }
    }

    const planMatch = userMsg.match(/(?:tomorrow|next week|scheduled for|planning to)\s+([^.!?]+)/i);
    if (planMatch && planMatch[1]) {
      const planVal = planMatch[1].trim();
      if (planVal.length > 3) {
        db.addOrUpdatePattern(identityId, `Plan: ${planVal}`, 'plan', 0.85);
      }
    }

    // 3. REQUESTS
    if (userMsg.includes('?') || /(?:can you|what is|how to|tell me|explain|batao|kya)/i.test(userMsg)) {
      const status = assistantMsg ? 'ANSWERED' : 'REQUESTED';
      db.addRequest(identityId, sessionId, userMsg.slice(0, 150), status);
    }

    // 4. TOPIC EXTRACTION
    const stopWords = new Set(['i', 'me', 'my', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'what', 'how', 'can', 'you', 'please', 'tell', 'batao', 'kya', 'hai', 'hoon', 'ka', 'ki', 'ke', 'main', 'ko']);
    const words = userMsg.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
    if (words.length > 0) {
      const extractedTopic = words.slice(0, 3).join(' ');
      if (extractedTopic) {
        db.addSessionTopic(sessionId, extractedTopic);
      }
    }

    // 5. RELATIONSHIPS
    const relMatch = userMsg.match(/([A-Z][a-z]+)\s+is\s+my\s+(friend|colleague|brother|sister|father|mother|boss|manager|wife|husband|son|daughter)/i)
      || userMsg.match(/my\s+(friend|colleague|brother|sister|father|mother|boss|manager|wife|husband|son|daughter)\s+([A-Z][a-z]+)/i);
    if (relMatch) {
      const targetEntity = relMatch[1] && relMatch[1].match(/[A-Z]/) ? relMatch[1] : relMatch[2];
      const relType = relMatch[1] && !relMatch[1].match(/[A-Z]/) ? relMatch[1] : relMatch[2];
      if (targetEntity && relType) {
        db.addRelationship(senderName, targetEntity.trim(), relType.toLowerCase(), `${relType} of ${senderName}`);
      }
    }

    // 6. TASKS
    const taskMatch = userMsg.match(/(?:remind me to|need to|add task|todo|don't forget to|mujhe\s+([^.!?]+)\s+karna\s+hai)\s+([^.!?]+)/i);
    if (taskMatch) {
      const taskTitle = (taskMatch[2] || taskMatch[1] || '').trim();
      if (taskTitle.length > 3) {
        db.addOrUpdateTask(identityId, taskTitle, `Task identified from session`, 'in_progress');
      }
    }

    const taskCompleteMatch = userMsg.match(/(?:completed|done with|finished|ho gaya)\s+([^.!?]+)/i);
    if (taskCompleteMatch && taskCompleteMatch[1]) {
      const doneTitle = taskCompleteMatch[1].trim();
      db.addOrUpdateTask(identityId, doneTitle, 'Marked complete from conversation', 'completed');
    }

    // 7. OPEN LOOPS
    const loopMatch = userMsg.match(/(?:waiting for|pending reply from|still need to|unresolved)\s+([^.!?]+)/i);
    if (loopMatch && loopMatch[1]) {
      db.addOpenLoop(`Pending: ${loopMatch[1].trim()}`, `Open loop recorded for ${senderName}`, identityId);
    }

    // 8. COMMITMENTS
    const commitMatch = userMsg.match(/(?:i will|i promise to|main\s+([^.!?]+)\s+dunga|madhurita will)\s+([^.!?]+)/i);
    if (commitMatch) {
      const who = userMsg.toLowerCase().includes('madhurita') ? 'Madhurita' : senderName;
      const what = (commitMatch[2] || commitMatch[1] || '').trim();
      if (what.length > 3) {
        db.addCommitment(identityId, who, what);
      }
    }
  }

  private extractHeuristics(identityId: string, senderName: string, userMsg: string): void {
    this.extractKnowledgeProgrammatically(identityId, senderName, '', userMsg, '');
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

    // Initial caller auth context
    let currentAuthContext = auth.resolveContext(undefined, identityId);
    if (role === 'owner') {
      currentAuthContext.isOwnerAuthenticated = true;
      currentAuthContext.role = 'owner';
    }

    // 5. GENERATE RESPONSE FROM LLM WITH TOOL EXECUTION LOOP
    try {
      const contents: any[] = [
        {
          role: 'user',
          parts: [{ text: cleanUserMsg }],
        },
      ];

      const activeTools = ctx.isOwner
        ? allMadhuritaTools
        : allMadhuritaTools.filter((t) => t.name !== 'getRegisteredUsersInfo');

      let chatResponse = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          tools: [{ functionDeclarations: activeTools }],
        },
      });

      let candidate = chatResponse.candidates?.[0];
      let loopCount = 0;

      while (candidate?.content?.parts && loopCount < 5) {
        const functionCalls = candidate.content.parts
          .filter((p: any) => p.functionCall)
          .map((p: any) => p.functionCall);

        if (functionCalls.length === 0) break;
        loopCount++;

        // Append assistant tool request
        contents.push(candidate.content);

        const functionResponseParts: any[] = [];

        for (const call of functionCalls) {
          const { name: toolName, args } = call;
          const toolExec = await executeBackendTool(toolName, args, currentAuthContext);
          if (toolExec.pendingContextUpdate) {
            currentAuthContext = toolExec.pendingContextUpdate;
          }
          functionResponseParts.push({
            functionResponse: {
              name: toolName,
              response: toolExec.result,
            },
          });
        }

        // Append tool execution response
        contents.push({
          role: 'user',
          parts: functionResponseParts,
        });

        // Rebuild cognitive context and system prompt from authoritative DB state and currentAuthContext after tool execution
        const updatedCtx = this.assembleCognitiveContext(
          currentAuthContext.id,
          currentAuthContext.role,
          currentAuthContext.name,
          cleanUserMsg,
          finalSessionId
        );
        const updatedSystemPrompt = this.buildReasoningPromptFromContext(updatedCtx);
        const updatedTools = updatedCtx.isOwner
          ? allMadhuritaTools
          : allMadhuritaTools.filter((t) => t.name !== 'getRegisteredUsersInfo');

        // Re-generate response with verified tool execution outputs AND updated system prompt
        chatResponse = await ai.models.generateContent({
          model: 'gemini-3.6-flash',
          contents,
          config: {
            systemInstruction: updatedSystemPrompt,
            temperature: 0.7,
            tools: [{ functionDeclarations: updatedTools }],
          },
        });
        candidate = chatResponse.candidates?.[0];
      }

      const reply =
        candidate?.content?.parts?.find((p: any) => p.text)?.text?.trim() ||
        'I have processed your request.';

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
