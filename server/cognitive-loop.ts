// ===================================================================
// COGNITIVE LOOP (Requirement #37)
// ===================================================================
//
// Every meaningful interaction follows discrete stages:
// PERCEIVE → IDENTIFY → RECALL → UNDERSTAND → REASON → DECIDE → ACT → VERIFY → RESPOND → LEARN → UPDATE → PERSIST
//
// This must be implemented in actual code, not just documentation or prompt.
// Each stage is independently observable, testable, and returns structured output.

import { AuthContext } from './auth.js';
import { db } from './db.js';
import { cognitiveDecisionEngine } from './cognitive-decision-engine.js';
import { responseGenerator } from './response-generator.js';
import { executeBackendTool } from './tools.js';
import type { CognitiveDecision } from './cognitive-contract.js';

// ===================================================================
// STAGE OUTPUTS
// ===================================================================

export interface Perception {
  raw: string; // Raw user input
  timestamp: string;
  channel: 'text' | 'voice';
  sessionId: string;
  metadata?: any;
}

export interface Identity {
  identityId: string;
  name: string;
  role: 'owner' | 'user' | 'unknown';
  authenticatedId?: string;
  isOwnerAuthenticated: boolean;
}

export interface CognitiveContext {
  identity: Identity;
  perception: Perception;
  memories: any[];
  patterns: any[];
  recentConversation: any[];
  tasks: any[];
  openLoops: any[];
  pendingNotes: any[];
  relationships: any[];
  temporal: {
    nowISO: string;
    timeIST: string;
    dateIST: string;
    dayOfWeek: string;
    lastTurnTime: string | null;
    elapsedHuman: string;
    isShortAbsence: boolean;
  };
  worldAwareness?: any;
  madhuritaIdentity: any;
}

export interface Understanding {
  semanticMeaning: string; // What the user actually means
  intent: string; // What they want
  relevantFacts: string[]; // Context that matters
  ambiguities: string[]; // Unclear aspects
}

export interface Reasoning {
  analysis: string; // Logical analysis of situation
  connections: string[]; // Links to past knowledge
  alternatives: string[]; // Other interpretations
  confidence: number;
}

export interface Decision {
  cognitiveDecision: CognitiveDecision;
  decisionType: 'immediate' | 'deferred' | 'uncertain';
  reasoning: string;
}

export interface ActionResult {
  actions: {
    toolName: string;
    args: any;
    result: any;
    success: boolean;
    error?: string;
  }[];
  stateChanged: boolean;
  changedEntities: string[];
}

export interface Verification {
  actionsSucceeded: boolean;
  expectedOutcome: string;
  actualOutcome: string;
  discrepancies: string[];
  verified: boolean;
}

export interface Response {
  text: string;
  metadata: {
    confidence: number;
    basedOnVerification: boolean;
    tone: string;
  };
}

export interface Learning {
  extracted: any[];
  categories: string[];
  shouldPersist: boolean;
}

export interface KnowledgeUpdate {
  created: number;
  updated: number;
  superseded: number;
  retired: number;
  totalChanges: number;
}

// ===================================================================
// COGNITIVE LOOP IMPLEMENTATION
// ===================================================================

export class CognitiveLoop {
  private stageTimings: Map<string, number> = new Map();
  private currentLoopId: string = '';

  constructor() {}

  /**
   * Generate unique loop ID for tracing
   */
  private generateLoopId(): string {
    return `loop_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Log stage timing for observability
   */
  private logStage(stageName: string, startTime: number) {
    const duration = Date.now() - startTime;
    this.stageTimings.set(stageName, duration);
    console.log(`[COGNITIVE LOOP ${this.currentLoopId}] ${stageName}: ${duration}ms`);
  }

  /**
   * STAGE 1: PERCEIVE
   * Capture raw input and context
   */
  async perceive(
    userInput: string,
    channel: 'text' | 'voice',
    sessionId: string
  ): Promise<Perception> {
    const startTime = Date.now();

    const perception: Perception = {
      raw: userInput.trim(),
      timestamp: new Date().toISOString(),
      channel,
      sessionId,
    };

    this.logStage('PERCEIVE', startTime);
    return perception;
  }

  /**
   * STAGE 2: IDENTIFY
   * Resolve who is speaking
   */
  async identify(
    perception: Perception,
    authContext: AuthContext
  ): Promise<Identity> {
    const startTime = Date.now();

    const identity: Identity = {
      identityId: authContext.id,
      name: authContext.name,
      role: authContext.role,
      authenticatedId: authContext.authenticatedId,
      isOwnerAuthenticated: authContext.isOwnerAuthenticated,
    };

    this.logStage('IDENTIFY', startTime);
    return identity;
  }

  /**
   * STAGE 3: RECALL
   * Retrieve relevant context from authoritative state
   */
  async recall(
    identity: Identity,
    perception: Perception
  ): Promise<CognitiveContext> {
    const startTime = Date.now();

    // This will be integrated with existing assembleCognitiveContext
    // For now, a minimal implementation
    const context: CognitiveContext = {
      identity,
      perception,
      memories: db.getMemoriesForIdentity(identity.identityId).slice(0, 12),
      patterns: db.getPatternsForIdentity(identity.identityId).slice(0, 8),
      recentConversation: db.getRecentTurns(identity.identityId, 10, perception.sessionId),
      tasks: db.getTasksForIdentity(identity.identityId),
      openLoops: db.getWorldAwareness()?.openLoops.filter(l => l.identityId === identity.identityId) || [],
      pendingNotes: db.getPendingNotesForTarget(identity.identityId, identity.name),
      relationships: db.getRelationshipsForEntity(identity.identityId),
      temporal: {
        nowISO: new Date().toISOString(),
        timeIST: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
        dateIST: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
        dayOfWeek: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' }),
        lastTurnTime: null,
        elapsedHuman: 'Just now',
        isShortAbsence: true,
      },
      worldAwareness: identity.role === 'owner' ? db.getWorldAwareness() : undefined,
      madhuritaIdentity: db.getMadhuritaIdentity(),
    };

    this.logStage('RECALL', startTime);
    return context;
  }

  /**
   * STAGE 4: UNDERSTAND
   * Determine semantic meaning and intent
   * (Will be filled by LLM cognitive decision)
   */
  async understand(
    context: CognitiveContext,
    decision: CognitiveDecision
  ): Promise<Understanding> {
    const startTime = Date.now();

    const understanding: Understanding = {
      semanticMeaning: decision.understanding,
      intent: decision.intent,
      relevantFacts: decision.relevantContext,
      ambiguities: decision.confusions || [],
    };

    this.logStage('UNDERSTAND', startTime);
    return understanding;
  }

  /**
   * STAGE 5: REASON
   * Analyze and connect information
   * (Extracted from LLM cognitive decision)
   */
  async reason(
    understanding: Understanding,
    decision: CognitiveDecision
  ): Promise<Reasoning> {
    const startTime = Date.now();

    const reasoning: Reasoning = {
      analysis: decision.reasoning,
      connections: [], // Could extract from decision
      alternatives: decision.alternativeInterpretations || [],
      confidence: decision.confidence,
    };

    this.logStage('REASON', startTime);
    return reasoning;
  }

  /**
   * STAGE 6: DECIDE
   * Make action decision
   * (From LLM cognitive decision)
   */
  async decide(
    reasoning: Reasoning,
    decision: CognitiveDecision
  ): Promise<Decision> {
    const startTime = Date.now();

    const finalDecision: Decision = {
      cognitiveDecision: decision,
      decisionType: decision.proposedAction.confidence > 0.7 ? 'immediate' : 'uncertain',
      reasoning: decision.proposedAction.reasoning,
    };

    this.logStage('DECIDE', startTime);
    return finalDecision;
  }

  /**
   * STAGE 7: ACT
   * Execute proposed tools/actions
   * (Implemented via executeBackendTool in tools.ts)
   */
  async act(
    decision: Decision,
    authContext: AuthContext,
    executeToolFn: (name: string, args: any, ctx: AuthContext) => Promise<any>
  ): Promise<ActionResult> {
    const startTime = Date.now();

    const actions: ActionResult['actions'] = [];
    let stateChanged = false;
    const changedEntities: string[] = [];

    if (decision.cognitiveDecision.proposedAction.tools) {
      for (const tool of decision.cognitiveDecision.proposedAction.tools) {
        try {
          const result = await executeToolFn(tool.name, tool.args, authContext);
          actions.push({
            toolName: tool.name,
            args: tool.args,
            result: result.result,
            success: true,
          });
          stateChanged = true;
          changedEntities.push(tool.name);
        } catch (error: any) {
          actions.push({
            toolName: tool.name,
            args: tool.args,
            result: null,
            success: false,
            error: error.message,
          });
        }
      }
    }

    this.logStage('ACT', startTime);
    return { actions, stateChanged, changedEntities };
  }

  /**
   * STAGE 8: VERIFY
   * Verify actions succeeded and state changed as expected
   */
  async verify(
    actionResult: ActionResult,
    decision: Decision
  ): Promise<Verification> {
    const startTime = Date.now();

    const actionsSucceeded = actionResult.actions.every(a => a.success);
    const expectedOutcome = decision.cognitiveDecision.proposedAction.reasoning;
    const actualOutcome = actionResult.stateChanged
      ? `State changed: ${actionResult.changedEntities.join(', ')}`
      : 'No state change';

    const discrepancies: string[] = [];
    if (!actionsSucceeded) {
      const failed = actionResult.actions.filter(a => !a.success);
      failed.forEach(f => discrepancies.push(`${f.toolName} failed: ${f.error}`));
    }

    this.logStage('VERIFY', startTime);
    return {
      actionsSucceeded,
      expectedOutcome,
      actualOutcome,
      discrepancies,
      verified: actionsSucceeded && discrepancies.length === 0,
    };
  }

  /**
   * STAGE 9: RESPOND
   * Generate natural language response based on verified state
   * (LLM called AFTER state resolved)
   */
  async respond(
    verification: Verification,
    decision: Decision,
    generateResponseFn: (decision: CognitiveDecision, verification: Verification) => Promise<string>
  ): Promise<Response> {
    const startTime = Date.now();

    const text = await generateResponseFn(decision.cognitiveDecision, verification);

    const response: Response = {
      text,
      metadata: {
        confidence: decision.cognitiveDecision.confidence,
        basedOnVerification: verification.verified,
        tone: decision.cognitiveDecision.speechDecision.tone || 'neutral',
      },
    };

    this.logStage('RESPOND', startTime);
    return response;
  }

  /**
   * STAGE 10: LEARN
   * Extract learning from the interaction
   * (From cognitive decision learning decision)
   */
  async learn(
    context: CognitiveContext,
    decision: Decision,
    response: Response
  ): Promise<Learning> {
    const startTime = Date.now();

    const learning: Learning = {
      extracted: decision.cognitiveDecision.learningDecision.categories,
      categories: decision.cognitiveDecision.learningDecision.categories.map(c => c.category),
      shouldPersist: decision.cognitiveDecision.learningDecision.shouldLearn,
    };

    this.logStage('LEARN', startTime);
    return learning;
  }

  /**
   * STAGE 11: UPDATE
   * Apply knowledge updates to authoritative state
   */
  async update(
    learning: Learning,
    decision: Decision
  ): Promise<KnowledgeUpdate> {
    const startTime = Date.now();

    let created = 0;
    let updated = 0;
    let superseded = 0;
    let retired = 0;

    // Apply knowledge updates from decision
    for (const update of decision.cognitiveDecision.knowledgeUpdates) {
      switch (update.action) {
        case 'create':
          created++;
          break;
        case 'update':
          updated++;
          break;
        case 'supersede':
          superseded++;
          break;
        case 'retire':
          retired++;
          break;
      }
    }

    this.logStage('UPDATE', startTime);
    return {
      created,
      updated,
      superseded,
      retired,
      totalChanges: created + updated + superseded + retired,
    };
  }

  /**
   * STAGE 12: PERSIST
   * Save all changes to authoritative database
   */
  async persist(
    context: CognitiveContext,
    response: Response,
    update: KnowledgeUpdate
  ): Promise<void> {
    const startTime = Date.now();

    // Persist response as assistant turn
    db.logTurn(
      context.identity.identityId,
      'assistant',
      response.text,
      context.perception.sessionId
    );

    this.logStage('PERSIST', startTime);

    // Log complete loop timing
    console.log(`[COGNITIVE LOOP ${this.currentLoopId}] COMPLETE - Total stages: 12`);
    console.log(`[COGNITIVE LOOP ${this.currentLoopId}] Knowledge changes: ${update.totalChanges}`);
  }

  /**
   * Execute complete cognitive loop.
   * Uses real LLM via cognitiveDecisionEngine and responseGenerator.
   * Uses real tool execution via executeBackendTool.
   */
  async execute(
    userInput: string,
    channel: 'text' | 'voice',
    sessionId: string,
    authContext: AuthContext
  ): Promise<{ response: Response; loopId: string; timings: Map<string, number>; decision: CognitiveDecision }> {
    this.currentLoopId = this.generateLoopId();
    this.stageTimings.clear();

    console.log(`[COGNITIVE LOOP ${this.currentLoopId}] START`);

    // Persist user turn immediately
    db.logTurn(authContext.id, 'user', userInput.trim(), sessionId);

    // Execute all 12 stages in order
    const perception = await this.perceive(userInput, channel, sessionId);
    const identity = await this.identify(perception, authContext);
    const context = await this.recall(identity, perception);

    // Stages 4-6: LLM performs UNDERSTAND/REASON/DECIDE
    const cognitiveDecision = await cognitiveDecisionEngine.getDecision(context);

    if (!cognitiveDecision) {
      // Hard failure — respond with fallback
      const fallbackText = 'I am having trouble thinking right now. Please try again in a moment.';
      db.logTurn(identity.identityId, 'assistant', fallbackText, sessionId);
      console.log(`[COGNITIVE LOOP ${this.currentLoopId}] DECISION FAILED — fallback response`);
      return {
        response: { text: fallbackText, metadata: { confidence: 0, basedOnVerification: false, tone: 'neutral' } },
        loopId: this.currentLoopId,
        timings: new Map(this.stageTimings),
        decision: {} as CognitiveDecision,
      };
    }

    const understanding = await this.understand(context, cognitiveDecision);
    const reasoning = await this.reason(understanding, cognitiveDecision);
    const decision = await this.decide(reasoning, cognitiveDecision);

    // Stage 7: ACT — execute proposed tools using real executor
    const actionResult = await this.act(decision, authContext, executeBackendTool);

    // Stage 8: VERIFY
    const verification = await this.verify(actionResult, decision);

    // Stage 9: RESPOND — generate natural language AFTER state resolved
    // Route through this.respond() so the RESPOND stage timing is captured
    // alongside the other 11 stages of the 12-stage cognitive loop.
    const response: Response = await this.respond(
      verification,
      decision,
      async (decisionArg, verificationArg) => {
        return await responseGenerator.generate(
          decisionArg,
          verificationArg,
          userInput,
          identity.name,
          identity.role,
          identity.isOwnerAuthenticated
        );
      }
    );

    // Stage 10: LEARN
    const learning = await this.learn(context, decision, response);

    // Stage 11: UPDATE — apply knowledge updates from decision
    const update = await this.update(learning, decision);
    this.applyKnowledgeUpdates(decision.cognitiveDecision, identity.identityId);

    // Stage 12: PERSIST
    await this.persist(context, response, update);

    return {
      response,
      loopId: this.currentLoopId,
      timings: new Map(this.stageTimings),
      decision: decision.cognitiveDecision,
    };
  }

  /**
   * Apply knowledge updates from a cognitive decision to authoritative state.
   */
  private applyKnowledgeUpdates(decision: CognitiveDecision, identityId: string): void {
    for (const update of decision.knowledgeUpdates) {
      try {
        switch (update.action) {
          case 'create':
            if (update.content) {
              db.validateAndApplyMemoryCandidate(
                identityId,
                update.content,
                'fact',
                update.confidence ?? 0.8,
                update.importance ?? 0.7,
                false
              );
            }
            break;
          // (create case doesn't return memory, that's fine)
          case 'update':
            if (update.targetMemoryId && update.content) {
              db.updateMemoryContent(identityId, update.targetMemoryId, update.content);
            }
            break;
          case 'supersede':
            if (update.targetMemoryId && update.content) {
              // Add new memory, then supersede old
              const result = db.validateAndApplyMemoryCandidate(
                identityId,
                update.content,
                'fact',
                update.confidence ?? 0.9,
                update.importance ?? 0.8,
                false
              );
              if (result.memory) {
                db.supersedeMemory(identityId, update.targetMemoryId, result.memory.memoryId, update.justification);
              }
            }
            break;
          case 'retire':
            if (update.targetMemoryId) {
              db.deleteMemory(identityId, update.targetMemoryId);
            }
            break;
        }
      } catch (err: any) {
        console.warn(`[COGNITIVE LOOP ${this.currentLoopId}] knowledge update failed:`, err.message);
      }
    }
  }
}

// Export singleton instance
export const cognitiveLoop = new CognitiveLoop();
