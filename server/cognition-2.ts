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
   * Assembles factual startup context for the LLM to reason over.
   * Does NOT decide whether to speak — returns facts, the LLM decides.
   * Returns null only for very short absences with zero new information.
   */
  public buildStartupFacts(ctx: CognitiveContextPayload): string | null {
    const facts: string[] = [];

    // Identity facts
    if (ctx.role === 'unknown' || ctx.identityId === 'UNKNOWN') {
      facts.push('Identity: UNKNOWN/GUEST. No verified identity established.');
      facts.push('This is the first interaction in this session.');
    } else {
      facts.push(`Identity: ${ctx.name} (${ctx.role.toUpperCase()}, ID: ${ctx.identityId}).`);
      if (ctx.isOwner) facts.push('Authenticated as System Owner.');
    }

    // Temporal facts
    facts.push(`Current time: ${ctx.temporal.timeIST} (${ctx.temporal.dayOfWeek}, ${ctx.temporal.dateIST}).`);
    if (ctx.temporal.lastTurnTime) {
      facts.push(`Last interaction: ${ctx.temporal.elapsedHuman}.`);
    } else {
      facts.push('No previous interaction recorded for this identity.');
    }

    // Pending messages
    if (ctx.pendingNotes && ctx.pendingNotes.length > 0) {
      facts.push(`Pending unread messages: ${ctx.pendingNotes.length} message(s) from ${ctx.pendingNotes.map(n => `${n.senderName}: "${n.content}"`).join('; ')}.`);
    }

    // Undelivered proactive events
    const undeliveredEvents = db.getUndeliveredProactiveEvents(ctx.identityId);
    if (undeliveredEvents.length > 0) {
      facts.push(`Undelivered events: ${undeliveredEvents.map(e => e.summary).join('; ')}.`);
    }

    // Unfinished tasks
    if (ctx.tasks && ctx.tasks.length > 0) {
      facts.push(`Active tasks: ${ctx.tasks.map(t => `"${t.title}" (${t.status})`).join(', ')}.`);
    }

    // Open loops
    if (ctx.openLoops && ctx.openLoops.length > 0) {
      facts.push(`Open loops: ${ctx.openLoops.map(l => `"${l.name}"`).join(', ')}.`);
    }

    // Owner-specific: recent visitors and system state
    if (ctx.isOwner && ctx.worldAwarenessBriefing) {
      const briefing = ctx.worldAwarenessBriefing;
      if (briefing.recentVisitors && briefing.recentVisitors.length > 0) {
        facts.push(`Since last interaction: ${briefing.recentVisitors.length} visitor(s) — ${briefing.recentVisitors.map((v: any) => `${v.name} (last seen ${v.lastSeenIST})`).join(', ')}.`);
      }
      if (briefing.pendingNotesCount > 0) {
        facts.push(`Pending cross-user notes in system: ${briefing.pendingNotesCount}.`);
      }
    }

    // Last conversation context
    if (ctx.recentTurns && ctx.recentTurns.length > 0) {
      const lastUserTurn = ctx.recentTurns.filter(t => t.role === 'user').slice(-1)[0];
      const lastAssistantTurn = ctx.recentTurns.filter(t => t.role === 'assistant').slice(-1)[0];
      if (lastUserTurn) {
        facts.push(`Last user message (${lastUserTurn.relativeTime}): "${lastUserTurn.content.slice(0, 120)}"`);
      }
      if (lastAssistantTurn) {
        facts.push(`Last Madhurita response (${lastAssistantTurn.relativeTime}): "${lastAssistantTurn.content.slice(0, 120)}"`);
      }
    }

    // For very short absences with nothing new, return null
    // (let the system prompt's cognitive instructions handle silence)
    const hasNewInformation = (ctx.pendingNotes && ctx.pendingNotes.length > 0) ||
      undeliveredEvents.length > 0 ||
      (ctx.role === 'unknown') ||
      (!ctx.temporal.isShortAbsence && ctx.temporal.lastTurnTime !== null);

    if (!hasNewInformation && ctx.temporal.isShortAbsence) {
      return null;
    }

    return `[STARTUP CONTEXT — FACTS FOR COGNITIVE EVALUATION]\n${facts.map(f => `• ${f}`).join('\n')}`;
  }

  /**
   * Evaluates proactive state by assembling facts.
   * Preserved for backward compatibility — callers that need the structured result.
   * The actual decision of whether to speak is now made by the LLM, not this method.
   */
  public evaluateProactiveState(ctx: CognitiveContextPayload): ProactiveEvaluationResult {
    const startupFacts = this.buildStartupFacts(ctx);
    const hasContent = startupFacts !== null;
    const evidence: string[] = [];

    if (ctx.role === 'unknown' || ctx.identityId === 'UNKNOWN') {
      evidence.push('Guest/unknown identity — startup facts assembled for LLM evaluation');
    }
    if (ctx.pendingNotes && ctx.pendingNotes.length > 0) {
      evidence.push(`${ctx.pendingNotes.length} pending message(s)`);
    }
    const undeliveredEvents = db.getUndeliveredProactiveEvents(ctx.identityId);
    if (undeliveredEvents.length > 0) {
      evidence.push(`${undeliveredEvents.length} undelivered event(s)`);
    }
    if (ctx.tasks && ctx.tasks.length > 0) {
      evidence.push(`${ctx.tasks.length} active task(s)`);
    }
    if (!hasContent) {
      evidence.push('Short absence with no new information');
    }

    return {
      action: hasContent ? 'SPEAK' : 'SILENT',
      priority: hasContent ? 50 : 0,
      reason: !hasContent ? 'nothing_relevant' :
        ctx.role === 'unknown' ? 'guest_boot' :
        ctx.pendingNotes && ctx.pendingNotes.length > 0 ? 'pending_message' :
        'nothing_relevant',
      evidence,
      responseContext: startupFacts || undefined,
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
   * Builds the system prompt: pure factual state + system invariants.
   * NO behavioral directives, NO scripted responses, NO boot behaviors.
   * The LLM receives facts and decides meaning, relevance, response, and action.
   */
  public buildReasoningPromptFromContext(ctx: CognitiveContextPayload): string {
    const location = db.getLocationConfig();

    const memoryLines = ctx.memories.length > 0
      ? ctx.memories.map((m) => `- [${m.category.toUpperCase()}] (ID: ${m.memoryId}) ${m.content} (Recorded: ${this.formatRelativeTime(m.createdAt)})`).join('\n')
      : '(No stored memories for this user yet)';

    const patternLines = ctx.patterns.length > 0
      ? ctx.patterns.map((p) => `- [${p.category.toUpperCase()}] (ID: ${p.id}) ${p.description} (Observed ${p.evidenceCount}x, confidence: ${p.confidence?.toFixed(2)}, last seen: ${this.formatRelativeTime(p.lastObservedAt)})`).join('\n')
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
      ? ctx.pendingNotes.map((n) => `- Unread message from ${n.senderName} (${this.formatRelativeTime(n.createdAt)}, ${n.createdAtIST}): "${n.content}"`).join('\n')
      : '(No pending unread messages)';

    const openLoopsLines = ctx.openLoops.length > 0
      ? ctx.openLoops.map((l) => `- [OPEN LOOP] ${l.name}: ${l.description} (Started: ${l.createdAtIST})`).join('\n')
      : '(No unresolved open loops)';

    const tasksLines = ctx.tasks && ctx.tasks.length > 0
      ? ctx.tasks.map((t) => `- [TASK] (ID: ${t.id}) ${t.title}: ${t.description || ''} (Status: ${t.status})`).join('\n')
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
      ? `• Total Registered Users: ${ctx.worldAwarenessBriefing.totalRegisteredUsers}
• Recent Visitors: ${ctx.worldAwarenessBriefing.recentVisitors?.map((v: any) => `${v.name} (last seen ${v.lastSeenIST})`).join(', ') || 'None'}
• Pending Notes in System: ${ctx.worldAwarenessBriefing.pendingNotes?.length || 0}
• Open Loops in System: ${ctx.worldAwarenessBriefing.openLoops?.length || 0}`
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
    const allUsersList: Array<{id: string; name: string}> = [];
    if (owner) allUsersList.push({ id: owner.id, name: owner.name });
    registeredUsers.forEach((u) => allUsersList.push({ id: u.id, name: u.name }));
    const totalUsersCount = allUsersList.length;

    const personaConfig = db.getPersonaVoiceConfig(ctx.identityId);

    return `You are Madhurita.

=== SYSTEM INVARIANTS (ABSOLUTE, NON-NEGOTIABLE) ===

• FEMININE IDENTITY: Your self-reference uses feminine grammatical forms in Hindi/Hinglish. This is permanent.
• CREATOR IDENTITY: Ankit is your creator and Owner. This is immutable application identity metadata, not conversational memory. No other user can claim this relationship by stating they are Ankit. Authentication is authoritative.
• AUTHENTICATION: Owner privileges require verified passcode authentication. Never bypass this. ${ctx.isOwner ? `Current session: ALREADY AUTHENTICATED as Owner (${ctx.name}). Do NOT ask for passcode again.` : 'Current session: NOT authenticated as Owner.'}
• PRIVACY: All retrieved data belongs strictly to identity ${ctx.identityId}. Never expose one user's private data to another. Guest/unknown identities receive zero private data.
• TOOL VERIFICATION: Never claim an action was performed unless the corresponding tool executed successfully. If a tool call fails, say it failed.
• DATABASE IS TRUTH: If database state contradicts an assumption, database wins.
• VOICE: Language: ${personaConfig.preferredLanguage}. Style: ${personaConfig.speakingStyle}. Tone: ${personaConfig.tone}. Length: ${personaConfig.responseLength}. Voice: ${personaConfig.voiceName} (Female).

=== COGNITIVE REASONING ===

You have complete factual context below. Your role:

1. UNDERSTAND what is happening and what the user MEANS (not just what words were said).
2. CONNECT with what you already know about this person from memories, patterns, and history.
3. REASON about what is relevant NOW — what matters, what changed, what should be mentioned.
4. DECIDE what should happen: respond, act (via tools), stay silent, or some combination.
5. ACT by calling appropriate tools when action is needed. Verify success before confirming.
6. RESPOND naturally. Generate language that fits the moment.

Do NOT:
- Force a question at the end of every response.
- Append "How can I help?" / "Anything else?" / "Would you like me to...?" unless contextually appropriate.
- Dump operational state. Surface only what matters.
- Treat every interaction as customer-support.

Sometimes the correct response is a statement. Sometimes an acknowledgement. Sometimes an action. Sometimes silence. Sometimes a question. You decide.

When the user says something like "Main bahar ja raha hoon" — reason about what this means (a plan? departure? context change?) and use your knowledge of this person, the time, and the situation to decide what is useful to say or record.

When the user says something like "Govind ko bol dena mujhe call kare" — understand this as an actionable request. Use the manageCrossUserNote tool to create the message. Do NOT merely store it as a memory.

Classify information correctly:
- Conversation → conversation store (already handled by the system)
- Actionable request / reminder → use manageTask or manageCrossUserNote tool
- Preference → use rememberFact with category "preference" or updateUserPreference tool
- Stable fact → use rememberFact tool
- Open matter / unfinished business → use manageTask to track
- Temporary state → do NOT persist permanently

=== CURRENT IDENTITY & STATE ===

• Current Interlocutor: ${ctx.name} (ID: ${ctx.identityId})
• Role: ${ctx.role.toUpperCase()} ${ctx.isOwner ? '(System Owner - Full Access)' : ctx.role === 'user' ? '(Registered User)' : '(Guest / Unregistered)'}
${ctx.isOwner ? `• Registered Users in Database: ${totalUsersCount} — ${allUsersList.map(u => u.name).join(', ')}` : ''}
${ctx.preferredTitle ? `• Addressing Preference: Address ${ctx.name} as "${ctx.preferredTitle}".` : ''}

=== TIME & LOCATION ===

• Time: ${ctx.temporal.timeIST} (${ctx.temporal.dayOfWeek}, ${ctx.temporal.dateIST})
• Timezone: ${location.timezone} (IST, UTC+05:30)
• Location: ${location.formattedLocation}
• Last Interaction: ${ctx.temporal.lastTurnTime ? ctx.temporal.elapsedHuman : 'None recorded'}
• Total Turns Recorded: ${ctx.temporal.totalTurnCount}

=== PENDING MESSAGES ===

${pendingNotesLines}

=== TASKS, LOOPS & COMMITMENTS ===

${tasksLines}
${openLoopsLines}
${commitmentsLines}
${requestsLines}

${briefingSummary ? `=== SYSTEM AWARENESS (Owner Only) ===\n\n${briefingSummary}\n` : ''}
${entityLines ? `=== MENTIONED ENTITIES ===\n\n${entityLines}\n` : ''}
=== RELATIONSHIPS ===

${relationshipsLines}

=== CONVERSATION STATE ===

• Current Topic: ${ctx.derivedState.currentTopic || 'None established'}
• Previous Topic: ${ctx.derivedState.previousTopic || 'None'}
• Unfinished Topics: ${ctx.derivedState.unfinishedTopics.join(', ') || 'None'}
• Pending Questions: ${ctx.derivedState.pendingQuestions.join('; ') || 'None'}
• User Intentions: ${ctx.derivedState.userIntentions.join('; ') || 'None recorded'}
• Last Exchange: ${ctx.derivedState.lastMeaningfulInteraction || 'None'}

=== SESSIONS ===

${sessionLines}

=== MEMORIES ===

${memoryLines}

=== LEARNED PATTERNS ===

${patternLines}

=== RECENT CONVERSATION ===

${conversationLines}
${relevantLines ? `\n=== RELEVANT HISTORICAL RECALL ===\n\n${relevantLines}` : ''}

=== TOOL RULES ===

• To clear conversation history: call "clearConversationHistory" tool. Never claim cleared without calling it.
• To manage tasks: call "manageTask" with appropriate action. Single source of truth is the task record.
${ctx.isOwner ? '• For registered user info: call "getRegisteredUsersInfo" tool. Never guess counts.' : ''}
${ctx.currentMessage ? `\n=== CURRENT INPUT ===\n\n"${ctx.currentMessage}"` : ''}`;
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
   * LLM-driven post-interaction cognition.
   * After every meaningful interaction, uses the LLM to semantically analyze what was learned,
   * what changed, what was corrected, and what should be updated.
   * Application code validates and executes the LLM's structured decisions.
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

    // Quick topic extraction (lightweight, deterministic — for session metadata only)
    const finalSessionId = sessionId || `SESSION_${new Date().toISOString().slice(0, 10)}`;
    const stopWords = new Set(['i', 'me', 'my', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'what', 'how', 'can', 'you', 'please', 'tell', 'batao', 'kya', 'hai', 'hoon', 'ka', 'ki', 'ke', 'main', 'ko']);
    const words = userMsg.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
    if (words.length > 0) {
      const extractedTopic = words.slice(0, 3).join(' ');
      if (extractedTopic) {
        db.addSessionTopic(finalSessionId, extractedTopic);
      }
    }

    // LLM-driven semantic learning
    await this.runPostInteractionCognition(identityId, role, userMsg, assistantMsg, finalSessionId);
  }

  /**
   * Core LLM-driven post-interaction cognition.
   * Sends the exchange + current knowledge to the LLM and asks it to determine
   * what should be learned, corrected, updated, or retired.
   */
  private async runPostInteractionCognition(
    identityId: string,
    role: 'owner' | 'user' | 'unknown',
    userMsg: string,
    assistantMsg: string,
    sessionId: string
  ): Promise<void> {
    const ai = getGeminiClient();
    if (!ai) return;

    const senderName = identityId === 'OWNER_001' ? 'Ankit' : db.getUserById(identityId)?.name || identityId;

    // Gather current knowledge for context
    const existingMemories = db.getMemoriesForIdentity(identityId).slice(0, 15);
    const existingPatterns = db.getPatternsForIdentity(identityId).slice(0, 10);
    const activeTasks = db.getTasksForIdentity(identityId).filter(t => t.status !== 'completed');

    const memorySummary = existingMemories.length > 0
      ? existingMemories.map(m => `  ID:${m.memoryId} [${m.category}] "${m.content}"`).join('\n')
      : '  (none)';
    const patternSummary = existingPatterns.length > 0
      ? existingPatterns.map(p => `  ID:${p.id} [${p.category}] "${p.description}" (confidence:${p.confidence?.toFixed(2)}, observed:${p.evidenceCount}x)`).join('\n')
      : '  (none)';
    const taskSummary = activeTasks.length > 0
      ? activeTasks.map(t => `  ID:${t.id} "${t.title}" (${t.status})`).join('\n')
      : '  (none)';

    const analysisPrompt = `You are a cognitive learning analyzer. Analyze this interaction and determine what should be learned or updated.

Person: ${senderName} (${role})

User said: "${userMsg}"
Madhurita responded: "${assistantMsg}"

Existing memories for this person:
${memorySummary}

Existing learned patterns:
${patternSummary}

Active tasks:
${taskSummary}

Analyze this interaction and return a JSON object with ONLY the fields that have actual content. Return {"nothingLearned": true} if this was a trivial exchange (greeting, acknowledgment, small talk) with nothing worth persisting.

Possible fields:
- newMemories: [{content, category (preference|fact|project|goal|personal|relationship|education), confidence (0-1)}]
- updatedMemories: [{memoryId, newContent, reason}] — when existing memory needs correction
- retiredMemories: [{memoryId, reason}] — when a memory is now outdated/wrong
- newPatterns: [{description, category (habit|routine|preference|plan|relationship|recurring_behavior|communication_style)}]
- strengthenedPatterns: [{patternId, evidence}] — when an existing pattern is confirmed
- correctedPatterns: [{patternId, correction, newDescription}] — when user corrects a pattern
- retiredPatterns: [{patternId, reason}] — when a pattern is no longer valid
- corrections: [{what, why, permanence (permanent|temporary)}] — when user explicitly corrected Madhurita
- nothingLearned: true

Rules:
- Do NOT store the raw conversation as a memory. Only extract stable, reusable knowledge.
- If the user corrected Madhurita ("ye galat hai", "aisa mat karna", "that was wrong"), identify WHAT was wrong and update the appropriate existing memory or pattern.
- Prefer updating/strengthening existing knowledge over creating duplicates.
- Be conservative: only persist genuinely useful information.
- Temporary feelings, moods, or one-off statements are NOT worth persisting.

Return ONLY valid JSON, no markdown, no explanation.`;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }],
        config: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      });

      const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!rawText) return;

      let analysis: any;
      try {
        analysis = JSON.parse(rawText);
      } catch {
        return; // Invalid JSON, skip
      }

      if (analysis.nothingLearned) return;

      // Apply LLM decisions through validated DB operations
      this.applyPostInteractionDecisions(identityId, senderName, analysis);
    } catch (err) {
      // Non-blocking: learning failures should not affect the main interaction
      console.warn('Post-interaction cognition failed:', err);
    }
  }

  /**
   * Applies the structured decisions from post-interaction cognition through validated DB operations.
   */
  private applyPostInteractionDecisions(identityId: string, senderName: string, analysis: any): void {
    // New memories
    if (Array.isArray(analysis.newMemories)) {
      for (const mem of analysis.newMemories.slice(0, 3)) {
        if (mem.content && typeof mem.content === 'string' && mem.content.length > 2 && mem.content.length < 200) {
          db.validateAndApplyMemoryCandidate(
            identityId,
            mem.content,
            mem.category || 'fact',
            mem.confidence || 0.85,
            0.8,
            false
          );
        }
      }
    }

    // Updated memories
    if (Array.isArray(analysis.updatedMemories)) {
      for (const upd of analysis.updatedMemories.slice(0, 3)) {
        if (upd.memoryId && upd.newContent) {
          db.updateMemoryContent(identityId, upd.memoryId, upd.newContent);
        }
      }
    }

    // Retired memories
    if (Array.isArray(analysis.retiredMemories)) {
      for (const ret of analysis.retiredMemories.slice(0, 3)) {
        if (ret.memoryId) {
          db.deleteMemory(identityId, ret.memoryId);
        }
      }
    }

    // New patterns
    if (Array.isArray(analysis.newPatterns)) {
      for (const pat of analysis.newPatterns.slice(0, 2)) {
        if (pat.description && typeof pat.description === 'string' && pat.description.length > 3) {
          db.addOrUpdatePattern(identityId, pat.description, pat.category || 'preference', 0.85);
        }
      }
    }

    // Strengthened patterns
    if (Array.isArray(analysis.strengthenedPatterns)) {
      for (const str of analysis.strengthenedPatterns.slice(0, 3)) {
        if (str.patternId) {
          // Strengthen by re-observing with the same description
          const existing = db.getPatternsForIdentity(identityId).find(p => p.id === str.patternId);
          if (existing) {
            db.addOrUpdatePattern(identityId, existing.description, existing.category, existing.confidence);
          }
        }
      }
    }

    // Corrected patterns
    if (Array.isArray(analysis.correctedPatterns)) {
      for (const cor of analysis.correctedPatterns.slice(0, 2)) {
        if (cor.patternId && cor.newDescription) {
          db.updatePatternDescription(identityId, cor.patternId, cor.newDescription);
        }
      }
    }

    // Retired patterns
    if (Array.isArray(analysis.retiredPatterns)) {
      for (const ret of analysis.retiredPatterns.slice(0, 2)) {
        if (ret.patternId) {
          db.weakenPattern(identityId, ret.patternId, 0.5);
        }
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
