# MADHURITA Complete Rebuild: Implementation Plan

**Date:** 2026-08-31  
**Objective:** Build Madhurita as one evolving cognitive assistant (not a chatbot)  
**Gap Analysis:** See `45_POINT_GAP_ANALYSIS.md`  
**Current Completion:** ~60% (database, auth, basic cognition exist)  
**Target:** 100% working cognitive system per 45-point specification

---

## Guiding Principles

From requirement #44:
> Solve behavioral problems via better **state/context/retrieval/reasoning/learning/execution/persistence/sync**, not more **prompts/personas/keywords/responses/branches**.

From requirement #45:
> Build complete working system. No placeholder logic. Everything must actually execute and persist.

---

## Implementation Phases

### PHASE 1: Core Identity & Cognitive Contract (Week 1)

**Objective:** Establish Madhurita as a persistent cognitive entity with structured reasoning.

**Requirements:** #1, #37, #40

**Deliverables:**

1. **Madhurita Identity System** (requirement #1)
   - Create `MadhuritaIdentity` schema in DB:
     ```typescript
     interface MadhuritaIdentity {
       identityId: 'MADHURITA_CORE';
       name: 'Madhurita';
       gender: 'female';
       creatorId: 'OWNER_001'; // immutable
       creatorName: 'Ankit';
       createdAt: string;
       systemVersion: string;
       voiceIdentity: FemaleVoiceName;
       traits: {
         loyal_to_creator: true;
         learns_continuously: true;
         adapts_naturally: true;
       };
     }
     ```
   - System startup verifies Madhurita identity exists
   - Female identity enforced at all layers (DB, voice, config)
   - Creator reference immutable (Ankit = OWNER_001)

2. **Cognitive Decision Contract** (requirement #40)
   - Define structured decision schema:
     ```typescript
     interface CognitiveDecision {
       understanding: string; // What the user means
       relevantContext: string[]; // What context matters
       intent: string; // What they actually want
       reasoning: string; // How we arrived at conclusion
       proposedAction: {
         type: 'speak' | 'act' | 'silent' | 'ask';
         tools?: ToolCall[];
         confidence: number;
       };
       speechDecision: {
         shouldSpeak: boolean;
         reason: string;
         content?: string;
       };
       learningDecision: {
         shouldLearn: boolean;
         categories: ('fact' | 'preference' | 'habit' | 'relationship' | 'correction')[];
       };
       knowledgeUpdates: {
         create?: any[];
         update?: any[];
         supersede?: any[];
       };
       uncertainty: string[];
     }
     ```
   - Modify `processChatTurn()` to request structured JSON first
   - Natural language generated AFTER state resolved
   - Two-phase LLM interaction:
     1. Request decision JSON (model: gemini-3.5-flash-lite)
     2. After state mutation, request natural language response

3. **Explicit Cognitive Loop** (requirement #37)
   - Implement as discrete stages in code:
     ```typescript
     class CognitiveLoop {
       async perceive(input: UserInput): Promise<Perception>
       async identify(perception: Perception): Promise<Identity>
       async recall(identity: Identity, perception: Perception): Promise<Context>
       async understand(context: Context): Promise<Understanding>
       async reason(understanding: Understanding): Promise<Reasoning>
       async decide(reasoning: Reasoning): Promise<Decision>
       async act(decision: Decision): Promise<ActionResult>
       async verify(result: ActionResult): Promise<Verification>
       async respond(verification: Verification): Promise<Response>
       async learn(interaction: Interaction): Promise<Learning>
       async update(learning: Learning): Promise<KnowledgeUpdate>
       async persist(update: KnowledgeUpdate): Promise<void>
     }
     ```
   - Each stage is independently observable
   - Each stage returns structured output
   - Testable in isolation

**Files to Modify:**
- `server/db.ts` — Add `MadhuritaIdentity` schema
- `server/cognition-2.ts` — Implement `CognitiveLoop` class
- `server/cognition-2.ts` — Modify `processChatTurn()` for two-phase interaction
- `server.ts` — Add startup identity verification

**Verification:**
- [ ] `db.getMadhuritaIdentity()` returns identity on every boot
- [ ] Female voice enforced in all configs
- [ ] Creator reference is OWNER_001 (Ankit)
- [ ] LLM returns structured `CognitiveDecision` JSON
- [ ] Natural language generated after state mutation
- [ ] Each cognitive stage independently logged

---

### PHASE 2: Event System & Event-Driven Cognition (Week 2)

**Objective:** Enable cognition to trigger on meaningful events, not just chat.

**Requirements:** #34, #3, #33

**Deliverables:**

1. **Event System** (requirement #34)
   - Create event schema:
     ```typescript
     interface SystemEvent {
       eventId: string;
       eventType: 'user_arrival' | 'user_departure' | 'reconnection' |
                  'new_message' | 'task_state_change' | 'loop_state_change' |
                  'environment_change' | 'scheduled_event' | 'new_learning' |
                  'correction' | 'behavior_change';
       timestamp: string;
       identityId?: string;
       payload: any;
       importance: number;
       processed: boolean;
       cognitionTriggered: boolean;
     }
     ```
   - Event emitter for all state changes
   - Event subscription system
   - Event-driven cognition pipeline

2. **Continuous Awareness Pipeline** (requirement #3)
   - Background service that maintains operational model:
     ```typescript
     class AwarenessEngine {
       private operationalModel: {
         activeUsers: Map<string, PresenceInfo>;
         recentActivity: ActivityLog[];
         pendingTasks: TaskItem[];
         pendingLoops: OpenLoopItem[];
         pendingMessages: CrossUserNote[];
         failedActions: ActionLog[];
         systemHealth: SystemHealth;
       };
       
       async updatePresence(identityId: string, status: 'active' | 'away' | 'offline'): Promise<void>
       async logActivity(activity: Activity): Promise<void>
       async evaluateImportance(event: SystemEvent): Promise<number>
       async getOperationalBriefing(forIdentity: string): Promise<OperationalBriefing>
     }
     ```

3. **Event-Driven Cognition** (requirement #34)
   - Cognition triggers on:
     - User arrival (WebSocket connect)
     - User departure (WebSocket disconnect)
     - New cross-user message delivery
     - Task due time reached
     - Loop requires evaluation
     - Environment change (time of day, weather)
   - Each event scored for importance
   - High-importance events trigger proactive cognition
   - Cognition decides: speak/act/wait/silent

**Files to Create:**
- `server/event-system.ts` — Event emitter, subscription
- `server/awareness-engine.ts` — Continuous awareness maintenance
- `server/event-cognition.ts` — Event-driven cognition pipeline

**Files to Modify:**
- `server/db.ts` — Add `SystemEvent` schema
- `server/live-session.ts` — Emit arrival/departure events
- `server/cognition-2.ts` — Integrate event-driven triggers

**Verification:**
- [ ] WebSocket connect emits `user_arrival` event
- [ ] WebSocket disconnect emits `user_departure` event
- [ ] Cross-user note delivery triggers cognition
- [ ] Cognition decides whether to speak proactively
- [ ] Operational briefing available for Owner
- [ ] Event log persisted and queryable

---

### PHASE 3: Task & Loop Execution (Week 3)

**Objective:** Make tasks and loops actually execute, not just store.

**Requirements:** #9, #10

**Deliverables:**

1. **Task Execution Engine** (requirement #9)
   - Scheduler that evaluates tasks every minute
   - Execution state tracking:
     ```typescript
     interface TaskItem {
       // ... existing fields
       executionState: 'pending' | 'scheduled' | 'executing' | 'completed' | 'failed';
       executionResult?: any;
       failureReason?: string;
       retryCount?: number;
       lastExecutionAttempt?: string;
     }
     ```
   - Task executor service:
     ```typescript
     class TaskExecutor {
       async evaluateDueTasks(): Promise<TaskItem[]>
       async executeTask(task: TaskItem): Promise<ExecutionResult>
       async verifyCompletion(task: TaskItem): Promise<boolean>
       async handleFailure(task: TaskItem, error: Error): Promise<void>
       async scheduleRetry(task: TaskItem): Promise<void>
     }
     ```

2. **Loop Management Engine** (requirement #10)
   - Loop evaluator that runs daily:
     ```typescript
     class LoopManager {
       async evaluateLoopRelevance(loop: OpenLoopItem): Promise<RelevanceScore>
       async detectResolution(loop: OpenLoopItem): Promise<boolean>
       async updateImportance(loop: OpenLoopItem): Promise<number>
       async archiveResolvedLoops(): Promise<void>
       async surfaceActiveLoops(forIdentity: string): Promise<OpenLoopItem[]>
     }
     ```
   - Integration with cognitive context (loops in awareness)

**Files to Create:**
- `server/task-executor.ts` — Task scheduling and execution
- `server/loop-manager.ts` — Loop evaluation and management

**Files to Modify:**
- `server/db.ts` — Add execution state fields to `TaskItem`
- `server/cognition-2.ts` — Integrate loop evaluation in context
- `server.ts` — Start task executor on boot

**Verification:**
- [ ] Task scheduled for future time executes at that time
- [ ] Task execution success/failure logged
- [ ] Failed tasks have failure reason
- [ ] Loop relevance scored daily
- [ ] Resolved loops auto-archive
- [ ] Active loops appear in cognitive context

---

### PHASE 4: Proactive Reasoning (Week 4)

**Objective:** Madhurita proactively speaks/acts when appropriate, not just when asked.

**Requirements:** #17, #18, #19, #20

**Deliverables:**

1. **Proactive Evaluation Engine** (requirement #17)
   - Scoring system for proactive decisions:
     ```typescript
     interface ProactiveScore {
       importance: number; // 0-100
       urgency: number; // 0-100
       novelty: number; // 0-100
       relevance: number; // 0-100
       interruptionRisk: number; // 0-100 (higher = more risky)
       timingAppropriate: boolean;
       decision: 'speak' | 'act' | 'ask' | 'follow_up' | 'wait' | 'silent';
       reasoning: string;
     }
     
     class ProactiveEngine {
       async evaluateProactiveOpportunity(event: SystemEvent, context: CognitiveContext): Promise<ProactiveScore>
       async shouldSpeak(score: ProactiveScore, identity: Identity): Promise<boolean>
       async generateProactiveResponse(score: ProactiveScore, context: CognitiveContext): Promise<string>
     }
     ```

2. **Human-Like Timing** (requirement #18)
   - User routine model:
     ```typescript
     interface UserRoutine {
       identityId: string;
       typicalActiveHours: [number, number][]; // [[9,12], [14,18]]
       dayOfWeekPatterns: Map<string, ActivityPattern>;
       lastSeenTimes: Date[];
       interactionFrequency: number; // interactions per day
       preferredResponseTime: 'immediate' | 'within_hour' | 'when_convenient';
     }
     ```
   - Time-of-day appropriateness scoring
   - Interaction frequency modeling

3. **Natural Conversation** (requirement #19)
   - Audit system prompt for forced patterns
   - Add explicit silence permission:
     ```
     SILENCE PERMISSION:
     You may remain completely silent when:
     - There is nothing meaningful to contribute
     - The user's statement requires no response
     - Waiting for more context is appropriate
     - The situation does not call for acknowledgment
     
     Do not force greetings, help offers, follow-up questions, or assistant-style phrases.
     ```

4. **Conversational Continuity** (requirement #20)
   - Continuity scoring:
     ```typescript
     class ContinuityEngine {
       async scoreContinuity(identity: Identity, currentSession: Session): Promise<ContinuityScore>
       async identifyUnfinishedTopics(sessions: Session[]): Promise<Topic[]>
       async shouldResumeTopic(topic: Topic, elapsed: number): Promise<boolean>
     }
     ```

**Files to Create:**
- `server/proactive-engine.ts` — Proactive evaluation and execution
- `server/timing-engine.ts` — User routine modeling and timing
- `server/continuity-engine.ts` — Conversation continuity

**Files to Modify:**
- `server/cognition-2.ts` — Integrate proactive scoring
- `server/cognition-2.ts` — Audit and update system prompt
- `server/db.ts` — Add `UserRoutine` schema

**Verification:**
- [ ] Proactive evaluation scores calculated for events
- [ ] Madhurita speaks proactively only when score warrants
- [ ] Silence occurs when appropriate (no forced speech)
- [ ] User routine learned from interactions
- [ ] Time-of-day influences proactive decisions
- [ ] Unfinished topics tracked and resumed appropriately

---

### PHASE 5: Self-Improvement & Observability (Week 5)

**Objective:** Madhurita learns from mistakes and provides observability.

**Requirements:** #15, #38, #39

**Deliverables:**

1. **Self-Improvement System** (requirement #15)
   - Behavior evaluation:
     ```typescript
     interface BehaviorEvaluation {
       evaluationId: string;
       timestamp: string;
       interactionId: string;
       category: 'mistake' | 'misunderstanding' | 'inefficiency' | 'repeated_failure' | 'success';
       description: string;
       impact: 'low' | 'medium' | 'high';
       learningExtracted: string;
       improvementAction: string;
       status: 'identified' | 'learning_applied' | 'verified';
     }
     
     class SelfImprovementEngine {
       async evaluateInteraction(interaction: Interaction): Promise<BehaviorEvaluation | null>
       async detectRepeatedFailures(): Promise<FailurePattern[]>
       async extractLearning(evaluation: BehaviorEvaluation): Promise<Learning>
       async applyImprovement(learning: Learning): Promise<void>
     }
     ```

2. **Error & Failure Awareness** (requirement #38)
   - Failed operation log:
     ```typescript
     interface FailedOperation {
       operationId: string;
       timestamp: string;
       operationType: string;
       identityId?: string;
       error: string;
       context: any;
       retryable: boolean;
       retryCount: number;
     }
     ```
   - Failure pattern detection
   - Failure-driven learning

3. **Observability System** (requirement #39)
   - Structured logging for all cognitive stages
   - Performance metrics (latency, token usage)
   - State mutation audit trail
   - Cognitive decision log (what was decided and why)
   - API for observability queries

**Files to Create:**
- `server/self-improvement.ts` — Behavior evaluation and improvement
- `server/observability.ts` — Logging, metrics, audit trail

**Files to Modify:**
- `server/db.ts` — Add failure and evaluation schemas
- `server/cognition-2.ts` — Log cognitive decisions
- `server/tools.ts` — Log tool executions

**Verification:**
- [ ] All cognitive stages logged with timing
- [ ] Failed operations persisted with context
- [ ] Repeated failures detected and surfaced
- [ ] Self-improvement learning extracted
- [ ] Observability API returns metrics
- [ ] Audit trail queryable by Owner

---

### PHASE 6: Environment Integration (Week 6)

**Objective:** Connect Madhurita to environment (weather, location, time context).

**Requirements:** #21, #2

**Deliverables:**

1. **Environment State Model** (requirement #21)
   - Schema:
     ```typescript
     interface EnvironmentState {
       timestamp: string;
       location: {
         city: string;
         state: string;
         country: string;
         timezone: string;
         coordinates: [number, number];
       };
       weather?: {
         condition: string;
         temperature: number;
         humidity: number;
         source: string;
         fetchedAt: string;
       };
       timeContext: {
         timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
         dayOfWeek: string;
         isWeekend: boolean;
         isHoliday?: boolean;
       };
       systemState: {
         health: 'healthy' | 'degraded' | 'down';
         activeSessions: number;
         cpuUsage?: number;
         memoryUsage?: number;
       };
     }
     ```

2. **Weather Integration**
   - Weather service with caching (refresh every 30 min)
   - Fallback when API unavailable
   - Never fabricate weather data

3. **Environment-Aware Context**
   - Include environment in cognitive context
   - Time-of-day influences decisions
   - Weather influences proactive remarks (when relevant)

**Files to Create:**
- `server/environment.ts` — Environment state aggregation
- `server/weather-service.ts` — Weather API integration

**Files to Modify:**
- `server/db.ts` — Add `EnvironmentState` to DB
- `server/cognition-2.ts` — Include environment in context
- `server.ts` — Initialize environment on startup

**Verification:**
- [ ] Environment state retrieved on boot
- [ ] Weather fetched and cached
- [ ] Time-of-day context available
- [ ] Environment included in cognitive context
- [ ] No fabricated environmental data

---

### PHASE 7: Relationship Learning (Week 7)

**Objective:** Madhurita learns how people relate to each other and to her.

**Requirements:** #16, #32

**Deliverables:**

1. **Social Awareness System** (requirement #16)
   - Baseline behavior model per user:
     ```typescript
     interface UserBehaviorBaseline {
       identityId: string;
       communicationStyle: 'formal' | 'casual' | 'technical' | 'friendly';
       typicalTopics: string[];
       interactionFrequency: number;
       averageSessionDuration: number;
       languagePreference: string;
       emotionalTone: 'neutral' | 'warm' | 'professional';
       deviations: {
         date: string;
         deviation: string;
         significance: number;
       }[];
     }
     ```
   - Anomaly detection (what's different from normal)

2. **Cross-User Relationship Learning** (requirement #32)
   - Relationship inference:
     ```typescript
     interface LearnedRelationship {
       relationshipId: string;
       identityA: string;
       identityB: string;
       relationshipType: 'family' | 'colleague' | 'friend' | 'professional' | 'unknown';
       confidence: number;
       evidenceCount: number;
       interactions: string[]; // References to interactions that reveal relationship
       notes: string[];
     }
     ```
   - Relationship learning from conversations
   - Disclosure authorization based on relationships

**Files to Create:**
- `server/social-awareness.ts` — Behavior baseline and anomaly detection
- `server/relationship-learning.ts` — Relationship inference

**Files to Modify:**
- `server/db.ts` — Add behavior baseline schema
- `server/cognition-2.ts` — Include relationships in context
- `server/cognition-2.ts` — Relationship learning in post-interaction

**Verification:**
- [ ] User behavior baseline learned over time
- [ ] Anomalies detected (deviation from baseline)
- [ ] Relationships inferred from interactions
- [ ] Relationship type classified (family/friend/colleague)
- [ ] Disclosure respects relationship context

---

### PHASE 8: System Polish & Testing (Week 8)

**Objective:** Polish, optimize, test entire system end-to-end.

**Requirements:** All (#1-#45)

**Deliverables:**

1. **System Prompt Optimization**
   - Audit for scripted behavior (requirement #36)
   - Remove forced patterns
   - Keep only immutable invariants
   - Optimize length (target: <2000 tokens)

2. **Performance Optimization**
   - Memory retrieval algorithm tuning
   - Context assembly caching
   - DB query optimization
   - Token usage optimization

3. **Comprehensive Testing**
   - Unit tests for each module
   - Integration tests for cognitive loop
   - End-to-end tests for scenarios A-L
   - Load testing (multiple concurrent users)
   - Failure recovery testing

4. **Documentation**
   - Architecture documentation
   - API documentation
   - Deployment guide
   - Observability guide

**Verification:**
- [ ] All 45 requirements verified
- [ ] End-to-end scenarios A-L pass
- [ ] Performance acceptable (<2s response time)
- [ ] No memory leaks
- [ ] System recovers from failures gracefully
- [ ] Documentation complete

---

## Implementation Strategy

**Approach:** Incremental, test-driven, always working system.

**Principles:**
1. Each phase delivered independently
2. System always boots and runs (no broken states)
3. New features integrate with existing (no rewrites)
4. Test coverage added with each feature
5. Observability built-in from start

**Daily Workflow:**
1. Implement feature
2. Write tests
3. Verify system still boots
4. Run end-to-end smoke test
5. Commit with descriptive message
6. Update documentation

---

## Success Criteria

**Phase 1 Complete When:**
- Madhurita identity exists in DB
- LLM returns structured decisions
- Cognitive loop stages are discrete code

**Phase 2 Complete When:**
- Events trigger cognition
- Operational awareness maintained
- Proactive cognition decides speak/silent

**Phase 3 Complete When:**
- Tasks execute at scheduled time
- Loops evaluated for relevance
- Execution results logged

**Phase 4 Complete When:**
- Proactive decisions scored
- Timing influences decisions
- Silence occurs naturally

**Phase 5 Complete When:**
- Mistakes detected and learned
- Failures logged and surfaced
- Observability API available

**Phase 6 Complete When:**
- Environment state retrieved
- Weather integrated
- Time context influences cognition

**Phase 7 Complete When:**
- User baselines learned
- Relationships inferred
- Anomalies detected

**Phase 8 Complete When:**
- All 45 requirements verified
- Tests pass
- Documentation complete

---

## Current Status

**Completed (from prior work):**
- Database schema (80%)
- Authentication system (100%)
- Basic cognition engine (60%)
- Memory/pattern storage (80%)
- Cross-user notes (70%)
- Voice integration (80%)
- SSE/WebSocket sync (70%)

**Next Immediate Steps:**
1. Start Phase 1: Madhurita identity system
2. Implement cognitive decision contract
3. Build explicit cognitive loop

**Estimated Total Timeline:** 8 weeks (full-time)  
**Estimated Effort:** 320-400 hours

---

## Risk Mitigation

**Risk:** LLM structured output may be inconsistent  
**Mitigation:** Validate schema, retry with correction on parse failure

**Risk:** Event-driven cognition may cause infinite loops  
**Mitigation:** Rate limiting, event deduplication, max cognition depth

**Risk:** Task executor may miss scheduled times  
**Mitigation:** Multiple scheduler instances, missed-task recovery

**Risk:** Scope creep (specification is large)  
**Mitigation:** Stick to phases, MVP per phase, no feature additions mid-phase

**Risk:** Performance degradation with scale  
**Mitigation:** Early profiling, caching, query optimization, load testing

---

## Decision Log

**Decision 1:** Use two-phase LLM interaction (structured decision first, natural language after)  
**Rationale:** Ensures state mutation based on reasoning, not generated text

**Decision 2:** Build cognitive loop as explicit stages  
**Rationale:** Testability, observability, incremental improvement

**Decision 3:** Event-driven cognition runs in background  
**Rationale:** Proactive behavior requires continuous evaluation, not just chat triggers

**Decision 4:** Task executor runs as scheduled job (cron-like)  
**Rationale:** Separates task definition from execution, reliable scheduling

**Decision 5:** All learning persists to DB immediately  
**Rationale:** No loss of learning on crash/restart

---

## Next Steps

**Immediate (Today):**
1. Review this plan with stakeholders
2. Set up task tracking (if not using Claude tasks)
3. Create Phase 1 implementation branch
4. Begin Phase 1 Task 1: Madhurita identity schema

**Tomorrow:**
1. Implement `MadhuritaIdentity` in DB
2. Add startup identity verification
3. Begin cognitive decision contract schema

**This Week (Phase 1):**
1. Complete Madhurita identity system
2. Complete cognitive decision contract
3. Complete explicit cognitive loop
4. Test Phase 1 deliverables

