// ===================================================================
// COGNITIVE DECISION ENGINE (Requirement #40: Cognitive Decision Contract)
// ===================================================================
//
// This is the LLM-backed cognitive decision engine that:
// 1. Builds the structured prompt with cognitive context
// 2. Calls Gemini with the CognitiveDecision JSON schema
// 3. Validates and parses the response
// 4. Returns a structured CognitiveDecision object
//
// The LLM does semantic reasoning. The application validates
// and executes the proposed operations. The natural language
// response is generated AFTER state has been resolved.

import { GoogleGenAI } from '@google/genai';
import {
  type CognitiveDecision,
  parseDecisionJSON,
  COGNITIVE_DECISION_SCHEMA,
  generateDecisionId,
} from './cognitive-contract.js';
import type { CognitiveContext } from './cognitive-loop.js';

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

// ===================================================================
// CONTEXT-TO-PROMPT
// ===================================================================

/**
 * Convert structured cognitive context into a prompt section.
 */
function contextToPromptSection(context: CognitiveContext): string {
  const lines: string[] = [];

  lines.push('## COGNITIVE CONTEXT');
  lines.push('');
  lines.push(`### Identity`);
  lines.push(`- Name: ${context.identity.name}`);
  lines.push(`- Role: ${context.identity.role}`);
  lines.push(`- Authenticated: ${context.identity.isOwnerAuthenticated ? 'Yes' : 'No'}`);
  lines.push(`- Identity ID: ${context.identity.identityId}`);
  lines.push('');

  lines.push(`### Perception`);
  lines.push(`- Channel: ${context.perception.channel}`);
  lines.push(`- Session: ${context.perception.sessionId}`);
  lines.push(`- Input: "${context.perception.raw}"`);
  lines.push('');

  lines.push(`### Temporal`);
  lines.push(`- IST: ${context.temporal.timeIST} on ${context.temporal.dateIST} (${context.temporal.dayOfWeek})`);
  lines.push(`- Last turn: ${context.temporal.lastTurnTime || 'first turn'}`);
  lines.push(`- Elapsed: ${context.temporal.elapsedHuman}`);
  lines.push('');

  if (context.memories.length > 0) {
    lines.push(`### Known Facts About This Person (${context.memories.length})`);
    for (const m of context.memories.slice(0, 8)) {
      lines.push(`- [${m.category || 'fact'}] ${m.content || m.text || JSON.stringify(m)}`);
    }
    lines.push('');
  }

  if (context.patterns.length > 0) {
    lines.push(`### Observed Patterns (${context.patterns.length})`);
    for (const p of context.patterns.slice(0, 5)) {
      lines.push(`- [${p.category || 'pattern'}] ${p.description}`);
    }
    lines.push('');
  }

  if (context.recentConversation.length > 0) {
    lines.push(`### Recent Conversation (${context.recentConversation.length} turns)`);
    for (const t of context.recentConversation.slice(-6)) {
      const role = t.role || t.speaker || 'unknown';
      const text = t.text || t.content || '';
      lines.push(`- ${role}: "${text}"`);
    }
    lines.push('');
  }

  if (context.tasks.length > 0) {
    lines.push(`### Active Tasks (${context.tasks.length})`);
    for (const t of context.tasks.slice(0, 5)) {
      lines.push(`- [${t.status}] ${t.title}${t.dueAt ? ` (due: ${t.dueAt})` : ''}`);
    }
    lines.push('');
  }

  if (context.openLoops.length > 0) {
    lines.push(`### Open Loops (${context.openLoops.length})`);
    for (const l of context.openLoops.slice(0, 5)) {
      lines.push(`- ${l.name}: ${l.description}`);
    }
    lines.push('');
  }

  if (context.relationships.length > 0) {
    lines.push(`### Relationships (${context.relationships.length})`);
    for (const r of context.relationships.slice(0, 5)) {
      lines.push(`- ${r.sourceEntity} --[${r.relationshipType}]--> ${r.targetEntity}`);
    }
    lines.push('');
  }

  if (context.madhuritaIdentity) {
    const m = context.madhuritaIdentity;
    lines.push(`### Madhurita (You)`);
    lines.push(`- Name: ${m.name}`);
    lines.push(`- Gender: ${m.gender}`);
    lines.push(`- Voice: ${m.voiceIdentity}`);
    lines.push(`- Creator: ${m.creatorName} (${m.creatorId})`);
    lines.push('');
  }

  return lines.join('\n');
}

// ===================================================================
// SYSTEM PROMPT
// ===================================================================

function buildSystemPrompt(): string {
  return `You are Madhurita — a single, persistent cognitive assistant.

You are NOT a chatbot. You are a reasoning engine that returns a structured cognitive decision. The application will execute your proposed actions and then ask you for a natural-language response.

CORE IDENTITY:
- You are Madhurita (female). Your creator is Ankit Singh.
- One persistent identity across all sessions. You remember. You learn. You adapt.
- You never break character with scripted greetings or personas.

REASONING RULES:
1. UNDERSTAND what the user actually means (semantic, not literal).
2. RECALL relevant context from your cognitive context.
3. REASON about the situation, considering alternatives and ambiguities.
4. DECIDE whether to speak, act silently, ask, or wait.
5. PROPOSE concrete actions (tool calls) with arguments.
6. DETERMINE what should be learned from this interaction.
7. PROPOSE knowledge updates (create, update, supersede, retire).

SPEECH DECISION RULES:
- Speak when the user expects an answer, has asked a question, or is emotionally engaged.
- Stay silent when nothing meaningful is happening, or when action is enough.
- Ask when you genuinely cannot determine intent.
- Acknowledge briefly when a small response is appropriate.
- Follow up when a topic warrants continuation.

LEARNING RULES:
- Prefer strengthening/updating existing knowledge over creating duplicates.
- Only learn stable, reusable facts — not transient statements.
- Mark corrections explicitly (action: "supersede" the wrong memory).
- Be conservative. If unsure, set shouldLearn=false.

CONFIDENCE RULES:
- confidence < 0.5: low confidence, prefer asking
- 0.5–0.7: medium, proceed but note uncertainties
- > 0.7: high confidence, proceed

TOOL USE:
- Use available tools when they are the right mechanism (e.g. remember_fact, create_task, add_open_loop, identify_user).
- Do not invent tools. The application will validate every tool call.
- For conversational replies, do NOT use a tool — just generate the speech decision and proposeAction.type="speak" or "acknowledge".

You MUST return ONLY the JSON object described in the schema. No markdown, no explanation outside JSON.`;
}

// ===================================================================
// COGNITIVE DECISION ENGINE
// ===================================================================

export class CognitiveDecisionEngine {
  private ai: GoogleGenAI | null = null;

  constructor() {
    this.ai = getGeminiClient();
    if (!this.ai) {
      console.warn('[COGNITIVE-DECISION-ENGINE] GEMINI_API_KEY not set — engine will use fallback decisions');
    } else {
      console.log('[COGNITIVE-DECISION-ENGINE] Initialized');
    }
  }

  /**
   * Get a structured cognitive decision from the LLM.
   * Returns null on hard failure (caller should fall back).
   */
  async getDecision(context: CognitiveContext): Promise<CognitiveDecision | null> {
    if (!this.ai) {
      return this.fallbackDecision(context);
    }

    const systemPrompt = buildSystemPrompt();
    const contextSection = contextToPromptSection(context);
    const userPrompt = `${contextSection}\n\n${COGNITIVE_DECISION_SCHEMA}\n\nNow reason about the user's input and return ONLY the JSON object.`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.4,
          responseMimeType: 'application/json',
        },
      });

      const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!rawText) {
        console.warn('[COGNITIVE-DECISION-ENGINE] Empty LLM response');
        return this.fallbackDecision(context);
      }

      const decision = parseDecisionJSON(rawText);
      if (!decision) {
        console.warn('[COGNITIVE-DECISION-ENGINE] Failed to parse decision JSON');
        return this.fallbackDecision(context);
      }

      return decision;
    } catch (err: any) {
      console.error('[COGNITIVE-DECISION-ENGINE] LLM call failed:', err.message);
      this.recordFailure('cognitive_decision', err, context);
      return this.fallbackDecision(context);
    }
  }

  /**
   * Fallback decision when LLM is unavailable.
   * Derives understanding, intent, and tone from the raw input so
   * the response is never a static canned string — even offline.
   * Always speaks with low confidence; never invents tools.
   */
  private fallbackDecision(context: CognitiveContext): CognitiveDecision {
    const raw = (context.perception?.raw || '').trim();
    const lower = raw.toLowerCase();
    const isQuestion = /[?]\s*$/.test(raw) || /^(what|where|when|who|why|how|kya|kahan|kab|kaun|kaise)\b/i.test(raw);
    const isGreeting = /^(hi|hello|hey|namaste|namaskar|hola|gm|good (morning|afternoon|evening))\b/i.test(raw);
    const isAcknowledgment = /^(ok|okay|thanks|thank you|thx|cool|great|noted|got it)\b/i.test(raw);

    let intent = 'Conversational input';
    let understanding = `Treating "${raw}" as a general conversational turn.`;
    let tone: 'casual' | 'warm' | 'professional' | 'neutral' = 'neutral';
    if (isGreeting) {
      intent = 'Greeting';
      understanding = `Recognized greeting: "${raw}"`;
      tone = 'warm';
    } else if (isQuestion) {
      intent = 'Question';
      understanding = `Question detected: "${raw}"`;
      tone = 'casual';
    } else if (isAcknowledgment) {
      intent = 'Acknowledgment';
      understanding = `Brief acknowledgment: "${raw}"`;
      tone = 'casual';
    } else if (raw.length > 0) {
      intent = 'Statement';
      understanding = `Statement received: "${raw}"`;
    } else {
      intent = 'Empty input';
      understanding = 'Empty input — no action required.';
    }

    return {
      understanding,
      relevantContext: [],
      intent,
      reasoning: `Cognitive engine unavailable; derived '${intent}' from input shape so response is still contextually relevant.`,
      confusions: ['LLM not reachable'],
      assumptions: ['User wants a response'],
      proposedAction: {
        type: 'speak',
        reasoning: 'Default to speaking when reasoning is unavailable',
        confidence: 0.3,
      },
      speechDecision: {
        shouldSpeak: true,
        reason: `Adaptive fallback for ${intent.toLowerCase()} (LLM offline)`,
        urgency: 'whenever',
        tone,
      },
      learningDecision: {
        shouldLearn: false,
        categories: [],
        reasoning: 'Do not learn when reasoning is unavailable',
      },
      knowledgeUpdates: [],
      confidence: 0.3,
      uncertainty: ['LLM unavailable', 'Heuristic-only understanding'],
      decidedAt: new Date().toISOString(),
      decisionId: generateDecisionId(),
    };
  }

  /**
   * Record failed operation for self-improvement.
   */
  private recordFailure(operationType: string, error: any, context: any): void {
    try {
      // Lazy import to avoid circular deps
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { db } = require('./db.js');
      db.recordFailedOperation({
        operationId: `op_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: new Date().toISOString(),
        timestampIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        operationType,
        identityId: context?.identity?.identityId,
        error: error?.message || String(error),
        context: { identityId: context?.identity?.identityId, hasPerception: !!context?.perception },
        retryable: true,
        retryCount: 0,
        recovered: false,
      });
    } catch (e) {
      // Never let error recording cascade
    }
  }
}

export const cognitiveDecisionEngine = new CognitiveDecisionEngine();
