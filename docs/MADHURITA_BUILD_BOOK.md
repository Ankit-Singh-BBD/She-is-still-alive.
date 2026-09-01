# MADHURITA — FROM-ZERO PROFESSIONAL REBUILD
## Master Engineering Blueprint & Execution Plan

> **STATUS:** PLAN — NOT IMPLEMENTED
> **AUTHOR:** Master Build Book, generated from the foundation directive.
> **SCOPE:** Complete architectural, behavioral, and operational specification for rebuilding Madhurita from first principles. No code may be written that contradicts this book.

---

## 0. Reading Order & How To Use This Book

This book is split into **28 Parts**. It is intentionally comprehensive and detailed:

- **Architects** start at Parts I–VII (Foundations, Domain Model, Identity, Security, State, Events, Cognition).
- **Backend engineers** start at Parts VIII–XV (Memory, Retrieval, Actions, Tasks, Loops, Learning, Proactivity, Voice).
- **Frontend & realtime engineers** start at Parts XVI–XXII (Voice, Realtime, UI, Visual Language, Advanced Intelligence).
- **Quality engineers** start at Parts XXIII–XXVII (Testing, Performance, Hardening, Rollout).
- **Future agents** read **Part XXVIII — Resume Protocol** first, then read only the parts the protocol points to.

Every Part ends with a **Verification** block. No Part is "done" until its Verification block passes.

### 0.1 Authoritative Document

If any other file (README, plan, design spec, chat message, older markdown) contradicts this Build Book, **this Build Book wins.** The book is the single source of truth for Madhurita's rebuild.

### 0.2 Implementation Prohibition

**No code implementing Madhurita's new architecture may be written until the user explicitly approves this Build Book.** Working legacy code may be patched for stability, but no new domain logic, no new cognitive stages, no new memory tables, no new UI shells, and no new realtime channels may be created.

---

## I. THE PROBLEM (Why We Are Rebuilding)

### I.1 Symptom

The existing Madhurita codebase contains working infrastructure (LLM SDK calls, Web Audio capture, Gemini Live WebSocket, SQLite persistence) but the *application* layer around it has accreted ad-hoc — modules overlap, identity is implicit, memory is a free-form bag, and the cognitive loop is best-effort instead of guaranteed.

### I.2 Root Cause

There is **no single authoritative architecture.** The LLM is treated as the application. State lives in many places, none of which are strictly authoritative. Realtime is a side effect rather than a contract. The user is sometimes the owner, sometimes a guest, sometimes an unauthenticated peer — and the system cannot always tell which.

### I.3 The Cost

- **Unsafe disclosures**: knowledge the system *has* can leak to someone who *should not know it.*
- **Lost continuity**: context the user *did* share can vanish across sessions.
- **Unverifiable execution**: a textual "done" is treated as proof. It is not.
- **Cognitive collapse**: the system has no formal 12-stage loop, so "thinking" is a prompt, not a process.
- **Visual drift**: the orb, the background, and the UI are loosely themed rather than autonomously driven by authoritative state.

### I.4 The Fix

Rebuild Madhurita as a **persistent cognitive agent** with **one identity, one state, one cognition, one persistence, one action pipeline, one realtime flow, one event system, one learning system, and one proactive engine** — all under strict application authority, with the LLM as a reasoning *faculty* but never as the *application.*

---

## II. CORE PHILOSOPHY (The Non-Negotiables)

### II.1 Madhurita Is Not a Chatbot

Madhurita is a **persistent cognitive agent.** She has a continuous existence, a continuous identity, a continuous memory, and a continuous learning trajectory. A conversation is an *event* in her life, not the frame of her existence.

### II.2 The LLM Is a Faculty, Not the Application — LLM Decision vs Application Authority

The LLM performs **semantic reasoning** — interpreting user input, classifying intent, generating strategy, drafting language, extracting candidate memories, proposing proactive candidates, and proposing decisions. The LLM does **not** perform any of the following, ever, unilaterally:

- Identity authentication
- Authorization decisions
- State mutations
- Persistence writes
- Tool execution
- Event emission
- Realtime broadcasting
- Memory storage or retrieval
- Memory disclosure
- Loop management
- Proactivity *authorization*
- Task scheduling
- Verification of action outcomes

All of these are **application responsibilities**, governed by application code that is independently testable, deterministic, and authoritative. The LLM is one reasoning faculty inside the application — the LLM is **not the application**.

**The LLM decision authority model is a fixed ladder, applied everywhere:**

```
LLM DECISION PROPOSAL
        ↓
APPLICATION VALIDATION       (is the proposal well-formed? is it a kind the app recognizes?)
        ↓
APPLICATION AUTHORIZATION    (is the proposal permitted for this caller against this resource?)
        ↓
EXECUTION / RESPONSE / SILENCE
```

If the LLM proposes something invalid or unauthorized, the application **rejects it deterministically.** The LLM has no fallback path. There is no "well, the LLM really wanted to, so let's let it through." Rejection is rejection, with a reason recorded in the audit log.

This ladder applies to:

- **Cognitive Stage 4 (UNDERSTAND)**, **Stage 5 (REASON)**, and **Stage 6 (DECIDE)**: the LLM proposes an understanding, a reasoning trace, and a decision. The application validates that the decision is in the allowed decision set, and authorizes it against the caller's permissions before any state change.
- **Action Pipeline Stage 1 (UNDERSTAND)**, **Stage 2 (PLAN)**: the LLM may propose which tool to call and with what arguments. The application validates the proposal against the tool's Zod schema, and authorizes the call against the caller's permission set.
- **Proactive Engine**: the LLM may propose a proactive candidate. The application runs the deterministic decision tree (urgency, novelty, timing, interruption cost, user context, anti-spam, quiet hours) and authorizes or suppresses.
- **Learning Pipeline**: the LLM may propose memory extractions. The application validates the proposal against the multi-domain schema and the scoped learning policy (see XIII), and only then writes to memory.

### II.3 One Of Everything

| Concept | One Of |
| --- | --- |
| Identity | `Identity` (single object per agent) |
| Application state | `RuntimeState` (single authoritative live projection) |
| Durable state | `PersistenceLayer` (single authoritative durable source) |
| Cognitive runtime | `CognitiveRuntime` (single 12-stage cycle) |
| Persistence | `PersistenceLayer` (one transactional interface) |
| Event system | `EventBus` (one ordered, typed log) |
| Action pipeline | `ActionPipeline` (7 stages) |
| Realtime flow | `RealtimeFlow` (7 ordered stages) |
| Learning system | `LearningSystem` (one pipeline) |
| Proactive engine | `ProactiveEngine` (one decision loop) |

There is exactly one of each. There are no parallel or competing instances. Split-brain state is forbidden (see VI.5).

### II.4 Security Boundary — Knowledge Possession, Retrieval, Disclosure

Madhurita is one agent with one memory. She may internally *possess* knowledge about multiple identities, about people, about facts the owner has not authorized any other person to see. The caller's identity **does not** define what knowledge Madhurita possesses. The caller's identity defines what Madhurita is permitted to *retrieve* and what Madhurita is permitted to *disclose* to them.

The boundary has four distinct layers, applied in order:

1. **Knowledge Possession** — what is currently stored in the durable state, regardless of who is present. Possession is the agent's own; it is not gated by caller.
2. **Knowledge Retrieval Policy** — a deterministic, application-defined policy that decides which subset of possessed knowledge may be *loaded into the cognitive working context* for a given caller. The policy is identity-scoped, domain-scoped, sensitivity-scoped, and provenance-scoped. Retrieval is not the same as disclosure.
3. **Caller-Scoped Working Context** — the actual items loaded into the current cycle's working memory. This is what stage 3 (RECALL) operates on, and what stages 4–9 may see.
4. **Knowledge Disclosure Policy** — a deterministic policy that decides which items in the working context may be *rendered, spoken, or otherwise surfaced* to the current caller. Disclosure is the only step that produces user-visible output. Authorization happens *before* disclosure, not after.

A caller may not gain access to a fact merely because the fact exists in Madhurita's memory. There is no "possession implies disclosure" path. There is no "possession implies retrieval" path. There is no "retrieval implies disclosure" path. Each step is a separate gate.

Madhurita is one agent with one identity and one cognitive runtime. The owner sees what the owner is authorized to see. A known person sees what the person is authorized to see. A guest sees what the system deems safe-by-default. None of these three views are separate "brains" — they are three different *retrieval and disclosure policies* applied to the same single memory.

### II.5 Action Is Proven, Not Claimed

A textual "done" is not proof. Every action goes through:

```
UNDERSTAND → PLAN → AUTHORIZE → EXECUTE → VERIFY → PERSIST → RESPOND
```

- `UNDERSTAND` and `PLAN` are LLM-proposable but the proposal is **validated** by the application against tool schemas and **authorized** against the caller's permissions before EXECUTE.
- `EXECUTE` calls the underlying system with deadlines, retries, and isolation.
- `VERIFY` re-reads authoritative state and asserts the preconditions are now postconditions. A textual claim from the tool is not sufficient.
- `PERSIST` is the only writer to durable state, and is itself a transaction.
- `RESPOND` is the only place user-facing language is generated, and the language is generated by the LLM with **disclosure policy** applied.

### II.6 Realtime Is a Contract

Every state change in Madhurita flows through:

```
MUTATION → PERSISTENCE → DOMAIN EVENT → RUNTIME UPDATE → UI UPDATE → VOICE UPDATE → COGNITIVE UPDATE
```

No mutation may skip a stage. The contract is the contract.

### II.7 Photographic, Not Illustrated

The orb, the background, the atmosphere, and the chrome are **photographic** — real WebGL, real R3F, real shaders, real audio-driven geometry. **No SVG, no illustration, no flat vector, no cartoon** is allowed in the main visual environment, the orb, the atmosphere, the landscape, or any major UI artwork. SVG may only be used for **small functional icons** where geometry is genuinely not applicable.

### II.8 No Mocks for Working Functionality — Real Infrastructure Adapters, Not Legacy Imports

Where real infrastructure is provably working (LLM provider SDK, Gemini Live WebSocket, Web Audio capture/playback, TTS, persistence), the new architecture **interfaces with the real system through a clean adapter** the new architecture owns. A mock is only allowed when the underlying system is provably unavailable, and only with a clearly-marked `// TODO: replace with real adapter` boundary.

Critically, this is **not** permission to import legacy modules into the new architecture. The new architecture owns its adapters. Legacy modules may be inspected as a reference for what the adapter needs to do, but the adapter itself is new code in the new architecture, and the architecture must rebuild correctly with the adapter (and not the legacy module) at runtime.

### II.9 Autonomous Visual State

The orb's colors, the background's atmosphere, the lighting, the rim highlights, and the particle behavior are **derived from authoritative backend state** (time-of-day, weather, voice state, cognitive state). They are not hand-tuned per-screen. The backend is the source; the frontend renders the source faithfully. The UI is never authoritative; the UI is always a projection of authoritative state.

### II.10 No GitHub Operations Without Explicit User Command

The agent **must not** commit, push, open a PR, or create a branch unless the user explicitly says so. This is a hard rule. Working locally is permitted; shipping is not.

### II.11 Application Authority Over LLM Authority — Summary

| Concern | Authority |
| --- | --- |
| Identity authentication | Application |
| Authorization decisions | Application |
| State mutation | Application (LLM may propose) |
| Persistence writes | Application (only the persistence layer) |
| Tool execution | Application (LLM may propose the call) |
| Verification of action outcome | Application |
| Event emission | Application (one ordered, typed log) |
| Realtime broadcasting | Application (7-stage contract) |
| Memory storage | Application (LLM may propose extractions) |
| Memory retrieval policy | Application (LLM never chooses what to retrieve) |
| Memory disclosure policy | Application (LLM never chooses what to disclose) |
| Loop evaluation | Application |
| Proactivity authorization | Application (LLM may propose candidates) |
| Task scheduling | Application |
| Cycle orchestration | Application (LLM is invoked inside stages 4, 5, 6, 9 only) |

The LLM is **always a faculty.** The application is **always the authority.**

---

## III. SYSTEM CONTEXT

### III.1 Actors

| Actor | Description | Authority |
| --- | --- | --- |
| **Owner** | The single human who created this Madhurita instance. | Full authority over their own data, persona, and preferences. |
| **Known Persons** | People the owner has explicitly enrolled (name + relationship + permissions). | Read/access only what the owner has authorized for them. |
| **Guest** | An unauthenticated visitor (e.g. someone the orb is shown to). | Zero authority. Sees only what the system deems safe-by-default. |
| **Madhurita** | The agent herself. | Authority over her own state, memory, and reasoning. |
| **System** | The host application, runtime, and infrastructure. | Authority over identity, authorization, persistence, and execution. |

### III.2 Channels

| Channel | Direction | Latency Target | Protocol |
| --- | --- | --- | --- |
| **Text** | Owner ↔ Madhurita | <300ms keystroke echo | WebSocket / SSE |
| **Voice (live)** | Owner ↔ Madhurita | <200ms audio round-trip | Gemini Live WebSocket |
| **Voice (TTS)** | Madhurita → Owner | <250ms first byte | Backend TTS → AudioStreamer |
| **Realtime state** | Server → Clients | <150ms mutation → UI | SSE / WebSocket fan-out |
| **Background tasks** | Madhurita → System | n/a | Internal async queue |
| **Owner commands** | Owner → System | <500ms ack | HTTP + WebSocket |

### III.3 Environments

| Environment | Purpose | Data |
| --- | --- | --- |
| **Local dev** | Implementation, debugging, manual verification | Fresh DB per clone |
| **Staging** | Integration tests, pre-prod soak | Seeded realistic data |
| **Production** | Owner's daily use | Real owner data, backed up |

---

## IV. ARCHITECTURE (The One Picture)

### IV.1 Layered Topology

```mermaid
flowchart TB
  subgraph Frontend [Frontend: React + R3F]
    UI[UI Shell]
    Orb[Madhurita Orb - R3F + WebGL]
    BG[Background Atmosphere - Photographic]
    Client[Live Client - Web Audio + WebSocket]
  end

  subgraph Edge [Edge: API + Realtime]
    API[HTTP API]
    SSE[SSE Realtime Channel]
    LWS[Gemini Live WebSocket Bridge]
  end

  subgraph App [Application: Authoritative Core]
    Auth[Identity & AuthZ]
    Runtime[RuntimeState]
    Cog[Cognitive Runtime - 12 stages]
    Mem[Memory System - Multi-Domain]
    Act[Action Pipeline - 7 stages]
    Ev[Event Bus]
    RT[Realtime Flow]
    Pro[Proactive Engine]
    Lrn[Learning System]
    Loop[Loop Manager]
    Tasks[Task Executor]
    Tools[Tool Adapters]
  end

  subgraph Foundation [Foundation]
    DB[(Persistence - SQLite + WAL)]
    LLM[LLM Faculty - Gemini]
    TTS[TTS / Audio Player]
    WX[Weather Service]
    Time[Time-of-Day Service]
  end

  UI -->|commands| API
  Orb -->|audio + state| Client
  Client <-->|bidirectional| LWS
  API --> Auth
  API --> Runtime
  SSE --> RT
  LWS --> Client
  Runtime --> Cog
  Cog --> Act
  Cog --> Mem
  Act --> Tools
  Act --> Ev
  Ev --> RT
  RT --> SSE
  SSE --> UI
  SSE --> Orb
  SSE --> BG
  Tools --> DB
  Mem --> DB
  Runtime --> DB
  Pro --> Cog
  Lrn --> Mem
  Lrn --> Runtime
  Loop --> Tasks
```

### IV.2 Authority Direction

The frontend **requests.** The application **decides.** The persistence **records.** The realtime **broadcasts.** The frontend **renders.** The cognitive runtime **reflects.** This direction is non-negotiable.

### IV.3 What Runs Where

| Layer | Process | Restartable Independently | State |
| --- | --- | --- | --- |
| **Frontend** | Browser | Yes (page reload) | Stateless except cache |
| **Edge API** | Node process | Yes | Stateless except SSE subscribers |
| **Application Core** | Node process | Yes (in-memory runtime) | Authoritative |
| **Persistence** | SQLite (embedded) | With application | Authoritative |
| **Realtime Fanout** | In-process pub/sub | With edge | Ephemeral |
| **LLM Faculty** | External (Gemini) | Provider-controlled | Provider |

---

## V. IDENTITY & AUTHENTICATION

### V.1 Identity Object

```ts
interface Identity {
  id: string;                  // stable ULID
  kind: 'owner' | 'person' | 'guest';
  displayName: string;
  preferredName?: string;
  relationshipToOwner?: 'self' | 'spouse' | 'child' | 'parent' | 'friend' | 'colleague' | 'other';
  permissions: PermissionSet;
  enrolledAt: number;
  lastSeenAt: number;
  status: 'active' | 'dormant' | 'revoked';
}
```

### V.2 Permission Set

```ts
interface PermissionSet {
  mayReadMemories: boolean;
  mayReadConversations: boolean;
  mayTriggerActions: 'none' | 'safe' | 'all';
  mayEnrollNewKnowledge: boolean;
  mayMutatePreferences: boolean;
  mayAccessTools: ToolId[];
  mayBeHeardInVoice: boolean;
  mayReceiveProactiveMessages: boolean;
}
```

### V.3 Authentication

| Mode | Mechanism | Lifetime |
| --- | --- | --- |
| **Owner bootstrap** | First-run setup (passphrase + recovery code) | Single-use bootstrap, then replaces with session |
| **Owner session** | Passphrase → KDF → key → session token (signed) | 12h sliding, refresh on activity |
| **Person session** | Owner-initiated enrollment → person-local PIN | 30 days, revocable |
| **Guest** | No credentials, ephemeral session id | 30 minutes, read-only safe mode |

### V.4 Authorization

Every action — read, write, execute, broadcast — passes through `authz.check(caller, action, resource)`. The function is pure, deterministic, and side-effect-free. The result is logged to the event bus.

### V.5 Bootstrap Invariant

The first time a Madhurita instance starts, there is **no owner.** The first human to interact becomes the owner via a deterministic bootstrap ceremony. No other path to ownership exists. There is exactly one owner per instance.

---

## VI. STATE

### VI.1 State Architecture — Durable State, Runtime State, Realtime Projection

The state architecture has exactly **one authoritative durable source** and **one authoritative live projection**:

```
SQLite / Persistence (Authoritative Durable Source of Truth)
        ↓
Application Memory (Authoritative Durable State - in-process)
        ↓
RuntimeState (Authoritative Live Projection - single instance per identity)
        ↓
Realtime Projection (broadcast via 7-stage Realtime Flow)
        ↓
UI / Voice Clients (render the projection)
```

- **SQLite / Persistence** is the **only** durable source of truth. It survives process restarts. It is never bypassed.
- **Application Memory** is the in-process authoritative state held by the application core. It is reconstructed from the durable source on startup and updated by transactions.
- **RuntimeState** is the single authoritative live projection. There is exactly one `RuntimeState` per identity. It is the only state the cognitive runtime reads from. It is the only state the realtime flow broadcasts.
- **Realtime Projection** is the broadcast of `RuntimeState` changes to connected clients via the 7-stage realtime contract (Part XVI).
- **UI / Voice** are never authoritative. They render what the realtime projection delivers. The LLM is never authoritative.

There is no parallel state store. There is no "UI state" that competes with RuntimeState. There is no "session state" that diverges. Split-brain state is forbidden.

### VI.2 RuntimeState — The One Live Projection

```ts
interface RuntimeState {
  version: number;                // schema version, monotonic
  identity: Identity;
  presence: PresenceState;
  environment: EnvironmentState;
  cognitive: CognitiveState;
  voice: VoiceState;
  memory: MemorySummary;
  loops: LoopSummary;
  tasks: TaskSummary;
  pendingActions: PendingAction[];
  lastMutation: MutationRecord;
}
```

`RuntimeState` is the single authoritative live projection. Every other component reads from it. Only the application runtime mutates it. Every mutation goes through the realtime flow contract.

### VI.3 Sub-States

```ts
interface PresenceState {
  activeActor: IdentityId | null;
  recentActors: IdentityId[];      // bounded LRU
  sessionStartedAt: number;
}

interface EnvironmentState {
  timeOfDay: 'night' | 'sunrise' | 'day' | 'sunset';
  weather: WeatherSnapshot;
  location: GeoSnapshot;
  derivedPalette: PaletteSpec;     // computed, not stored
}

interface CognitiveState {
  currentStage: CognitiveStage;   // PERCEIVE..PERSIST
  cycleId: ULID;
  cycleStartedAt: number;
  lastCompletedStage: CognitiveStage;
  attention: AttentionVector;
}

interface VoiceState {
  live: 'disconnected' | 'connecting' | 'listening' | 'speaking' | 'thinking' | 'error';
  energy: number;                 // 0..1, RMS of mic
  ttsEnergy: number;              // 0..1, RMS of TTS playback
  frequencyBands: number[];       // 8 bands, 0..1
  voiceId: string;
}

interface MemorySummary {
  episodicCount: number;
  semanticCount: number;
  preferenceCount: number;
  habitCount: number;
  relationshipCount: number;
  learnedPatternCount: number;
  lastConsolidationAt: number;
}
```

### VI.4 Mutation Discipline

```mermaid
flowchart LR
  Caller[Caller] -->|intent| Mut[Mutation Handler]
  Mut -->|assert| Authz[AuthZ]
  Mut -->|propose| Plan[Proposed Mutation]
  Plan -->|apply| Persist[(Persistence - SQLite)]
  Persist -->|domain event| Ev[Event Bus]
  Ev -->|recompute| Runtime[RuntimeState]
  Runtime -->|broadcast| RT[Realtime Flow]
  RT --> SSE --> UI[UI]
  RT --> Cog[Cognitive Runtime]
```

No path from `Caller` to `UI` that bypasses `Persist` is allowed. The frontend never receives a state change that the persistence layer hasn't already recorded.

### VI.5 Optimistic Concurrency and Split-Brain Prevention

- Every `RuntimeState` version increments atomically. Clients receiving state use the version to detect missed updates. On conflict, client requests a snapshot. No silent merges.
- **Split-brain is forbidden**: there is exactly one `RuntimeState` instance per identity, owned by the application core. The UI cannot mutate it. The LLM cannot mutate it. No other process holds a copy. Any component that needs state reads from `RuntimeState` or subscribes to the realtime projection.

### VI.6 Durable State Reconstruction

On application startup:
1. The persistence layer opens the SQLite database.
2. The authoritative durable state is reconstructed from the `domain_event` log (replay) or from a snapshot + tail (configurable).
3. `RuntimeState` is initialized from the authoritative durable state.
4. The cognitive runtime begins accepting new cycles.
5. Realtime flow begins broadcasting from the current `RuntimeState`.

This reconstruction is deterministic and repeatable. No application code may depend on in-memory state that is not in the durable event log.

---

## VII. COGNITIVE RUNTIME (The 12-Stage Cycle)

### VII.1 Stages

```mermaid
flowchart LR
  P1[1. PERCEIVE] --> P2[2. IDENTIFY]
  P2 --> P3[3. RECALL]
  P3 --> P4[4. UNDERSTAND - LLM Proposal]
  P4 --> P5[5. REASON - LLM Trace]
  P6_0[App Validation & Authz]
  P5 --> P6[6. DECIDE - LLM Proposal]
  P6 --> P6_0
  P6_0 --> P7[7. ACT - Action Pipeline]
  P7 --> P8[8. VERIFY - App State Re-read]
  P8 --> P9[9. RESPOND - LLM Draft with Disclosure Policy]
  P9 --> P10[10. LEARN - LLM Extraction Proposal + App Scoped Policy]
  P10 --> P11[11. UPDATE - App Mutator]
  P11 --> P12[12. PERSIST - SQLite Transaction]
  P12 -. next cycle .-> P1
```

| # | Stage | Authority | Responsibility | Output |
| --- | --- | --- | --- | --- |
| 1 | **PERCEIVE** | Application | Receive input (text, audio, system event, proactive trigger). | `RawStimulus` |
| 2 | **IDENTIFY** | Application | Authenticate caller, classify input type, attach context. | `IdentifiedStimulus` |
| 3 | **RECALL** | Application | Apply **Knowledge Retrieval Policy**; load caller-scoped working context (episodic, semantic, preferences, relationships). | `RecalledContext` |
| 4 | **UNDERSTAND** | LLM (Faculty) | LLM proposes interpretation of intent, disambiguates, asks clarifying questions if needed. | `UnderstandingProposal` |
| 5 | **REASON** | LLM (Faculty) | LLM proposes reasoning trace, evaluates options, weighs constraints. | `ReasoningTraceProposal` |
| 6 | **DECIDE** | LLM (Faculty) → Application | LLM proposes a course of action. **Application validates the proposal** (is it well-formed? recognized?) and **authorizes the proposal** against caller permissions. If invalid/unauthorized, application rejects and forces a safe fallback (e.g. clarification, refusal, silence). | `AuthorizedDecision` |
| 7 | **ACT** | Application | Action pipeline executes the authorized decision (if it includes an action). | `ActionResult` |
| 8 | **VERIFY** | Application | Re-read authoritative state, assert preconditions are now postconditions. | `VerificationReport` |
| 9 | **RESPOND** | LLM (Faculty) → Application | LLM drafts user-facing language (text and/or voice); **Application applies Knowledge Disclosure Policy** before output escapes to the caller. | `AuthorizedResponse` |
| 10 | **LEARN** | LLM (Faculty) → Application | LLM proposes candidate memories (preferences, habits, patterns); **Application applies Scoped Learning Policy** (see Part XIII) to decide what may be stored and with what scope. | `AuthorizedLearningDelta` |
| 11 | **UPDATE** | Application | Apply authorized learning delta to in-process state and memory tables. | `UpdateResult` |
| 12 | **PERSIST** | Application | Commit cycle artifacts, domain events, and audit log to durable storage in a single transaction. | `CycleRecord` |

### VII.2 Stage Contracts and LLM Proposal Boundary

Each stage is a **pure function** that takes its input and produces its output. Stages are orchestrated strictly by the `CognitiveRuntime`, which is the only place stage transitions are decided.

The LLM is invoked inside stages 4, 5, 6, 9, and 10 as a **reasoning faculty only**:
- In **Stage 4 (UNDERSTAND)**: LLM proposes an understanding. The application confirms the output matches the expected JSON schema.
- In **Stage 5 (REASON)**: LLM proposes a reasoning trace. The application validates the structure.
- In **Stage 6 (DECIDE)**: LLM proposes a `DecisionProposal`. The **application validates and authorizes** the proposal. The LLM cannot unilaterally execute a tool, write memory, or bypass permissions.
- In **Stage 9 (RESPOND)**: LLM drafts language. The **application runs the Knowledge Disclosure Policy** on the draft to ensure no unauthorized facts, system internals, or unverified claims are disclosed.
- In **Stage 10 (LEARN)**: LLM proposes extracted memories. The **application applies Scoped Learning Policy** to filter, score, deduplicate, and assign identity scope and sensitivity before writing.

The LLM is never the orchestrator. The LLM cannot transition to a next stage on its own, cannot skip a stage, and cannot suppress a stage.

### VII.3 Cycle Boundaries

A cycle is **one full pass** of all 12 stages. Cycles are independent. The runtime may run cycles concurrently for *different* identities, but never concurrently for the same identity (single-threaded per identity to preserve causal order).

### VII.4 Cycle Record

Every completed cycle produces a `CycleRecord` persisted to storage:

```ts
interface CycleRecord {
  id: ULID;
  identityId: IdentityId;
  startedAt: number;
  completedAt: number;
  stages: StageTrace[];           // 12 entries
  proposedDecision: DecisionProposal;
  authorizedDecision: AuthorizedDecision;
  response?: AuthorizedResponse;
  actionResults?: ActionResult[];
  learningDelta?: AuthorizedLearningDelta;
  status: 'completed' | 'interrupted' | 'failed';
}
```

### VII.5 Interruption

A new PERCEIVE for the same identity **interrupts** the current cycle. The interruption:

1. Marks the current cycle as `interrupted` (stages 1-N completed, stages N+1..12 cancelled).
2. Records the interrupting stimulus.
3. Begins a new cycle from PERCEIVE.

The cancellation is recorded in the durable log, never silently dropped. If stage 7 (ACT) was in-flight when the interruption arrived, the action is allowed to complete its verify/persist/rollback before the new cycle begins, preserving transactional integrity.

### VII.6 Verification

- A unit test exists for every stage.
- A property test asserts that for any input, exactly one of stage 1, 2, ..., 12 is the "last completed" stage.
- An integration test asserts that two interleaved cycles for the same identity are serialized.
- A chaos test asserts that mid-cycle crashes produce a recoverable `CycleRecord` with `status: 'interrupted'`.
- A security test asserts that an unauthorized LLM decision proposal is rejected deterministically by stage 6 application validation without executing the requested tool or mutating state.
- A security test asserts that Knowledge Disclosure Policy in stage 9 prevents disclosure of facts loaded into working context that are marked non-disclosable to the current caller.

---

## VIII. EVENT SYSTEM

### VIII.1 Event Taxonomy

```mermaid
flowchart TB
  Ev[Event] --> Dom[Domain Events]
  Ev --> Sys[System Events]
  Ev --> Cog[Cognitive Events]
  Ev --> Voi[Voice Events]
  Ev --> Pro[Proactive Events]
  Ev --> UI[UI Events]

  Dom --> D1[memory.appended]
  Dom --> D2[memory.consolidated]
  Dom --> D3[task.scheduled]
  Dom --> D4[task.completed]
  Dom --> D5[action.executed]
  Dom --> D6[action.failed]
  Dom --> D7[identity.enrolled]
  Dom --> D8[identity.revoked]

  Sys --> S1[boot.completed]
  Sys --> S2[config.changed]
  Sys --> S3[backup.completed]
  Sys --> S4[error.raised]

  Cog --> C1[cycle.started]
  Cog --> C2[cycle.stage.completed]
  Cog --> C3[cycle.completed]
  Cog --> C4[cycle.interrupted]

  Voi --> V1[session.connected]
  Voi --> V2[session.disconnected]
  Voi --> V3[audio.frame]

  Pro --> P1[proactive.decision]
  Pro --> P2[proactive.delivered]
  Pro --> P3[proactive.suppressed]
```

### VIII.2 Event Shape

```ts
interface DomainEvent<T extends string, P> {
  id: ULID;
  type: T;
  payload: P;
  identityId?: IdentityId;
  cycleId?: ULID;
  timestamp: number;
  causationId?: ULID;            // the event that caused this one
  correlationId?: ULID;          // the broader workflow
  version: number;
}
```

### VIII.3 Guarantees

- **Ordered**: events are appended in causal order, indexed by sequence number.
- **Durable**: events are persisted before any handler runs.
- **Replayable**: a fresh subscriber can replay from any sequence number.
- **Typed**: every event has a TypeScript type; untyped events are rejected at the boundary.
- **Bounded**: handlers run with deadlines; slow handlers don't block the bus.

### VIII.4 Verification

- A test asserts that every mutation produces exactly one domain event before any consumer sees it.
- A test asserts that the event log is replayable: a new subscriber reading from sequence 0 reaches the same state.
- A test asserts that handlers failing past their deadline do not block the bus.

---

## IX. PERSISTENCE

### IX.1 Why SQLite

- Embedded, single-file, transactional, WAL-mode for concurrent readers.
- Deterministic, debuggable, easy to back up.
- Sufficient for one owner's lifetime of memory (years of episodic entries).
- No external service to fail.

### IX.2 Schema (Multi-Domain, Not One Blob)

The persistence layer has **one table per domain**, never a single key-value bag.

```mermaid
erDiagram
  IDENTITY ||--o{ SESSION : has
  IDENTITY ||--o{ PERMISSION : has
  IDENTITY ||--o{ CONVERSATION : participates
  CONVERSATION ||--o{ MESSAGE : contains
  CONVERSATION ||--o{ CYCLE_RECORD : produces
  CYCLE_RECORD ||--o{ STAGE_TRACE : contains
  CYCLE_RECORD ||--o{ ACTION_RESULT : produces
  IDENTITY ||--o{ EPISODIC_MEMORY : owns
  IDENTITY ||--o{ SEMANTIC_MEMORY : owns
  IDENTITY ||--o{ PREFERENCE : owns
  IDENTITY ||--o{ HABIT : owns
  IDENTITY ||--o{ RELATIONSHIP : owns
  IDENTITY ||--o{ LEARNED_PATTERN : owns
  IDENTITY ||--o{ TASK : owns
  IDENTITY ||--o{ OPEN_LOOP : owns
  IDENTITY ||--o{ PROACTIVE_DECISION : owns
  IDENTITY ||--o{ AUDIT_LOG : owns
  DOMAIN_EVENT }o--o{ IDENTITY : involves
```

### IX.3 Tables (Authoritative Schema)

| Table | Purpose | Key Columns |
| --- | --- | --- |
| `identity` | One row per known person (owner + enrolled + revoked). | `id`, `kind`, `display_name`, `relationship`, `status`, `enrolled_at` |
| `permission` | Per-identity permission set, versioned. | `identity_id`, `version`, `json`, `effective_from` |
| `session` | Active sessions, refreshable. | `id`, `identity_id`, `issued_at`, `expires_at`, `revoked_at` |
| `conversation` | One row per conversation (voice or text). | `id`, `identity_id`, `started_at`, `ended_at`, `channel` |
| `message` | One row per message. | `id`, `conversation_id`, `role`, `text`, `audio_ref`, `timestamp` |
| `cycle_record` | One row per cognitive cycle. | `id`, `conversation_id`, `started_at`, `completed_at`, `status` |
| `stage_trace` | One row per stage per cycle. | `cycle_id`, `stage`, `started_at`, `completed_at`, `output_json` |
| `action_result` | One row per action execution. | `id`, `cycle_id`, `tool_id`, `input_json`, `output_json`, `verified`, `persisted_at` |
| `episodic_memory` | Time-stamped memories of events. | `id`, `identity_id`, `summary`, `embedding`, `occurred_at`, `importance` |
| `semantic_memory` | Distilled facts. | `id`, `identity_id`, `subject`, `predicate`, `object`, `confidence`, `source_cycle` |
| `preference` | User-stated preferences. | `id`, `identity_id`, `key`, `value`, `stated_at`, `confidence` |
| `habit` | Inferred habits (recurring patterns). | `id`, `identity_id`, `pattern`, `frequency`, `last_observed` |
| `relationship` | People known to the owner. | `id`, `owner_id`, `name`, `relation`, `notes`, `importance` |
| `learned_pattern` | Behavioral patterns Madhurita has inferred. | `id`, `identity_id`, `pattern`, `evidence_count`, `confidence` |
| `task` | Scheduled or one-shot tasks. | `id`, `identity_id`, `kind`, `payload`, `due_at`, `status` |
| `open_loop` | Unfinished threads Madhurita is tracking. | `id`, `identity_id`, `topic`, `opened_at`, `last_progress` |
| `proactive_decision` | Record of proactive reasoning. | `id`, `identity_id`, `decision`, `urgency`, `novelty`, `interruption_cost`, `acted_at` |
| `audit_log` | All auth, mutation, and disclosure events. | `id`, `actor_id`, `action`, `resource`, `decision`, `timestamp` |
| `domain_event` | Append-only event log. | `seq`, `id`, `type`, `payload_json`, `identity_id`, `cycle_id`, `timestamp` |
| `backup_metadata` | Backup snapshots. | `id`, `created_at`, `sha256`, `size_bytes`, `restored_from` |

### IX.4 Embedding Strategy

- Embeddings are stored alongside episodic and semantic rows in a separate column.
- A simple `embedding` table is avoided; embedding lives with the row.
- Embedding model is configurable; default to the LLM provider's embedding endpoint.

### IX.5 Transactions

Every mutation is a transaction. Transactions include:

- All table writes for the mutation.
- The corresponding `domain_event` append.
- The `audit_log` row.

If any step fails, the transaction rolls back. The system never has a partial state.

### IX.6 Deletion Safety

- Soft delete by default (`deleted_at` column where relevant).
- `audit_log` is never soft-deleted.
- A "Bin" view shows soft-deleted items, with owner-only restore.
- A separate "hard delete" operation exists for explicit, multi-step, confirmed removal.
- A "memory provenance" record tracks which memories derive from which conversation/event.

### IX.7 Verification

- A test asserts that every mutation is atomic (no partial state after crash injection).
- A test asserts that soft-deleted items are excluded from all retrieval paths.
- A test asserts that the audit log cannot be silently altered (write-once semantics).

---

## X. MEMORY SYSTEM

### X.1 The Multi-Domain Principle

There is **no single generic "memories" bag.** Memory is partitioned by *kind*, because each kind has different shape, lifecycle, retrieval semantics, and sensitivity rules:

| Domain | Lifetime | Retrieval Trigger | Update Cadence | Sensitivity Default |
| --- | --- | --- | --- | --- |
| **Raw conversation** | Permanent | Always available to its identity | Append-only | Identity-private |
| **Episodic** | Long | Time-based, similarity | Consolidated periodically | Identity-private |
| **Semantic** | Long | Subject lookup, similarity | Updated on new evidence | Scoped by subject |
| **Preferences** | Long | Always | Updated on user statement | Identity-private |
| **Habits** | Long | Pattern detection | Updated on observation | Identity-private |
| **Relationships** | Long | Identity resolution | Updated on new info | Owner-private |
| **Learned patterns** | Long | Behavioral inference | Updated on consolidation | Scoped by subject |

Every memory row, regardless of domain, carries the **common memory header**:

```ts
interface MemoryItemHeader {
  id: ULID;
  identityId: IdentityId;          // subject / owner of this memory
  subjectKind: 'owner' | 'person' | 'guest' | 'system';
  sensitivity: 'public' | 'person_shared' | 'owner_only' | 'system_internal';
  confidence: number;              // 0..1
  sourceKind: 'conversation' | 'action' | 'observation' | 'system';
  provenance: MemoryProvenance;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;              // optional TTL
  lifecycleStatus: 'active' | 'consolidated' | 'archived' | 'soft_deleted';
  deletedAt?: number;
  deletedBy?: IdentityId;
}
```

### X.2 Memory Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Raw: conversation captured
  Raw --> Episodic: LEARN stage extracts episodes (with provenance)
  Episodic --> Semantic: consolidation distills facts (with provenance)
  Semantic --> Pattern: consolidation finds patterns
  Pattern --> Habit: repeated pattern crystallizes
  Habit --> [*]
  Semantic --> [*]
  Episodic --> [*]
  Raw --> [*]
  Pattern --> [*]
  Habit --> [*]
  state SoftDeleted {
    [*] --> InBin: soft_delete()
    InBin --> Active: restore() (owner only)
    InBin --> HardDeleted: purge() (owner multi-step confirmed)
  }
```

### X.3 Retrieval — Knowledge Retrieval Policy and Caller-Scoped Working Context

Retrieval is **never an unconstrained query against all memory.** Retrieval is mediated by the **Knowledge Retrieval Policy**, which is entirely application-defined and deterministic. The LLM never performs retrieval directly and never sees raw memory rows.

```
Caller Identity + Permissions
        ↓
KNOWLEDGE RETRIEVAL POLICY (application-defined, deterministic)
        ↓
Identity-Scoped + Domain-Scoped + Sensitivity-Filtered DB Query
        ↓
Ranking (recency + importance + similarity)
        ↓
CALLER-SCOPED WORKING CONTEXT (projected into LLM context in Stage 3)
```

```ts
interface RetrievalRequest {
  callerId: IdentityId;
  callerKind: 'owner' | 'person' | 'guest';
  query: string;                  // natural language or structured
  domains: MemoryDomain[];        // which memory kinds to search
  limit: number;
  recencyWeight: number;          // 0..1
  importanceWeight: number;       // 0..1
  similarityWeight: number;       // 0..1
  excludeSoftDeleted: boolean;    // default true
}

interface RetrievalResult {
  items: ScopedMemoryItem[];      // ranked and filtered by policy
  total: number;
  took: number;                   // ms
  fromCache: boolean;
}
```

The Knowledge Retrieval Policy enforces three mandatory constraints:

1. **Identity Isolation**: A guest's retrieval request never returns owner memories, owner preferences, or records about other persons.
2. **Sensitivity Gates**: Items marked `owner_only` are only retrieved when `callerKind === 'owner'`.
3. **Soft-Delete Exclusion**: Items with `lifecycleStatus === 'soft_deleted'` are excluded from all routine retrieval paths.

### X.4 Knowledge Disclosure Policy

Even after an item is loaded into the caller-scoped working context, it is not automatically permitted to appear in Madhurita's output. In Stage 9 (RESPOND), the **Knowledge Disclosure Policy** evaluates the LLM-drafted response before delivery:

1. Every referenced entity, fact, and preference is checked against the caller's permission set.
2. If an unauthorized fact is present in the draft, the application replaces it with a safe generalization or redacts it before output.
3. All disclosures are recorded in the `audit_log`.

The LLM drafts the response; the application applies the disclosure gate. The LLM does not apply the gate itself. The application's disclosure check is mandatory and cannot be bypassed.

### X.5 Memory Provenance

Every memory item carries a durable, auditable chain of evidence:

```ts
interface MemoryProvenance {
  sourceCycleId: ULID;
  sourceConversationId: ULID;
  sourceMessageIds: ULID[];
  extractedAt: number;
  extractor: 'rule' | 'llm';
  confidence: number;
  validatedBy: 'app_rule' | 'owner_confirmation' | 'auto_policy';
}
```

No memory is stored without provenance. Provenance is the chain that lets the owner audit, correct, or delete. When extractor is `'llm'`, that means the LLM *proposed* the memory extraction; the application validated the proposal against policy (`validatedBy`) before writing. The LLM may not write memories directly.

### X.6 Verification

- A test asserts that retrieval by a guest never returns owner memories.
- A test asserts that retrieval by a known person returns only items authorized for their relationship and sensitivity level.
- A test asserts that provenance is present on every memory item in every domain.
- A test asserts that soft-deleted memories are invisible to retrieval.
- A test asserts that the Knowledge Disclosure Policy blocks output of owner-only facts even when they were present in working context.
- A test asserts that the LLM extraction proposal path writes nothing to the DB before application validation completes.

---

## XI. ACTION PIPELINE (The 7 Stages)

### XI.1 Stages

```mermaid
flowchart LR
  A1[1. UNDERSTAND] --> A2[2. PLAN]
  A2 --> A3[3. AUTHORIZE]
  A3 --> A4[4. EXECUTE]
  A4 --> A5[5. VERIFY]
  A5 --> A6[6. PERSIST]
  A6 --> A7[7. RESPOND]
```

| # | Stage | Responsibility | Failure Mode | Authority |
|---|-------|----------------|--------------|-----------|
| 1 | **UNDERSTAND** | Parse the action request, identify the tool needed, classify parameters. **LLM may propose the understanding; application validates and authorizes.** | Reject as "malformed" | LLM Faculty → Application |
| 2 | **PLAN** | Construct the call graph: which tool, in what order, with which parameters. **LLM may propose the plan; application validates and authorizes.** | Reject as "unplannable" | LLM Faculty → Application |
| 3 | **AUTHORIZE** | Application enforces `authz.check(identity, tool, params)` against caller permissions. No LLM role. | Reject as "unauthorized" | Application |
| 4 | **EXECUTE** | Run the tool, with deadlines, retries bounded. Application executes; LLM does not execute tools. | Reject as "execution failed" | Application |
| 5 | **VERIFY** | Re-read authoritative state, assert the preconditions are now postconditions. Application performs verification; LLM does not verify. | Reject as "unverified" | Application |
| 6 | **PERSIST** | Write `action_result` row, emit `action.executed` domain event. Application persists; LLM does not persist. | Roll back the tool if possible | Application |
| 7 | **RESPOND** | Generate the user-facing language describing the result. **LLM drafts the response; application applies Knowledge Disclosure Policy and authorizes output.** | Surface error plainly | LLM Faculty → Application |

**Critical principle**: The LLM is a reasoning faculty in stages 1, 2, and 7. The LLM **proposes** understanding, plans, and response drafts. The **application validates and authorizes** every LLM proposal before it takes effect. The LLM never unilaterally transitions to the next stage, never skips a stage, and never suppresses a stage.

### XI.2 Tool Registry

```ts
interface ToolDefinition {
  id: ToolId;
  description: string;
  inputSchema: ZodSchema;
  outputSchema: ZodSchema;
  requiredPermissions: PermissionId[];
  sideEffects: 'none' | 'read' | 'write' | 'external';
  maxRetries: number;
  timeoutMs: number;
}

interface ToolContext {
  identityId: IdentityId;
  cycleId: ULID;
  causationId: ULID;
}
```

### XI.3 Verification Is Mandatory

A textual "done" is never proof. The VERIFY stage **must** re-read authoritative state (RuntimeState → SQLite) and assert that the intended change occurred. If VERIFY fails, the action is **not** considered successful — it is rolled back where possible, and the failure is recorded in the `action_result` table with `verified: false`. The user is never told an action succeeded unless VERIFY passed.

### XI.4 Verification

- A test asserts that for every action, VERIFY either confirms the postcondition or rolls back.
- A test asserts that unverified actions are never surfaced as success to the user.
- A test asserts that an `EXECUTE` that crashes mid-call leaves no orphaned state.
- A test asserts that an LLM-proposed UNDERSTAND or PLAN that is invalid or unauthorized is rejected by the application before AUTHORIZE.
- A test asserts that an LLM-drafted RESPONSE that fails the Knowledge Disclosure Policy is redacted or generalized before output.

---

## XII. TASKS & LOOPS

### XII.1 Tasks

A task is **durable, scheduled, executable work** that may outlive a single conversation.

```ts
interface Task {
  id: ULID;
  identityId: IdentityId;
  kind: 'reminder' | 'recurring' | 'one_shot' | 'background';
  payload: TaskPayload;
  schedule: TaskSchedule;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  dueAt?: number;
  lastRunAt?: number;
  nextRunAt?: number;
  attempt: number;
  maxAttempts: number;
}
```

### XII.2 Loop Manager

A loop is a **long-running intent** the owner has placed on Madhurita. Examples:

- "Track my sleep and remind me if I sleep under 6 hours for three nights."
- "Keep an eye on weather and warn me before it rains."

Loops are not tasks; they are *generators* of tasks.

```ts
interface OpenLoop {
  id: ULID;
  identityId: IdentityId;
  topic: string;
  triggerSpec: TriggerSpec;
  actionSpec: ActionSpec;
  status: 'active' | 'paused' | 'closed';
  openedAt: number;
  lastEvaluatedAt: number;
  lastProgressAt: number;
}
```

### XII.3 Evaluation

The `LoopManager` evaluates every active loop:

- On every relevant domain event.
- On every environmental change.
- On a periodic tick (default 15 minutes).

Each evaluation produces a `LoopEvaluation` record; if it decides action is needed, it creates a `Task`.

### XII.4 Verification

- A test asserts that a loop's evaluation never produces duplicate tasks for the same condition.
- A test asserts that closed loops do not produce tasks.
- A test asserts that loops respect the owner's notification preferences.

---

## XIII. LEARNING SYSTEM

### XIII.1 What Learning Is

Learning is the **deliberate extraction of memory from cycles.** It is not the LLM continuing a conversation; it is the application observing what happened and writing structured knowledge back to memory. The LLM may propose extractions, but the application validates, scores, dedupes, limits, and records provenance.

### XIII.2 Pipeline

```mermaid
flowchart LR
  Cycle[Cycle Record] --> Extract[LLM Extraction Proposal]
  Extract -->|candidates| Verify[Application Scoped Policy]
  Verify --> Score[Score by Importance & Confidence]
  Score -->|above threshold| Dedupe[Dedupe against existing memory]
  Dedupe -->|new| Persist[(Application DB Write)]
  Dedupe -->|update| Update[Update existing memory]
  Persist --> Prov[Provenance linkage]
  Update --> Prov
  Prov --> Audit[Audit log entry]
```

### XIII.3 What Gets Learned

| Trigger | Learned Kind |
| --- | --- |
| User says "I love jazz" | `preference` |
| User asks about project X three times this week | `learned_pattern` (interest in X) |
| User corrects Madhurita | `preference` (correction captured) |
| User mentions a person by name and relationship | `relationship` |
| Repeated behavior over 7+ days | `habit` |
| Generalizable fact about the user's life | `semantic` |
| A specific moment in time | `episodic` |

### XIII.4 Scoped Guest Learning Policy (What Does Not Get Learned)

Madhurita does **not** implement a blanket "guests teach nothing" rule, nor does she silently convert guest conversation into owner memory. Instead, guest-originated information is evaluated by the **Scoped Guest Learning Policy**:

| Information Subject | Application Policy Outcome |
|---------------------|----------------------------|
| Small talk / idle context | Transient only, discarded after session. |
| Guest's own preferences | Saved as Guest-scoped `preference`. Completely isolated from Owner. |
| General behavioral patterns | May be saved as `learned_pattern` (e.g. "guests often ask X"). |
| Information about the Owner | **Quarantine**: Saved as `unverified_semantic` with Guest provenance. Owner confirmation is required before it becomes general memory. |
| Sensitive/Private | Discarded unless explicitly authorized. |

The LLM proposes the extraction; the application evaluates the caller identity, the subject of the memory, and the sensitivity, then applies the mandatory policy.

Regardless of identity:
- Transient emotional state is never learned as permanent memory.
- Unverified claims about third parties are discarded.
- Anything the owner later marks as wrong or soft-deletes is removed.

### XIII.5 Verification

- A test asserts that every learned item carries a `MemoryProvenance` linking back to the extracting cycle.
- A test asserts that guest-originated information about the Owner is never written to public/owner memory without owner confirmation.
- A test asserts that a guest's own preferences are isolated and never returned in an Owner-scoped retrieval query.
- A test asserts that user corrections create preference updates with high confidence.
- A test asserts that the LLM cannot bypass the Dedupe or Scoped Guest Learning Policy stages.

---

## XIV. PROACTIVE ENGINE

### XIV.1 The Proactivity Decision

Proactivity is a **cognitive decision**, not a scheduled event. The LLM may **propose** proactive candidates during stages 5–6 of the cognitive cycle. The **application** evaluates every candidate against a deterministic decision tree, and the application is the final authority on whether a proactive message is emitted. The LLM is never the final authority for whether Madhurita is allowed to proactively contact someone.

```mermaid
flowchart TB
  Cand[LLM Proactive Candidate Proposal] --> Auth{Application: Authorized?}
  Auth -->|no| Reject[Reject]
  Auth -->|yes| U{Application: Urgent?}
  U -->|yes| Emit[Emit to RESPOND via Application]
  U -->|no| N{Application: Novel?}
  N -->|no| Skip[Skip / Suppress]
  N -->|yes| T{Application: Good Timing?}
  T -->|no| Defer[Defer to better window]
  T -->|yes| I{Application: Interruption cost acceptable?}
  I -->|no| Defer
  I -->|yes| C{Application: User context compatible?}
  C -->|no| Skip
  C -->|yes| Emit
```

**Every branch in the decision tree is application-defined. The LLM does not run this tree; the application runs it against the candidate.**

### XIV.2 Decision Output

```ts
type ProactiveDecision =
  | { kind: 'speak'; channel: 'text' | 'voice'; priority: 'low' | 'normal' | 'high' }
  | { kind: 'act'; toolId: ToolId; payload: unknown }
  | { kind: 'ask'; question: string }
  | { kind: 'wait'; until: number }
  | { kind: 'silent' };
```

### XIV.3 Anti-Spam Guarantees

The application enforces these deterministic constraints before any LLM candidate is emitted:

- Per-topic rate limit (max one proactive per topic per hour by default).
- Quiet hours honored unless urgent.
- Owner may globally disable proactivity; per-topic disable also allowed.
- Proactive silence is the default, not the exception.
- Guest sessions never receive proactive messages.
- Relevance, novelty, and authorization checks are mandatory. The LLM may assist with semantic relevance scoring but the application enforces the threshold.

### XIV.4 Verification

- A test asserts that a candidate not novel enough is suppressed, not delayed.
- A test asserts that quiet hours suppress non-urgent proactivity.
- A test asserts that globally disabled proactivity never produces a `speak` or `act` decision.
- A test asserts that the LLM cannot directly emit a proactive message without the application running the full decision tree.
- A test asserts that a guest session never receives proactive output.

---

## XV. VOICE & LIVE SESSION

### XV.1 Two Voice Modes

| Mode | Use Case | Latency Target |
| --- | --- | --- |
| **Push-to-talk / always-on** | Owner-driven live conversation | <250ms round trip |
| **TTS reply** | Madhurita speaks, owner listens | <300ms first audio byte |

The system supports both. They share audio plumbing but have different control flows.

### XV.2 Live Session State Machine

```mermaid
stateDiagram-v2
  [*] --> Disconnected
  Disconnected --> Connecting: start()
  Connecting --> Listening: WS open + mic ready
  Connecting --> Error: WS error
  Listening --> Thinking: speech end + LLM
  Listening --> Speaking: TTS playback
  Thinking --> Listening: ready
  Thinking --> Speaking: ready
  Speaking --> Listening: TTS complete
  Error --> Disconnected: reset
  Error --> Connecting: retry
  Speaking --> Disconnected: stop()
  Listening --> Disconnected: stop()
  Thinking --> Disconnected: stop()
```

### XV.3 Audio Plumbing

- **Capture**: Web Audio API → `AnalyserNode` (waveform) + `ScriptProcessor` / `AudioWorklet` (PCM frames).
- **Playback**: TTS bytes → `AudioBufferSourceNode` → `AnalyserNode` (waveform).
- **Streaming**: WebSocket frames to/from the Gemini Live endpoint.
- **Realtime UI**: `AnalyserNode.getByteTimeDomainData()` drives the orb's equator waveform.

### XV.4 Verification

- A test asserts that mic capture cannot be started without a confirmed live session.
- A test asserts that TTS playback honors user volume preferences.
- A test asserts that the orb's equator waveform reflects actual audio amplitude (not a fake animation).

---

## XVI. REALTIME FLOW (The 7-Stage Broadcast)

### XVI.1 The Contract

```mermaid
flowchart LR
  M[1. MUTATION] --> P[2. PERSISTENCE]
  P --> D[3. DOMAIN EVENT]
  D --> R[4. RUNTIME UPDATE]
  R --> U[5. UI UPDATE]
  R --> V[6. VOICE UPDATE]
  R --> C[7. COGNITIVE UPDATE]
```

No mutation may skip a stage. No UI update may precede persistence.

### XVI.2 Backpressure

If a client is slow, the realtime channel **coalesces** consecutive updates to the same field, sending only the latest. The client never receives a stale field after a newer one.

### XVI.3 Verification

- A test asserts that the event log is in lockstep with the broadcast log.
- A test asserts that a slow client never causes the producer to block.
- A test asserts that disconnection causes no data loss (events persist; client catches up on reconnect).

---

## XVII. UI SHELL & VISUAL LANGUAGE

### XVII.1 Visual Principles

- **Photographic, not illustrated.** No SVG, no flat vector, no cartoon for environment, landscape, orb, atmosphere, or major UI artwork.
- **Glassmorphic chrome** on top of photographic environment — *panes of glass, not painted panels.*
- **Photographic text shadows** for legibility on photographic backgrounds.
- **Autonomous visual state**: orb color, lighting, rim highlights, particle behavior, and ambient atmosphere are derived from authoritative `EnvironmentState` and `VoiceState`, not hand-tuned per screen.
- **Cinematic real-time 3D**: the environment is a real GPU-rendered scene (WebGPU preferred, WebGL2 fallback), not a CSS panel with a sphere on top. The full visual specification lives in **Part XVIII — Visual & Rendering Architecture**, which is the authoritative document for the orb, water, atmosphere, lighting, and rendering stack.

### XVII.2 Layout System

- Three-column desktop shell (left rail, center, right context).
- Mobile collapses to single column with bottom-sheet context panels.
- The orb is the **optical center** of the home stage, sitting just above the horizon line of the photographic background.

### XVII.3 Typography

- One display family (variable, optical-sized).
- One text family.
- One mono family for code/data surfaces.
- Photographic shadows on display headlines over photographic backgrounds.

### XVII.4 Verification

- A visual regression test asserts that key screens match reference compositions within tolerance.
- A test asserts that the orb's color comes from `EnvironmentState`, not a hardcoded palette.

---

## XVIII. VISUAL & RENDERING ARCHITECTURE (The Cinematic Environment)

This part is the **authoritative visual specification** for the Madhurita environment. It is **not** an enhancement of the legacy orb; it is the production-grade rendering architecture for the rebuilt product. The final UI must visually feel like a **premium cinematic real-time interactive environment**, not a normal dashboard with a glass sphere placed on top.

### XVIII.0 Visual Authority and Scope

- The visual system is a **presentation layer** over authoritative `RuntimeState`. The orb, water, environment, and atmosphere **visualize** application state. They never **create** it.
- The visual system is **not** a source of truth for identity, cognition, memory, authorization, task state, or any other authoritative concern. Visual state is derived; it is not authoritative.
- The visual system reads from the same RuntimeState that the rest of the UI reads from. There is no separate visual database. There is no hardcoded visual state inside the orb.
- The state flow the visual layer obeys is:

```
DATABASE
  → RUNTIME STATE (Authoritative Live Projection)
    → DOMAIN EVENT
      → VISUAL STATE (derived, in-memory)
        → RENDERER (WebGPU preferred, WebGL2 fallback)
```

- The visual layer must not introduce its own state machine that competes with `VoiceState`, `CognitiveState`, or `EnvironmentState`. If a new visual state is needed, it is **derived** from existing authoritative state and computed in `VisualStateMapper` (see XVIII.12).

### XVIII.1 Visual Target

The final scene must resemble the cinematic reference: a **luminous floating orb** with physically convincing transparent/translucent optical behaviour, a **dynamic audio waveform** crossing it horizontally, a **real-time water surface** below with reflection and ripples, a **cinematic natural environment** (mountains, sky, atmosphere), and **autonomous atmospheric lighting** that responds to the authoritative environment state.

The orb must be a **genuinely rendered real-time 3D object**. It must not be:

- a generic transparent sphere
- a flat texture pretending to be glass
- ordinary CSS gradients as the primary orb rendering
- an SVG illustration
- a single-color neon ball
- plastic, cheap glass, flat chrome, or a "looks 3D but isn't" shader

It must read as **luminous, dimensional, and physically present**.

### XVIII.2 Rendering Stack

The visual architecture is built on:

- **TypeScript** as the language of all visual modules.
- **React** as the component model.
- **React Three Fiber** as the scene-graph binding.
- **Three.js** as the renderer and primitive library.

The **primary rendering target is WebGPU**:

- **Three.js WebGPURenderer** with the **TSL** (Three Shading Language) pipeline.
- **WGSL** is allowed for hand-authored compute/ray-marched volumes where TSL is insufficient.
- The application **detects rendering capability** on startup and selects:
  - **WebGPU** (preferred)
  - **WebGL2** (fallback)
- The visual abstractions are clean enough that the orb, water, environment, and lighting **render correctly on both paths** without duplicating the visual architecture. Renderer-specific code lives in a thin `RendererAdapter` layer; the rest of the visual modules are renderer-agnostic.
- The WebGL2 fallback uses **GLSL** shader implementations equivalent to the TSL/WGSL versions. Effect parity is verified per pass.

### XVIII.3 Shader Architecture

The orb, water, and atmosphere are GPU-rendered with **custom shaders**. Shaders are organized into **reusable modules** with single responsibilities — never one giant shader. Module families:

- **PBR Core** — base PBR shading, energy-conserving diffuse + specular.
- **Transmission** — physically based transmission with thickness, IOR, and absorption.
- **Refraction** — index-of-refraction driven refraction sampled from a render target.
- **Fresnel** — Schlick Fresnel with roughness modulation.
- **Environment Reflection** — PMREM-prefiltered environment map sampling.
- **Thickness Approximation** — proxy thickness, internal absorption color.
- **Internal Scattering** — screen-space or ray-marched approximation of light inside the orb volume.
- **Subsurface Light** — optional subsurface-style contribution where the artistic effect calls for it.
- **Procedural Surface** — layered noise (low/mid/high frequency) for microdetail and surface variation.
- **Procedural Microdetail** — high-frequency surface detail, animated subtly.
- **Displacement** — vertex/fragment displacement driven by audio and environment.
- **Emissive** — controlled emission layer for internal light, voice-state glow.
- **Distortion** — optical distortion of background sampled through the orb.
- **Depth-Aware** — depth-buffer dependent effects for water and atmosphere.

The TSL/WGSL implementations are the production path; the GLSL implementations are the fallback path. Each module has a **definition contract** (uniforms, inputs, outputs) that both implementations honor.

### XVIII.4 Orb Material

The orb material is a **physically inspired optical material** that combines:

- transmission
- refraction
- Fresnel
- environment reflection
- internal illumination
- dynamic surface detail
- controlled emission
- depth/thickness response

The result must read as luminous and dimensional. The material reacts to **real lighting and environment**; it is not a self-illuminated decal. The environment map and the directional sun together produce the highlights. The internal core provides the luminous depth. The voice state modulates emission, not material identity.

The material is **never**: plastic, cheap glass, flat chrome, simple transparent sphere, or single-color neon ball.

### XVIII.5 Liquid-Like Behaviour

The orb is **not** a rigid static glass ball. It has subtle living, liquid behaviour driven by GPU procedural techniques:

- low-frequency surface deformation
- layered noise
- smooth wave propagation across the surface
- internal flow patterns in the core shader
- subtle breathing/pulsing driven by environment and audio
- audio-responsive deformation at low amplitude
- slow environmental motion from `EnvironmentState`

The deformation must be **elegant and physically plausible**. There is no obvious random wobble. Motion is continuous, smooth, and feels like a **controlled luminous liquid entity**.

### XVIII.6 Audio-Reactive Orb

The orb is driven by **real audio analysis** from the Web Audio API, not by a fake timer or scripted animation.

The audio analysis layer supports:

- **Microphone input** (owner voice during `listening`).
- **TTS output** (Madhurita's own voice during `speaking`).
- **Playback amplitude** (RMS, peak).
- **Frequency bands** (low / mid / high).
- **Transient detection** (onset events).
- **Voice intensity** (envelope follower).
- **Low / mid / high frequency energy** (split-band analysis).

The pipeline is:

```
Web Audio Analyser (raw FFT)
  → normalization
    → smoothing (exponential moving average)
      → temporal filtering
        → band decomposition
          → visual parameters
```

Raw FFT values are **never** mapped directly to transforms. Every audio feature is normalized, smoothed, and temporally filtered before it touches a visual parameter. The result is a clean, low-jitter visual response.

Audio features are mapped to:

- orb surface deformation
- equator waveform displacement
- internal light intensity and color
- surface ripple amplitude
- aura intensity
- particle motion
- emission color shift
- subtle scale / energy response

The orb therefore **reacts differently to listening, thinking, processing, speaking, idle, error, and silence** because each state is fed from a different audio source with different characteristics.

### XVIII.7 Audio Waveform (Equator Ring)

The horizontal waveform shown crossing the orb is generated from **real audio** — not a generic equalizer, not a fake animation.

It must:

- cross the orb horizontally
- respond continuously to mic (during `listening`) and TTS (during `speaking`)
- remain visually integrated with the environment (correct depth ordering, additive blending, environment-aware color)
- support frequency-aware motion (low/mid/high bands displace different regions)
- have glow / bloom driven by the post-processing pipeline
- when no audio is present, **settle naturally** (decay to baseline) rather than disappear abruptly

The waveform is a 128-point line geometry at the orb equator, driven every frame from `AnalyserNode.getByteTimeDomainData()` (mic) or TTS playback analyser.

### XVIII.8 Water / Lake

The water surface below the orb is a **GPU-rendered plane**, not a static image and not a CSS effect.

Techniques used (renderer-appropriate):

- Gerstner-style wave displacement
- procedural wave displacement (multiple summed sinusoids)
- normal mapping from wave derivatives
- reflection (render target or screen-space)
- refraction
- Fresnel
- depth interaction
- screen-space techniques where useful

The water must **react visually to the orb's presence** through:

- a soft reflection of the orb (render-target based)
- subtle local water disturbance beneath the orb
- a soft reflected light pool on the surface under the orb

The water is not a fake static image. The reflection updates as the orb and environment change.

### XVIII.9 Orb-Water Interaction

The orb must feel **physically connected to the environment**. Concretely:

- the orb is **reflected** on the water surface (render-target-based reflection updated each frame)
- a soft **reflected light pool** is visible on the water under the orb
- subtle local **water disturbance** sits beneath the orb and gently modulates the surface
- the **environment's atmospheric light** is reflected by the water (golden at sunset, cool at night, etc.)
- **depth ordering** is correct: the orb is in front of the water; the water extends behind the orb to the horizon
- the reflection updates in real time as the orb rotates, deforms, and changes voice state

### XVIII.10 Environment (Sky, Mountains, Atmosphere)

The environment supports a **cinematic natural landscape** using a combination of:

- HDR environment lighting (IBL)
- procedural / 3D environment elements (sky, mountains, tree silhouettes, clouds, horizon)
- sky / atmosphere rendering
- water (separate renderer)
- lighting

The environment is **not** a flat background image. Where image-based environment assets are used, they are combined with **real-time lighting and depth-aware rendering** so the result is integrated, not pasted.

Atmospheric depth is supported through:

- distance-based atmospheric scattering
- fog
- height fog
- soft aerial perspective
- volumetric-style lighting where performance permits

### XVIII.11 Atmospheric Rendering

The atmosphere is rendered on the GPU with cinematic intent. Supported effects include:

- volumetric-style lighting (screen-space or ray-marched, performance-bounded)
- atmospheric scattering approximation
- fog and height fog
- god rays / light shafts
- aerial perspective
- volumetric glow around the orb and sun

Every effect has a **performance-aware fallback**. The atmosphere must always be present; the quality may be reduced. There is no "atmosphere off" state — that would be visually broken.

### XVIII.12 Architectural Modules (Visual Subsystems)

The visual system is decomposed into modules with **separated responsibilities**. Names may adapt to project conventions; the responsibilities are mandatory.

| Module | Responsibility |
| --- | --- |
| **VisualRuntime** | Lifecycle of the visual system. Owns the renderer, the scene, the camera, the animation loop. Detects WebGPU/WebGL2 capability. Boots in clean state on every session. |
| **RendererManager** | Owns the renderer adapter, the canvas, the swap chain, render targets, depth buffers. Selects WebGPU or WebGL2 on capability detection. |
| **SceneManager** | Owns the Three.js / R3F scene graph: lights, camera, root group. Handles resize, quality switching, scene swap. |
| **OrbRenderer** | The orb itself: outer glass sphere, inner energy core, equator waveform, acoustic ripples. Mounts into the scene. Owns the orb's render path. |
| **OrbMaterial** | The orb's physical material. References TSL/WGSL/GLSL shader modules. Reads uniforms (palette, audio, voice state, time). |
| **OrbShaderPipeline** | Shader module composition. Owns the TSL node graph and the GLSL equivalent. Enforces module-level reuse. |
| **AudioReactiveController** | The bridge between Web Audio analysers and the renderer. Owns smoothing, normalization, band decomposition, transient detection. Exposes smoothed audio state to GPU uniforms without React re-renders. |
| **WaterRenderer** | GPU water plane: Gerstner/procedural waves, normal mapping, reflection, refraction, Fresnel. |
| **EnvironmentRenderer** | Sky, mountains, clouds, horizon. HDR environment map producer. |
| **AtmosphereRenderer** | Fog, height fog, god rays, aerial perspective, volumetric glow. |
| **LightingSystem** | Directional sunlight, ambient, IBL, emissive layers. Time-of-day palette interpolation. |
| **PostProcessingPipeline** | Bloom, tone mapping, exposure, color grading, anti-aliasing, depth-of-field (where justified), temporal smoothing. |
| **ParticleSystem** | GPU-accelerated particles: stardust, embers, internal motes. Sparse, purposeful. |
| **QualityManager** | Selects and switches quality tier (ULTRA / HIGH / MEDIUM / LOW) from device capability and runtime perf. |
| **PerformanceMonitor** | FPS, frame time, GPU time, JS heap, dropped frames. Drives QualityManager. |
| **AssetManager** | Texture, geometry, HDR, model, and audio-asset lifecycle. Loading, caching, disposal. |
| **VisualStateMapper** | Pure function: `RuntimeState` → `VisualState` (palette, intensity, voice visual, environment visual, audio visual). The orb and environment read only from `VisualState`. |

These modules are **renderer-agnostic in interface**; renderer-specific code is confined to `RendererManager` and per-module adapter code. The orb, water, and environment **render correctly on both WebGPU and WebGL2** without architectural duplication.

### XVIII.13 Cinematic Camera

A controlled cinematic camera handles framing:

- subtle parallax driven by cursor / device tilt
- controlled depth and focal length
- smooth transitions between framings
- responsive framing under viewport changes
- device-aware composition (desktop / tablet / mobile)

The camera does **not** move constantly. Motion is **subtle and purposeful**. Idle frames hold a stable composition.

### XVIII.14 Responsive Rendering (Quality Tiers)

The visual system supports four quality tiers, automatically selected by `QualityManager` from device capability and runtime perf:

| Tier | Target Device | DPR Cap | Particles | Reflection | Post | Water |
| --- | --- | --- | --- | --- | --- | --- |
| **ULTRA** | High-end desktop | 2.0 | Full | Render-target | Full | Full |
| **HIGH** | Mainstream desktop | 1.75 | High | Render-target | Standard | Full |
| **MEDIUM** | Tablet / mid laptop | 1.5 | Medium | Approximate | Reduced | Reduced |
| **LOW** | Mobile | 1.25 | Low | Screen-space | Minimal | Simplified |

Selection is capability-aware (initial) and performance-aware (runtime). The renderer **degrades quality before becoming unusable**.

### XVIII.15 Frame Budget

- **Desktop**: 60 FPS baseline. Higher refresh rates where possible.
- **Tablet**: stable 60 FPS target with adaptive fall-back.
- **Mobile**: stable adaptive frame rate; the renderer prefers smoothness over peak quality.

The renderer must **degrade quality before frame rate collapses** — i.e. lower quality tier before dropping frames.

### XVIII.16 Performance Architecture (First-Class Concern)

Rendering performance is a first-class engineering requirement.

- GPU instancing for repeated particles, mountains, trees.
- Frustum culling, LOD for distant environment.
- Adaptive DPR (the same target as QualityManager).
- GPU-friendly buffers (instanced attributes, typed arrays).
- Resource reuse (geometry, material, texture pools).
- Texture compression (KTX2/Basis where supported).
- Lazy loading (assets loaded on demand).
- Shader reuse (module library, not per-effect shaders).
- Render-target reuse (one set of MRTs, ping-pong where needed).
- No per-frame allocations in the animation loop.
- **No expensive per-frame React state updates.**
- **No React re-renders per audio sample.** Audio flows into the renderer via `AudioReactiveController` → smoothed state → GPU uniforms.
- Animation stays inside the rendering layer.

### XVIII.17 Resource Management

Lifecycle is explicit for every GPU resource:

- textures
- geometries
- materials
- render targets
- audio analysers
- WebGPU resources
- WebGL resources

Every `VisualRuntime` boot allocates a fresh set. Every `VisualRuntime` teardown disposes. There are no leaks across long sessions, hot-reloads, or feature-flag toggles. Asset and render-target pools are bounded.

### XVIII.18 Audio + Render Loop Architecture

The audio pipeline must not flow through React state:

```
Web Audio Analyser (mic / TTS)
  → AudioReactiveController (smoothing, normalization, filtering)
    → GPU uniforms / buffers (direct)
      → Shader / render pipeline
```

This is **independent of normal React component re-rendering.** The orb updates its visual state at 60+ Hz from the audio controller, not from React props. React renders the orb once; the orb animates itself.

### XVIII.19 Visual State Architecture (What Drives the Orb)

The orb responds to **authoritative Madhurita state**, not to local UI state. The visual inputs include:

- `VoiceState.live` — `disconnected` / `connecting` / `listening` / `thinking` / `speaking` / `error`
- `VoiceState.energy`, `ttsEnergy`, `frequencyBands`
- `CognitiveState.currentStage` — which of the 12 stages is active
- `CognitiveState.attention` — what the agent is attending to
- `EnvironmentState.timeOfDay` — `night` / `sunrise` / `day` / `sunset`
- `EnvironmentState.weather` — `clear` / `cloudy` / `rainy` / `stormy` / `snow` / `fog`
- `EnvironmentState.derivedPalette` — palette from environment
- Audio energy (from `AudioReactiveController`)
- Loop and task activity (subtle hints, not direct visual drivers)

These are **state-driven visual parameters**. There is **no independent visual business logic** in the orb. The renderer visualizes application state; the application does not consult the renderer for state.

### XVIII.20 Visual State Does Not Control Cognition

The orb is a **presentation layer**. The orb must never become the source of truth for:

- identity
- cognition
- task state
- memory
- authorization
- application state

Visual state is **derived** from authoritative state. The reverse — visual state influencing application state — is forbidden. The orb cannot request a cognitive stage transition, cannot request an action, cannot change `VoiceState`, cannot write memory.

### XVIII.21 UI Design (Visual Language)

The entire UI follows the visual language of the cinematic reference.

Target characteristics:

- **Cinematic** — feels like a film, not a dashboard.
- **Premium** — high polish, no cliche.
- **Minimal** — less on screen, not more.
- **Immersive** — the user feels inside the scene.
- **Dark environment** — the orb glows against atmosphere.
- **Luminous accents** — light is the primary visual material.
- **Glass / translucent surfaces** — for chrome, not for the orb itself.
- **Deep spatial layering** — orb, water, mountains, sky, atmosphere.
- **Subtle animation** — never constant motion; always purposeful.
- **Strong visual hierarchy** — the orb is primary; secondary controls recede.

Avoid:

- generic admin-dashboard appearance
- excessive cards
- flat gradients
- excessive borders
- cheap neon effects
- excessive text
- visual clutter

The orb remains the primary interface. Secondary controls visually recede.

### XVIII.22 Realtime UI Flow

The visual renderer consumes the same authoritative runtime state as the rest of the UI:

```
DATABASE
  → RUNTIME STATE
    → DOMAIN EVENT
      → VISUAL STATE (derived)
        → RENDERER
```

There is no duplicated visual state database. There is no hardcoded state inside the orb. The orb's color, the water's palette, the atmosphere's intensity, and the equator waveform's amplitude are all **derived** from `RuntimeState` and from `AudioReactiveController`.

### XVIII.23 WebGPU / WebGL2 Fallback (Progressive Enhancement)

The fallback path is a **first-class** rendering path, not a degraded toy.

- **Preferred**: WebGPU + TSL + WGSL.
- **Fallback**: WebGL2 + GLSL.

When advanced rendering is unavailable, the system **retains**:

- the orb (correct material, even at lower quality)
- audio reaction (real audio drives the waveform)
- lighting (real lighting, time-of-day aware)
- water (real water, possibly simpler waves)
- environment (real sky, real atmosphere)
- core interaction (orb + audio + voice)

It **reduces** expensive effects (lower-resolution render targets, simplified atmosphere, fewer particles, simpler post-processing). The canvas is never broken.

### XVIII.24 AAA-Quality Principle

The goal is **AAA-style visual quality**, not the blind adoption of AAA-game-engine technology.

Every rendering technique must justify:

- **Visual benefit** — does it materially improve the look?
- **GPU cost** — is the cost justified by the benefit?
- **Browser compatibility** — does it work on the target browsers?
- **Mobile impact** — does it survive the mobile quality tier?
- **Maintenance complexity** — can the team maintain it?

Techniques are adopted only when their answer to all five is positive. The architecture prefers the **highest visual quality reliably deliverable in a browser**, not the most exotic path.

### XVIII.25 Scene Architecture (Module Diagram)

```mermaid
flowchart TB
  subgraph VisualRuntime
    RM[RendererManager - WebGPU/WebGL2]
    SM[SceneManager]
    QM[QualityManager]
    PM[PerformanceMonitor]
    ASM[AssetManager]
  end

  RM --> Orb[OrbRenderer]
  RM --> Water[WaterRenderer]
  RM --> Env[EnvironmentRenderer]
  RM --> Atmo[AtmosphereRenderer]
  RM --> Post[PostProcessingPipeline]
  RM --> Part[ParticleSystem]
  RM --> Cam[CinematicCamera]
  RM --> Light[LightingSystem]

  AudioC[AudioReactiveController - Web Audio analyser] -->|smoothed uniforms| Orb
  AudioC -->|amplitude| Water
  AudioC -->|band energy| Atmo

  VSM[VisualStateMapper] -->|VisualState| Orb
  VSM -->|palette| Light
  VSM -->|palette| Env
  VSM -->|intensity| Atmo
  VSM -->|waveform config| Orb

  RT[RuntimeState] --> VSM
  Voice[VoiceState] --> VSM
  Env2[EnvironmentState] --> VSM
  Cog[CognitiveState] --> VSM

  QM --> RM
  PM --> QM
```

### XVIII.26 Rendering Pipeline (Per Frame)

```mermaid
flowchart LR
  AC[Audio Analysers] --> ARC[AudioReactiveController]
  ARC -->|smoothed uniforms| SP[Shader Pipeline]
  VS[VisualState - derived] -->|uniforms| SP
  SP -->|shadow pass| SH[Shadow Target]
  SP -->|water sim| WS[Water Normal + Height]
  WS -->|normal| SP
  SP -->|main pass - orb| MRT[Main Render Target]
  SH -->|shadow| SP
  SP -->|post - bloom, tone map, grade| OUT[Final Canvas]
  PM[PerformanceMonitor] --> QM[QualityManager]
  QM -->|quality uniforms| SP
```

### XVIII.27 Audio → GPU Pipeline (No React In The Loop)

```mermaid
flowchart LR
  Mic[Microphone - AnalyserNode FFT] --> ARC[AudioReactiveController]
  TTS[TTS Playback - AnalyserNode FFT] --> ARC
  ARC -->|EMA smoothing| S1[Smoothed Energy]
  ARC -->|band split| S2[Band Energy low/mid/high]
  ARC -->|envelope follower| S3[Voice Intensity]
  ARC -->|onset detector| S4[Transient]
  S1 -->|uniform| OrbS[Orb Shader]
  S2 -->|uniform| OrbS
  S3 -->|uniform| OrbS
  S4 -->|uniform| OrbS
  OrbS --> Out[Orb Render]
```

### XVIII.28 Orb State Pipeline (Driven By RuntimeState)

```mermaid
flowchart LR
  VS[VoiceState] --> OMap[Orb State Mapper]
  CS[CognitiveState] --> OMap
  ES[EnvironmentState] --> OMap
  AR[AudioReactiveController] --> OMap
  OMap -->|palette + intensity + ripple + waveform config| OrbM[Orb Material + Shaders]
  OrbM --> Render[Render Pass]
```

### XVIII.29 WebGPU / WebGL2 Capability Selection

```mermaid
flowchart TB
  Boot[VisualRuntime boot] --> Cap{Detect capability}
  Cap -->|WebGPU available| GPU[WebGPURenderer + TSL + WGSL]
  Cap -->|WebGPU unavailable| GL[WebGLRenderer + GLSL]
  GPU --> Adapter[RendererAdapter - common interface]
  GL --> Adapter
  Adapter --> Scene[Scene mounts - same modules]
  Scene --> Q[QualityManager selects tier from device]
  Q -->|ULTRA/HIGH/MEDIUM/LOW| Render
```

### XVIII.30 Water / Environment Pipeline

```mermaid
flowchart LR
  Time[uTime] --> Wave[Wave Simulation - Gerstner/Procedural]
  Audio[Smoothed Audio] --> Wave
  Wave --> Norm[Water Normal]
  Norm --> Refl[Reflection Pass - orb + env into water RT]
  Norm --> Refr[Refraction Pass - sample env through water]
  Refl --> Fres{Fresnel mix}
  Refr --> Fres
  Fres -->|final color| Out[Water Render]
  Orb[Orb Position] --> Refl
  Orb -->|local disturbance| Wave
```

### XVIII.31 UI → Runtime → Renderer State Flow

```mermaid
flowchart LR
  DB[(SQLite - Authoritative Durable)]
  DB --> RS[RuntimeState - Authoritative Live Projection]
  RS -->|VoiceState, CognitiveState, EnvironmentState| DE[Domain Event]
  DE --> VSM[VisualStateMapper]
  VSM -->|VisualState - palette, intensity, audio visual| R[Renderer]
  AC[AudioReactiveController] -->|smoothed audio| R
  R --> Canvas[Canvas - WebGPU or WebGL2]
  Canvas -->|visible| User[User]
  User -.speaks.-> AC
```

### XVIII.32 Visual Quality Adaptation

```mermaid
flowchart LR
  P[PerformanceMonitor] -->|FPS, frame time, GPU time| Q[QualityManager]
  Q -->|capability tier| Init[Initial Tier]
  Q -->|runtime downgrade| DT[Lower Tier]
  Q -->|runtime upgrade if headroom| UT[Higher Tier]
  Init --> SP[Shader Pipeline Uniforms]
  DT --> SP
  UT --> SP
  SP --> Render[Render Pass]
```

### XVIII.33 Definition of Done — Visual

The visual architecture is complete only when the runtime scene resembles the cinematic reference and meets all of the following:

- **Floating luminous orb** — visible, centered, optically present.
- **Realistic optical material** — physically based transmission, refraction, Fresnel, environment reflection, internal illumination.
- **Dynamic internal light** — internal core, scattering, internal depth.
- **Real audio waveform** — driven by mic/TTS, not a fake animation.
- **Liquid-like surface** — subtle, continuous, controlled deformation.
- **Realistic water** — GPU-rendered plane with reflection, refraction, Fresnel, normal mapping.
- **Orb reflection** — the orb reflects on the water; the water reflects the orb.
- **Cinematic environment** — sky, mountains, horizon, clouds, atmospheric depth.
- **Atmospheric lighting** — time-of-day + weather + sun direction.
- **Responsive UI** — works on desktop / tablet / mobile with quality tiers.
- **GPU rendering** — WebGPU preferred, WebGL2 fallback.
- **Adaptive performance** — degrades quality before becoming unusable.

The scene is **not**: a static image, a CSS illusion, an SVG illustration, ordinary glass, or fake audio animation.

### XVIII.34 Verification (Visual)

- **Renderer init test** — visual runtime boots on WebGPU and on WebGL2 without crash.
- **WebGPU / WebGL2 selection test** — capability detection chooses the correct path.
- **DPR adaptation test** — DPR follows quality tier; no excessive fill rate on mobile.
- **Quality switching test** — switching tier changes DPR, particles, post effects.
- **Audio analysis test** — `AudioReactiveController` produces smoothed energy/bands within latency budget.
- **Mic response test** — speaking into mic drives orb waveform and deformation.
- **TTS response test** — TTS playback drives orb waveform and deformation.
- **Orb state transition test** — voice / cognitive state changes map to visible parameter changes.
- **Water render test** — water plane renders with reflection + refraction + Fresnel.
- **Resource disposal test** — no GPU resource leaks across mount/unmount cycles.
- **Resize test** — viewport resize re-creates render targets correctly.
- **Mobile rendering test** — LOW tier runs on a target mobile device without dropping frames.
- **Tablet rendering test** — MEDIUM tier runs smoothly on a target tablet.
- **Long-session test** — no leaks after 30+ minutes of continuous rendering.
- **Visual regression test** — pixel-comparison of key frames against reference within tolerance.
- **Performance benchmark** — FPS and frame-time measured on representative devices at each tier.

---

## XIX. BACKGROUND ATMOSPHERE

### XIX.1 Photographic, Layered, Autonomous

- Photographic landscape derived from `EnvironmentState`.
- Lake reflection synthesized from photographic foreground.
- Particle layer (stardust, embers, snow, pollen) selected by `timeOfDay` and `weather`.
- Color grading driven by `PaletteSpec` computed from environment.

### XIX.2 No Flat Vector

- No SVG landscape, no illustrated mountain, no cartoon sun.
- Where photography isn't available, the system uses procedural WebGL noise, never flat fills.

### XIX.3 Verification

- A test asserts that the background's palette is derived from authoritative state.
- A visual test asserts the atmosphere shifts cohesively with time-of-day.

---

## XX. ADVANCED INTELLIGENCE

### XX.1 Sub-Modalities (Planned, Post-MVP)

| Modality | Purpose | Trigger |
| --- | --- | --- |
| **Emotion reading** | Infer affective state from voice features | During listening |
| **Personality modulation** | Adjust verbosity, formality, warmth per user | Per identity |
| **Relationship context** | Recall who matters to whom in ongoing dialogue | During UNDERSTAND |
| **Long-horizon reflection** | Daily/weekly summaries for owner | Scheduled |
| **Dream consolidation** | Off-line memory consolidation during quiet hours | Scheduled |
| **Multi-person coordination** | Handle multiple known persons in one conversation | When present |

### XX.2 Where They Live

Each is a `CognitiveModule` that hooks into one or more of the 12 stages. They are *opt-in* modules, with explicit feature flags and isolation so a failure in one cannot crash the runtime.

### XX.3 Verification

- Each module has its own test suite and runtime guard.
- A test asserts that disabling all advanced modules leaves a working MVP.

---

## XXI. TESTING STRATEGY

### XXI.1 Test Pyramid

```mermaid
flowchart TB
  E2E[End-to-End - Owner Journey] --> Int[Integration - Multi-module]
  Int --> Mod[Module - Per stage]
  Mod --> Unit[Unit - Pure functions]
  Unit --> Inv[Invariants - Cross-cutting]
```

### XXI.2 Test Categories (A–G)

The test suite is organized into seven cross-cutting categories, each enforced by at least one invariant that runs in CI. No phase is "complete" without all category tests for that phase passing.

| Category | Purpose | Scope |
| --- | --- | --- |
| **A. Authority** | LLM never bypasses application authority. LLM may not mutate DB, may not execute tools, may not authorize, may not emit authoritative events, may not persist memory. | Cognitive stages 4–7, 10; Action stages 1, 2, 7; Proactivity; Learning |
| **B. Memory** | Memory is multi-domain, scoped, sensitive, soft-deletable. | Retrieval, Provenance, Sensitivity, Soft-Delete |
| **C. Runtime** | RuntimeState is the one live projection; no split-brain; durable state reconstructs deterministically. | State projection, Concurrency, Reconstruction |
| **D. Actions** | Every action is verified; unverified actions are never reported as success. | Action pipeline stages 3–7 |
| **E. Proactivity** | Proactive decisions follow the deterministic decision tree; anti-spam guarantees hold; guests never receive proactive output. | Proactive engine |
| **F. Guest Isolation** | Guests cannot access owner memory or other persons' memory; Knowledge Retrieval Policy and Knowledge Disclosure Policy enforce identity isolation. | Retrieval, Disclosure, Guest Learning |
| **G. Failure** | Interruption, crash, and rollback are explicit and observable. | Cognitive cycle, Action rollback, Domain event replay |

### XXI.3 Standard Categories (Reuse Infrastructure)

| Category | Purpose | Tools |
| --- | --- | --- |
| **Unit** | Pure functions, no IO. | Native runner. |
| **Module** | Single module, mocked IO. | Native runner. |
| **Integration** | Multiple modules, real DB. | Native runner + SQLite. |
| **Invariants** | Cross-cutting properties (e.g. "every mutation is atomic"). | Native runner + property tests. |
| **End-to-end** | Real owner journey through real frontend. | Playwright (planned). |
| **Visual regression** | Pixel-comparison of orb + atmosphere. | Playwright + image diff (planned). |
| **Chaos** | Crash injection, latency injection, partition. | Custom. |

### XXI.4 Coverage Targets

- **Cognitive stages**: 100% line, 100% branch.
- **Action pipeline**: 100% line, 100% branch.
- **Persistence**: 100% of happy + sad paths.
- **Event bus**: 100% of stage transitions.
- **UI shell**: 80% line, 100% of state-driven render branches.

### XXI.5 Test Isolation

- Every test gets a fresh, in-memory SQLite instance.
- No test depends on another test's state.
- Time is injectable; no `Date.now()` calls in domain code.
- LLM is mocked at the **adapter boundary** for unit and module tests. The application enforces all authority and policy checks regardless of LLM output, so test mocks do not weaken those guarantees.

### XXI.6 Required Invariant Examples (A–G)

- **A.1**: An LLM-proposed action that fails `authz.check` is rejected before EXECUTE. No exception, no fallback to "best effort."
- **A.2**: The LLM may not write directly to the SQLite DB. The LLM extracts proposals; the application validates and writes.
- **B.1**: Retrieval by a guest never returns owner memories.
- **B.2**: Every memory row has a `MemoryProvenance` linking to the originating cycle.
- **C.1**: After every mutation, RuntimeState projection matches SQLite row counts for the affected entity.
- **C.2**: Restart from a persisted SQLite snapshot reconstructs RuntimeState identically (deterministic).
- **D.1**: An action that crashes mid-EXECUTE leaves the DB in the pre-action state.
- **D.2**: An action that fails VERIFY is reported to the user as unverified, not as success.
- **E.1**: Quiet hours suppress non-urgent proactivity.
- **E.2**: Guests never receive proactive output.
- **F.1**: Knowledge Disclosure Policy redacts owner-only facts from guest-facing responses.
- **G.1**: An interrupted cognitive cycle is recorded with `status: 'interrupted'` and the system resumes cleanly.

---

## XXII. PERFORMANCE & LATENCY

### XXII.1 Targets

| Surface | Target | Stretch |
| --- | --- | --- |
| **Text round-trip** | <300ms | <200ms |
| **Voice round-trip** | <250ms | <180ms |
| **Realtime state broadcast** | <150ms mutation → UI | <100ms |
| **Cognitive cycle** | <800ms for routine | <400ms for routine |
| **Action pipeline** | <500ms read actions | <1s write actions |
| **Orb render** | 60fps desktop, 30fps mobile | 120fps desktop |
| **Cold start** | <3s to first paint | <2s |

### XXII.2 Knobs

- DPR cap: `Math.min(window.devicePixelRatio, 2)`.
- Particle counts: scaled down on mobile and on `prefers-reduced-motion`.
- LLM token budgets: per-stage, configurable, with hard ceilings.
- Realtime coalescing: 50ms window for consecutive updates to the same field.

### XXII.3 Verification

- A load test asserts that 10 rapid mutations don't drop any.
- A perf test asserts that the orb holds 60fps on a 2019 mid-range laptop.
- A test asserts that `prefers-reduced-motion` reduces particle counts below threshold.

---

## XXIII. SECURITY & PRIVACY

### XXIII.1 Threat Model

| Threat | Mitigation |
| --- | --- |
| Unauthorized person accesses owner data | Application-side **Knowledge Retrieval Policy** enforces per-identity isolation. |
| LLM authorizes unauthorized action | LLM proposes; Application enforces **AUTHORIZE** stage against permissions. |
| LLM leaks private data in output | Application enforces **Knowledge Disclosure Policy** in stage 9 before output. |
| LLM writes false data to memory | LLM proposes extraction; Application validates via **Scoped Guest Learning Policy**. |
| Injection via user text | All tool input validated with Zod. Application maintains authority over execution. |
| Cross-tenant data leak | Single-instance per owner; no shared DB. |
| Token theft | Short-lived sessions, refresh-on-activity, revocable. |
| Eavesdropping on voice | TLS for transport; ephemeral mic permission. |
| Audit gap | Every action and every disclosure decision emits `audit_log` row. |
| Backup exfil | Backups encrypted at rest with owner-derived key. |

### XXIII.2 Privacy Defaults

- Guests are subjected to the strict isolation boundary of the **Knowledge Retrieval Policy**.
- Guests' own preferences are quarantined from general memory via the **Scoped Guest Learning Policy**.
- Responses are scrubbed of unauthorized facts by the **Knowledge Disclosure Policy**.
- No data leaves the host for any third party except the configured LLM provider, and only the minimum required.
- The owner can export and delete all data at any time.

### XXIII.3 Verification

- A security test asserts that a guest cannot enumerate the owner's identities.
- A security test asserts that a person cannot read another person's memory.
- A security test asserts that all tool inputs are validated against their schema before execution.
- A security test asserts that the application rejects an unauthorized LLM tool-execution proposal before the EXECUTE stage.
- A security test asserts that the application redacts an LLM-drafted response if it violates the Knowledge Disclosure Policy.

---

## XXIV. CONFIGURATION & SECRETS

### XXIV.1 What Is Configurable

- LLM provider and model.
- TTS voice and parameters.
- Quiet hours.
- Notification preferences.
- Proactivity toggles per topic.
- Backups (schedule, destination).

### XXIV.2 What Is Not Configurable

- The 12-stage cycle.
- The 7-stage action pipeline.
- The 7-stage realtime flow.
- The memory domain split.
- The event log structure.
- The persistence schema (without migration).

### XXIV.3 Secrets

- API keys via `.env`, never in the DB, never in the UI.
- Owner-derived encryption keys never leave the device.
- No secret is logged.

---

## XXV. ROLLOUT, MIGRATION, ROLLBACK

### XXV.1 Phased Rollout

The rebuild rolls out in **causally ordered micro-phases** (see Part XXVI). Each phase has a clear checkpoint, a clear rollback path, and a clear pass criterion.

### XXV.2 Migration Strategy

- The new application gets a **fresh database, fresh schema**.
- The new system must boot and work correctly from an **empty database**. Legacy DB import is **not** a prerequisite.
- If old memory/data import becomes necessary later, that is a **separate explicit migration/import phase** (P28), not part of the rebuild.
- Import is validated: every imported memory must have provenance, must be scoped, and must pass the Knowledge Retrieval Policy.
- The old DB is never opened by the new runtime during the rebuild. The old DB file is **preserved as the archive** until the owner explicitly purges it.

### XXV.3 Rollback

There is no "fall back to the legacy application." The old application architecture is not a rollback target.

Rollback within the new architecture works as follows:

- Each phase is gated behind a feature flag.
- Disabling a flag **removes the incomplete capability**. It does **not** revert to a legacy system.
- The rollback target is always: **last verified new phase**.
- DB migrations are paired with `down` scripts that undo the new phase's schema additions.
- If a phase fails and cannot be disabled cleanly, the system stops at the last verified checkpoint and the failure is recorded in `MADHURITA_STATE.json`.

---

## XXVI. IMPLEMENTATION ROADMAP (Causally Ordered Micro-Phases)

This is the **single ordered list** the implementation will follow. Each phase is small enough to verify in one sitting, large enough to be meaningful. No phase may begin before its dependencies are complete and verified.

```mermaid
gantt
  title Madhurita Rebuild — Causal Phases
  dateFormat YYYY-MM-DD
  axisFormat %b
  section Foundation
  P01 Bootstrap & Tooling (M01)        :p01, 2026-09-01, 5d
  P02 Persistence Foundation (M02)     :p02, after p01, 5d
  P03 Identity & Auth (M03)             :p03, after p02, 5d
  section Domain
  P04 Domain Schema (M04)              :p04, after p03, 5d
  P05 Memory Domains (M05)              :p05, after p04, 5d
  P06 Event System (M06)               :p06, after p05, 5d
  section Cognition
  P07 Cognitive Runtime Scaffold (M07) :p07, after p06, 7d
  P08 Stages 1-6 (PERCEIVE..DECIDE) (M07):p08, after p07, 5d
  P09 Stage 7-9 (ACT..RESPOND) (M08)   :p09, after p08, 5d
  P10 Stages 10-12 (LEARN..PERSIST) (M09):p10, after p09, 5d
  section Actions
  P11 Action Pipeline (M10)            :p11, after p10, 5d
  P12 Tool Registry (M10)              :p12, after p11, 4d
  P13 Action VERIFY Stage (M10)        :p13, after p12, 3d
  section Tasks & Loops
  P14 Task Executor (M11)              :p14, after p13, 4d
  P15 Loop Manager (M11)               :p15, after p14, 4d
  section Learning & Proactivity
  P16 Learning Pipeline (M12)          :p16, after p15, 5d
  P17 Proactive Engine (M12)           :p17, after p16, 5d
  section Voice
  P18 Voice Plumbing Refactor (M13)    :p18, after p17, 4d
  P19 Live Session State Machine (M13) :p19, after p18, 4d
  P20 Realtime Flow Contract (M14)     :p20, after p19, 3d
  section UI
  P21 UI Shell Refactor (M15)          :p21, after p20, 5d
  P22 Orb R3F Finalization (M15)       :p22, after p21, 4d
  P23 Background Atmosphere (M15)      :p23, after p22, 3d
  section Advanced
  P24 Advanced Modules Opt-in (M16)    :p24, after p23, 7d
  P25 Personality & Modulation (M16)   :p25, after p24, 5d
  section Hardening
  P26 Performance Pass (M17)           :p26, after p25, 5d
  P27 Security Pass (M17)              :p27, after p26, 5d
  P28 Rollout & Migration (M18)        :p28, after p27, 5d
```

### XXVI.1 Phase Index

| Phase | Milestone | Checkpoint | Rollback |
| --- | --- | --- | --- |
| **P01 — Bootstrap & Tooling** | M01 | Repo, scripts, env, CI scaffold | n/a |
| **P02 — Persistence Foundation** | M02 | SQLite + WAL, migrations, schema | Revert migrations |
| **P03 — Identity & Auth** | M03 | Bootstrap, sessions, authZ | Revert migrations |
| **P04 — Domain Schema** | M04 | All tables from Part IX.3 | Revert migrations |
| **P05 — Memory Domains** | M05 | Multi-domain stores, retrieval, provenance | Disable memory service; last verified phase |
| **P06 — Event System** | M06 | EventBus, ordered, replayable | Disable bus; direct call passthrough |
| **P07 — Cognitive Scaffold** | M07 | Runtime, cycle record, 12 stage stubs | Disable cognition; runtime returns passthrough |
| **P08 — Stages 1–6** | M07 | PERCEIVE..DECIDE wired | Disable stages 4-6; return default decision |
| **P09 — Stages 7–9** | M08 | ACT, VERIFY, RESPOND | Disable action; return text-only response |
| **P10 — Stages 10–12** | M09 | LEARN, UPDATE, PERSIST | Disable learning; runtime still persists cycle |
| **P11 — Action Pipeline** | M10 | UNDERSTAND..RESPOND wired | Disable actions; runtime returns refusal |
| **P12 — Tool Registry** | M10 | Tools declared, validated | Disable new tools; no tool execution |
| **P13 — VERIFY Stage** | M10 | VERIFY actually re-reads state | Disable VERIFY; mark unverified in audit log |
| **P14 — Task Executor** | M11 | Tasks run, retry, complete | Disable executor; tasks remain pending |
| **P15 — Loop Manager** | M11 | Loops evaluated, tasks created | Disable manager; no new tasks from loops |
| **P16 — Learning Pipeline** | M12 | LEARN extracts, persists with provenance | Disable extraction; raw conversation still persisted |
| **P17 — Proactive Engine** | M12 | Proactivity decisions made | Disable engine; no proactive messages |
| **P18 — Voice Plumbing Refactor** | M13 | Capture/playback routed through new interfaces | Disable voice capability; text-only mode |
| **P19 — Live Session State Machine** | M13 | State machine enforced | Disable live session; last verified phase |
| **P20 — Realtime Flow Contract** | M14 | All 7 stages wired | Disable realtime; poll-based fallback |
| **P21 — UI Shell Refactor** | M15 | Glassmorphic shell, autonomous state | Disable new shell; minimal UI |
| **P22 — Orb R3F Finalization** | M15 | Orb 12-stage-aware, audio-reactive | Disable R3F orb; placeholder |
| **P23 — Background Atmosphere** | M15 | Atmosphere driven by env state | Disable atmosphere; solid background |
| **P24 — Advanced Modules Opt-in** | M16 | Feature flags, isolation | Disable all modules |
| **P25 — Personality & Modulation** | M16 | Per-identity modulation | Disable; default persona |
| **P26 — Performance Pass** | M17 | All targets met | Revert optimizations |
| **P27 — Security Pass** | M17 | All threats mitigated | Revert hardening |
| **P28 — Rollout & Migration** | M18 | Optional import from legacy DB, validated | n/a (final) |

### XXVI.2 Phase Dependency and Checkpoint Discipline

A phase is **complete** only when all of the following are true:

1. **Implemented** — code written, code compiles, application boots.
2. **Tested** — every required invariant for the phase (Test Categories A–G, Part XXI.2) passes.
3. **Checkpointed** — the corresponding milestone entry in `docs/MADHURITA_STATE.json` is updated and the state file is saved.
4. **No blocking failure** — there is no open failure in `openFailures` that depends on this phase.

If any of the four conditions is not met:

- The phase is **not complete**. It is not advanced past.
- The failure is recorded in `docs/MADHURITA_STATE.json` under `openFailures`.
- The next phase does **not** start.
- The system runs the last verified new phase. There is no skip-ahead and there is no fallback to legacy.

Marking a phase complete when the four conditions are not all met is a forbidden action.

### XXVI.3 Per-Phase Detail

#### Phase P01 — Bootstrap & Tooling (M01)

**Work:** repo hygiene, scripts, env, lint, formatter, CI scaffold.
**Files:** `package.json`, `tsconfig.json`, `eslint.config.*`, `.editorconfig`, `.gitignore`, `.nvmrc`, `scripts/`, `.github/workflows/`.
**Tests:** `npm run lint`, `npm run typecheck`, `npm run test`.
**Checkpoint:** All three pass on a fresh clone.
**Rollback:** n/a.

#### Phase P02 — Persistence Foundation (M02)

**Work:** SQLite + WAL, migration runner, baseline `app_meta` table.
**Files:** `server/persistence/db.ts`, `server/persistence/migrate.ts`, `server/persistence/migrations/0001_init.sql`.
**Tests:** in-memory migration test, WAL behavior test.
**Checkpoint:** `app_meta` row exists; `npm test` passes.
**Rollback:** drop DB file.

#### Phase P03 — Identity & Auth (M03)

**Work:** `identity` + `permission` + `session` tables; bootstrap ceremony; session tokens; `authz.check()`.
**Files:** `server/identity/`, `server/authz/`.
**Tests:** bootstrap test, authZ matrix test, session expiry test.
**Checkpoint:** A first-run owner can authenticate; authZ denies guests.
**Rollback:** drop the three tables.

#### Phase P04 — Domain Schema (M04)

**Work:** every table from Part IX.3 except the `domain_event` table; FKs, indexes.
**Files:** `server/persistence/migrations/0002_domain.sql`.
**Tests:** schema test (every table present, every FK valid).
**Checkpoint:** schema test passes.
**Rollback:** drop new tables.

#### Phase P05 — Memory Domains (M05)

**Work:** typed repositories for episodic, semantic, preferences, habits, relationships, learned patterns; retrieval API; provenance attached.
**Files:** `server/memory/`.
**Tests:** per-domain CRUD test; cross-identity isolation test; provenance presence test.
**Checkpoint:** Retrieval test passes.
**Rollback:** drop memory tables; disable memory service; last verified phase runs.

#### Phase P06 — Event System (M06)

**Work:** append-only `domain_event` log, `EventBus`, replayable subscriptions.
**Files:** `server/events/`.
**Tests:** append/replay test, slow-handler test, ordering test.
**Checkpoint:** Replay test passes.
**Rollback:** disable `EventBus`, direct calls.

#### Phase P07 — Cognitive Scaffold (M07)

**Work:** `CognitiveRuntime` class, 12 stage stubs, `CycleRecord` persistence.
**Files:** `server/cognition/`.
**Tests:** scaffold test (one cycle produces one CycleRecord).
**Checkpoint:** 12 stage stubs return; record persisted.
**Rollback:** runtime returns passthrough, no cycles persisted.

#### Phase P08 — Stages 1–6 (PERCEIVE..DECIDE) (M07)

**Work:** real implementations for stages 1, 2, 3, 4, 5, 6.
**Files:** `server/cognition/stages/{1..6}.ts`.
**Tests:** per-stage unit test, LLM-stage property test (output shape).
**Checkpoint:** A trivial "hello" input walks through stages 1-6 and lands at a default decision.
**Rollback:** stubs return default.

#### Phase P09 — Stages 7–9 (ACT..RESPOND) (M08)

**Work:** real implementations for stages 7, 8, 9.
**Files:** `server/cognition/stages/{7,8,9}.ts`.
**Tests:** response text correctness, action call correctness.
**Checkpoint:** Action is invoked, response is generated.
**Rollback:** action disabled, text-only response.

#### Phase P10 — Stages 10–12 (LEARN..PERSIST) (M09)

**Work:** real implementations for stages 10, 11, 12.
**Files:** `server/cognition/stages/{10,11,12}.ts`.
**Tests:** learning extraction test, persistence test.
**Checkpoint:** A simple conversation leaves behind a preference row.
**Rollback:** stages 10-12 disabled; raw conversation still persisted.

#### Phase P11 — Action Pipeline (M10)

**Work:** `ActionPipeline` class, 7 stage functions, `action_result` table writes.
**Files:** `server/actions/`.
**Tests:** per-stage test, full-pipeline test.
**Checkpoint:** A read-only tool returns verified success.
**Rollback:** ActionPipeline returns refusal; cycle continues without action.

#### Phase P12 — Tool Registry (M10)

**Work:** `ToolDefinition` registry, Zod validation, retry, timeout, deadline.
**Files:** `server/actions/registry.ts`, `server/actions/tools/`.
**Tests:** validation test, retry test, timeout test.
**Checkpoint:** A malformed tool input is rejected.
**Rollback:** disable new tools; last verified phase runs.

#### Phase P13 — VERIFY Stage (M10)

**Work:** VERIFY re-reads authoritative state, asserts postconditions, records pass/fail.
**Files:** `server/actions/stages/verify.ts`.
**Tests:** postcondition assertion test, rollback test.
**Checkpoint:** A simulated tool that doesn't change state is marked unverified.
**Rollback:** VERIFY returns "skipped"; unverified rows logged.

#### Phase P14 — Task Executor (M11)

**Work:** `TaskExecutor` runs tasks, retries with backoff, marks status.
**Files:** `server/tasks/`.
**Tests:** schedule test, retry test, cancellation test.
**Checkpoint:** A one-shot reminder fires at the right time.
**Rollback:** tasks remain pending; executor disabled.

#### Phase P15 — Loop Manager (M11)

**Work:** `LoopManager` evaluates triggers, creates tasks, deduplicates.
**Files:** `server/loops/`.
**Tests:** trigger evaluation test, dedup test.
**Checkpoint:** A loop with a satisfied condition creates exactly one task.
**Rollback:** manager disabled; no loop-derived tasks.

#### Phase P16 — Learning Pipeline (M12)

**Work:** extraction rules, LLM-assisted extraction, dedup, provenance.
**Files:** `server/learning/`.
**Tests:** extraction test, dedup test, provenance test.
**Checkpoint:** "I love jazz" produces a `preference` row with provenance.
**Rollback:** extraction disabled; raw conversation still persisted.

#### Phase P17 — Proactive Engine (M12)

**Work:** candidate generation, decision tree, anti-spam, suppression logging.
**Files:** `server/proactive/`.
**Tests:** decision tree test, rate-limit test, quiet-hours test.
**Checkpoint:** A non-novel candidate is suppressed.
**Rollback:** engine disabled; no proactive messages.

#### Phase P18 — Voice Plumbing Refactor (M13)

**Work:** audio interfaces (`AudioCapture`, `AudioPlayback`) wrapping existing streamer/player.
**Files:** `server/voice/interfaces/`, `src/services/audioStreamer.ts` (re-export shim).
**Tests:** interface test, parity test with legacy.
**Checkpoint:** Refactor preserves current behavior.
**Rollback:** disable voice capability; text-only mode; last verified phase runs.

#### Phase P19 — Live Session State Machine (M13)

**Work:** state machine enforcement, transition guards, error recovery.
**Files:** `server/voice/session.ts`.
**Tests:** transition test, illegal-transition test, recovery test.
**Checkpoint:** Illegal transitions are rejected.
**Rollback:** disable live session; last verified phase runs.

#### Phase P20 — Realtime Flow Contract (M14)

**Work:** SSE + WebSocket fanout, coalescing, sequence numbers, backpressure.
**Files:** `server/realtime/`.
**Tests:** stage-coverage test, coalescing test, slow-client test.
**Checkpoint:** Every mutation is broadcast through all 7 stages.
**Rollback:** disable realtime broadcast; poll-based fallback.

#### Phase P21 — UI Shell Refactor (M15)

**Work:** glassmorphic shell, autonomous state, mobile collapse.
**Files:** `src/components/shell/`, `src/components/state/`.
**Tests:** render snapshot tests, state-driven color test.
**Checkpoint:** New shell renders identical content with new visuals.
**Rollback:** disable new shell; minimal UI.

#### Phase P22 — Orb R3F Finalization (M15)

**Work:** wire orb to all 12 cognitive stages and live audio, finalize shader.
**Files:** `src/components/MadhuritaOrb.tsx`.
**Tests:** mount/unmount test, audio reactivity test, visual regression.
**Checkpoint:** Orb's color/emissive/waveform reflect authoritative state.
**Rollback:** disable R3F orb; static placeholder.

#### Phase P23 — Background Atmosphere (M15)

**Work:** procedural/photographic layers, palette derived from `EnvironmentState`.
**Files:** `src/components/BackgroundAtmosphere.tsx`.
**Tests:** palette-derivation test, transition interpolation test.
**Checkpoint:** Atmosphere shifts cohesively.
**Rollback:** disable dynamic atmosphere; solid background.

#### Phase P24 — Advanced Modules Opt-in (M16)

**Work:** emotion reading, relationship context, long-horizon reflection, dream consolidation.
**Files:** `server/advanced/`.
**Tests:** per-module isolation test, feature-flag test.
**Checkpoint:** All modules disable cleanly.
**Rollback:** flags off.

#### Phase P25 — Personality & Modulation (M16)

**Work:** per-identity persona, verbosity, formality, warmth.
**Files:** `server/personality/`.
**Tests:** persona application test, override test.
**Checkpoint:** Two identities see two tones.
**Rollback:** default persona.

#### Phase P26 — Performance Pass (M17)

**Work:** DPR cap, particle scaling, LLM token ceilings, coalescing tuning.
**Files:** `src/`, `server/`.
**Tests:** perf budget tests, mobile tests.
**Checkpoint:** All Part XXII targets met.
**Rollback:** revert optimizations.

#### Phase P27 — Security Pass (M17)

**Work:** Zod everywhere, audit log hardening, secret handling, backup encryption.
**Files:** `server/security/`, `server/backup/`.
**Tests:** security suite from Part XXIII.
**Checkpoint:** All threats mitigated.
**Rollback:** n/a (additive).

#### Phase P28 — Rollout & Migration (M18)

**Work:** migration script, dual-DB, archive, owner confirmation.
**Files:** `scripts/migrate/`, `docs/`.
**Tests:** dry-run test, rollback test.
**Checkpoint:** Owner confirms, old DB archived.
**Rollback:** n/a (final).

---

## XXVII. LEGACY CLEANUP MAP (KEEP / REBUILD / REPLACE / DELETE / MIGRATE / ISOLATE)

| Class | Meaning |
| --- | --- |
| **KEEP** | Standard config/tooling files. |
| **REBUILD** | Infrastructure adapted to new architecture behind strict interfaces. |
| **REPLACE** | Entirely new implementation replacing the old domain/logic. |
| **DELETE** | Legacy artifacts completely removed. |

### XXVII.1 Backend (`server/`)

| File | Class | Notes |
| --- | --- | --- |
| `db.ts` | REBUILD | Replaced by `server/persistence/`. Existing schema preserved during migration. |
| `auth.ts` | REBUILD | Replaced by `server/identity/` + `server/authz/`. |
| `cognition.ts` | REPLACE | Replaced by `server/cognition/` (12 stages). |
| `cognition-2.ts` | DELETE | Was an interim. |
| `cognitive-adapter.ts` | DELETE | Bridge no longer needed. |
| `cognitive-contract.ts` | DELETE | Superseded by Part VII. |
| `cognitive-decision-engine.ts` | REPLACE | Becomes stage 6. |
| `cognitive-loop.ts` | REPLACE | Becomes `CognitiveRuntime`. |
| `event-system.ts` | REPLACE | Becomes `EventBus` with replay. |
| `event-cognition.ts` | REPLACE | Becomes stage 1 entry point. |
| `learning-pipeline.ts` | REPLACE | Becomes `LearningSystem`. |
| `awareness-engine.ts` | REPLACE | Replaced by new Application-driven awareness components. No legacy runtime modules are preserved in the new architecture. |
| `proactive-engine.ts` | REPLACE | Becomes `ProactiveEngine`. |
| `loop-manager.ts` | REPLACE | Becomes `LoopManager`. |
| `task-executor.ts` | REPLACE | Becomes `TaskExecutor`. |
| `tools.ts` | REPLACE | Becomes `ToolRegistry`. |
| `response-generator.ts` | REPLACE | Becomes stage 9. |
| `runtime-state.ts` | REPLACE | Becomes `RuntimeState` projection. |
| `live-session.ts` | REPLACE | Becomes state machine in `server/voice/`. |
| `weather-service.ts` | REBUILD | Infrastructure adapters deliberately adapted into new architecture. Not run as-is. |
| `backup.ts` | REBUILD | Owner-derived encryption added. |

### XXVII.2 Frontend (`src/`)

| File | Class | Notes |
| --- | --- | --- |
| `App.tsx` | REBUILD | Routes, providers, realtime hooks updated. |
| `main.tsx` | KEEP | Mount point unchanged. |
| `index.css` | REBUILD | New token system. |
| `components/MadhuritaOrb.tsx` | REPLACE | R3F + 12 stages. |
| `components/BackgroundAtmosphere.tsx` | REPLACE | Photographic, env-driven. |
| `components/ExperienceIntro.tsx` | REBUILD | Visual tokens update. |
| `components/OwnerAuthModal.tsx` | REBUILD | New auth ceremony. |
| `components/OwnerSetupModal.tsx` | REBUILD | New bootstrap ceremony. |
| `components/Sidebar.tsx` | REBUILD | New shell. |
| `components/Composer.tsx` | REBUILD | New visual language. |
| `components/AudioVisualizer.tsx` | DELETE | Replaced by R3F orb. |
| `components/chat/*` | REBUILD | New visual language. |
| `components/context/*` | REBUILD | New visual language. |
| `components/home/*` | REBUILD | Autonomous state binding. |
| `components/mobile/*` | REBUILD | New shell, mobile-first. |
| `components/sheets/*` | REBUILD | New visual language. |
| `components/state/*` | REBUILD | New visual language. |
| `components/ui/*` | REBUILD | New visual language. |
| `services/audioStreamer.ts` | REBUILD | Low-level Web Audio infrastructure wrapped behind `AudioCapture` interface adapter. |
| `services/audioPlayer.ts` | REBUILD | Low-level Web Audio infrastructure wrapped behind `AudioPlayback` interface adapter. |
| `services/liveClient.ts` | REPLACE | Becomes thin shell over state machine. |
| `services/stateSync.ts` | REPLACE | Becomes `RealtimeFlow` consumer. |
| `hooks/useApi.ts` | REBUILD | New API surface. |
| `hooks/useBin.ts` | REBUILD | New visual language. |
| `hooks/useCommandFlow.ts` | REBUILD | New visual language. |
| `hooks/useStage.ts` | REBUILD | Driven by RuntimeState. |
| `hooks/useUIState.tsx` | REBUILD | Driven by RuntimeState. |
| `utils/auth.ts` | REPLACE | Server-driven now. |
| `utils/format.ts` | KEEP | Pure utilities unchanged. |
| `utils/searchAndCache.ts` | REPLACE | Server-driven now. |
| `utils/stage.ts` | REPLACE | Driven by RuntimeState. |
| `utils/voiceCommandRouter.ts` | REPLACE | Server-driven now. |
| `utils/weather.ts` | KEEP | Pure weather math, still used. |

### XXVII.3 Tests (`test-*.ts`)

| File | Class | Notes |
| --- | --- | --- |
| `test-architectural-invariants.ts` | REBUILD | Re-targeted at new architecture. |
| `test-deletion-safety.ts` | REBUILD | New schema, new tests. |
| `test-integration.ts` | REBUILD | New integration surface. |
| `test-runtime-audit.ts` | REBUILD | New audit log structure. |

### XXVII.4 Configuration

| File | Class | Notes |
| --- | --- | --- |
| `package.json` | REBUILD | New scripts, new deps as added. |
| `tsconfig.json` | KEEP | Mostly unchanged. |
| `vite.config.ts` | KEEP | Build setup unchanged. |
| `tailwind.config.*` | REBUILD | New token system. |
| `.env` | KEEP | New keys may be added. |

---

## XXVIII. FUTURE-AGENT RESUME PROTOCOL

This is the **first section a future agent reads.** It tells a fresh agent exactly what to do to get up to speed.

### XXVIII.1 Read Order

A future agent resuming work on Madhurita should:

1. Read `docs/MADHURITA_STATE.json`. It contains the current phase, last checkpoint, last failure, last commit, and pointers into this book.
2. Read **Part XXVI.2** of this book for the active phase's detail.
3. Read **Part XXVII** for the legacy cleanup map.
4. Read the **Verification** block of the active part to know what "done" means right now.
5. Run `npm test` and `npm run typecheck` to see the current state.
6. Open the most recent failing test if any, fix it, then return to step 5.

### XXVIII.2 State File Schema (`docs/MADHURITA_STATE.json`)

```json
{
  "version": 1,
  "book": "docs/MADHURITA_BUILD_BOOK.md",
  "currentPhase": "P01",
  "currentMilestone": "M01",
  "lastCheckpoint": "init",
  "lastCommit": null,
  "lastVerifiedAt": null,
  "openFailures": [],
  "activeFeatureFlags": [],
  "notes": "Master plan authored; awaiting approval before implementation."
}
```

A future agent updates this file **at the end of every phase** and **at the end of every work session**, never in the middle.

### XXVIII.3 Hard Rules for Future Agents

- **Never commit without explicit user command.**
- **Never push without explicit user command.**
- **Never replace working infrastructure with a mock.**
- **Never violate Part II (the non-negotiables).**
- **Never start a phase whose predecessor is unverified.**
- **Never mark a phase done without its Verification block passing.**
- **Never invent file paths that aren't in Part XXVII or the current phase.**

### XXVIII.4 If This Book Is Out of Date

If the code and this book disagree:

1. Stop.
2. Note the disagreement in `docs/MADHURITA_STATE.json` under `openFailures`.
3. Ask the user: "The book says X, the code does Y. Which wins?"
4. Update either the book or the code to match the user's answer, then resume.

The user is the final authority over both the book and the code.

---

## APPENDIX A — Verification Index

| Part | Verification | Type |
| --- | --- | --- |
| V | Bootstrap invariant test | Integration |
| VI | Mutation discipline test | Integration |
| VII | 12-stage invariant, interrupt test | Property + integration |
| VIII | Event log replay test, slow-handler test | Property |
| IX | Atomic-mutation test, soft-delete test, audit-log test | Integration |
| X | Cross-identity isolation test, provenance test | Integration |
| XI | Action VERIFY test, unverified-not-surfaced test | Integration |
| XII | Loop dedup test, closed-loop test | Integration |
| XIII | Provenance-on-learning test, no-guest-learning test | Integration |
| XIV | Decision tree test, anti-spam test, disable test | Integration |
| XV | Live-session-mic-required test, TTS-volume test, audio-reactivity test | Integration |
| XVI | Event-broadcast lockstep test, slow-client test, disconnect-recover test | Integration |
| XVII | Visual regression test, palette-derivation test | Visual + unit |
| XVIII | Visual architecture full suite (see XVIII.34) | Visual + integration |
| XIX | Palette-derivation test, transition test | Visual + unit |
| XX | Per-module isolation test, all-off test | Integration |
| XXI | Coverage report | Tooling |
| XXII | Load test, perf test, reduced-motion test | Tooling |
| XXIII | Security suite (Part XXIII.3) | Security |
| XXIV | Secret-not-logged test | Security |
| XXV | Dry-run migration test | Integration |
| XXVI | Per-phase checkpoint | Phase |
| XXVII | Legacy map audit | Manual |
| XXVIII | State-file integrity test | Tooling |

---

## APPENDIX B — Glossary

| Term | Definition |
| --- | --- |
| **Actor** | A human (owner, person, or guest) interacting with Madhurita. |
| **Application Authority** | The principle that the application, not the LLM, is the source of truth for state. |
| **AudioReactiveController** | Module bridging Web Audio analysers to GPU uniforms without React in the loop. |
| **AuthorizedDecision** | A decision proposal that has passed application validation and authorization. |
| **AuthorizedLearningDelta** | A memory extraction proposal validated and scoped by Scoped Learning Policy. |
| **AuthorizedResponse** | A response draft evaluated and authorized under Knowledge Disclosure Policy. |
| **Cognitive Runtime** | The 12-stage cycle that processes every stimulus. |
| **Cycle** | One full pass of all 12 stages. |
| **Cycle Record** | The persisted artifact of a completed (or interrupted) cycle. |
| **DecisionProposal** | An LLM-proposed decision awaiting application validation and authorization. |
| **Domain Event** | A typed, ordered, durable record of something that happened. |
| **Episodic Memory** | Time-stamped memory of an event. |
| **Habit** | A recurring, observed pattern of behavior. |
| **Identity** | A single known actor. |
| **Knowledge Disclosure Policy** | Deterministic application gate on what is surfaced to the caller. |
| **Knowledge Possession** | What's stored in durable state, regardless of who's present. |
| **Knowledge Retrieval Policy** | Deterministic application gate on what is loaded into working context. |
| **Learned Pattern** | A behavior Madhurita has inferred from observation. |
| **LLM Faculty** | The LLM as a reasoning component under strict application authority. |
| **Loop** | A long-running intent the owner has placed on Madhurita. |
| **Open Loop** | An unfinished thread Madhurita is tracking. |
| **OrbRenderer** | R3F / WebGPU module rendering the physical optical sphere. |
| **Person** | A non-owner actor enrolled by the owner. |
| **Preference** | A user-stated liking or setting. |
| **Proactive** | Madhurita-initiated communication. |
| **QualityManager** | Module selecting quality tiers (ULTRA..LOW) based on capability and perf. |
| **Relationship** | A person known to the owner. |
| **Realtime Flow** | The 7-stage contract for broadcasting state changes. |
| **Runtime State** | The single authoritative projection of system state. |
| **Scoped Learning Policy** | Deterministic rules governing what memory is stored and for whom. |
| **Semantic Memory** | Distilled facts about the world. |
| **Soft Delete** | Marking a row deleted without removing it. |
| **Split-Brain** | Forbidden condition where two or more state authorities exist simultaneously. |
| **Stage** | One of the 12 stages of the cognitive cycle. |
| **Task** | Durable, scheduled, executable work. |
| **Tool** | An external capability Madhurita can invoke via the action pipeline. |
| **TSL** | Three Shading Language for WebGPU pipelines. |
| **Verification** | The act of re-reading state to confirm a tool actually did what it said. |
| **VisualStateMapper** | Pure projection from RuntimeState to rendering parameters. |
| **WaterRenderer** | GPU wave simulation, reflection, and refraction plane. |
| **WebGPURenderer** | Primary high-performance Three.js rendering backend. |

---

## APPENDIX C — Decision Log

| # | Decision | Date | Why |
| --- | --- | --- | --- |
| 1 | Madhurita is a persistent cognitive agent, not a chatbot. | 2026-08-31 | Continuity of identity, memory, learning. |
| 2 | The LLM is a faculty, not the application. | 2026-08-31 | Application code must be authoritative. |
| 3 | SQLite for persistence. | 2026-08-31 | Embedded, transactional, debuggable, single-owner scale. |
| 4 | One of everything. | 2026-08-31 | Prevent split-brain, simplify mental model. |
| 5 | Multi-domain memory, not one bag. | 2026-08-31 | Different lifecycles, retrieval, provenance. |
| 6 | No SVG, no illustration, no cartoon. | 2026-08-31 | Photographic, premium, real. |
| 7 | Orb and atmosphere autonomously driven by backend state. | 2026-08-31 | No hand-tuned per-screen palettes. |
| 8 | Causal, micro-phased rollout. | 2026-08-31 | Each phase verifiable, rollback-able. |
| 9 | No commit/push without explicit user command. | 2026-08-31 | Local-only until shipping is requested. |
| 10 | LLM Decision Proposal Ladder (C1). | 2026-09-01 | Enforce application authority over every LLM proposal before execution. |
| 11 | 4-Layer Security Boundary (C2). | 2026-09-01 | Explicit Possession → Retrieval Policy → Working Context → Disclosure Policy. |
| 12 | Scoped Guest Learning Policy (C4). | 2026-09-01 | Replace blanket bans with deterministic 5-outcome evaluation matrix. |
| 13 | Single RuntimeState Authority (C5). | 2026-09-01 | Prevent UI or LLM from holding or mutating competing state. |
| 14 | No Legacy Fallback (C6). | 2026-09-01 | Rollback targets last verified new phase by disabling capabilities, never legacy. |
| 15 | Real Infrastructure Adapters (C7). | 2026-09-01 | Rebuild clean interfaces rather than importing legacy runtime modules. |
| 16 | Fresh DB Rebuild (C8). | 2026-09-01 | System must boot from fresh empty DB; legacy migration is a separate phase. |
| 17 | Strict Phase Checkpoint Discipline (C9). | 2026-09-01 | Four mandatory criteria before any phase is marked complete. |
| 18 | Test Categories A–G (C11). | 2026-09-01 | Structured invariant suite covering Authority, Memory, Runtime, Actions, Proactivity, Isolation, Failure. |
| 19 | WebGPU Primary + WebGL2 Fallback (Visual). | 2026-09-01 | Target AAA-grade visual quality with TSL/WGSL while maintaining broad browser support. |
| 20 | Audio → GPU Pipeline Independent of React. | 2026-09-01 | Eliminate React re-renders for audio frames; direct analyser to uniform flow. |
| 21 | Physically-Inspired Optical Material for Orb. | 2026-09-01 | Real transmission, refraction, Fresnel, and volumetric light; not a flat glass shader. |
| 22 | GPU Water Plane with Real-Time Reflection. | 2026-09-01 | Ground the floating orb with dynamic lake surface, Gerstner waves, and optical interaction. |

---

> **END OF BUILD BOOK v1**
> Status: awaiting user approval. No code implementing the new architecture will be written until approval is granted.
