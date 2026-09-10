# 02 — Connect the parts like labeled wires

[Book](../MADHURITA_BUILD_BOOK.md) · [Work contract](03-WORK-CONTRACT.md)

**Existing** means found in the baseline. **Planned** means implement in the named task. A directory in this chapter is not proof that it already exists.

## The three-layer house

```
Layer 1 — FACULTIES (dimag)
  server/llm/provider.ts   Faculty + FacultyProvider interface
  server/llm/router.ts     picks faculty by role/budget/mode
  server/llm/gemini.ts     one provider behind the interface (replaceable)
  Modes: local-only | hybrid | quality  (see 04-VOICE-MODELS)

Layer 2 — COORDINATOR + WORK TABLES (durable body)
  server/work/contracts.ts, repository.ts
  server/work/coordinator.ts        leases, fences, heartbeats
  SQLite = single source of truth — every body part writes here

Layer 3 — TOOLS + HEALTH + VOICE (haath/aankh/awaj)
  server/tools/*, server/actions/registry.ts
  server/health/*                   probes, observations, bounded recovery
  server/voice/live/, src/lib/voice.ts
  server/conversation/coordinator.ts  ResponseFrame
```

Layers speak through interfaces. The UI never imports server services; repositories never import React. Replace the LLM by replacing the provider — not the architecture.

## The complete route

```text
owner text / microphone
       |
conversation coordinator ---- read user preferences + recent references
       |                           |
       |                  Faculty proposes intent or a plan
       |
       +-- conversation --> ResponseFrame --> approved words --> text / speech
       |
       +-- show/hide ------> local view intent (no task mutation)
       |
       +-- work request ---> validate plan + permissions + budget
                                     |
                              commit job + outbox
                                     |
                              acknowledge accepted
                                     |
                          durable worker claims one step
                                     |
                        registered tool --> actual effect
                                     |
                        verifier rereads authoritative result
                                     |
                          transaction: result + next state + event
                                     |
                   +-----------------+------------------+
                   |                 |                  |
              work projection    learning queue     health observations
                   |
              SSE snapshot / events --> actual artifact on screen
```

The browser is a window. Closing the window must not close the workshop. A server that is powered off cannot work: durable state means resume later, not computation without electricity.

## Who owns what?

| Part | Existing seam | Planned addition | Owner of changes |
|---|---|---|---|
| Composition | `server/app.ts` | instantiate WorkRepository, WorkCoordinator, health and learning workers once | app root only |
| Conversation | `server/http/routes/conversation.ts`, `server/cognition/` | `server/conversation/coordinator.ts` and ResponseFrame | B06 |
| Work state | `server/persistence/` | `server/work/contracts.ts`, `repository.ts` | B03 |
| Work execution | `server/actions/`, `server/tasks/` | `server/work/coordinator.ts` | B04 |
| Tools | `server/tools/`, `server/actions/registry.ts` | work-tool adapter and artifact/source tools | B05 |
| Read API | `server/http/` | `server/http/routes/work.ts` | B07 |
| Realtime | `server/events/`, `server/realtime/` | per-job versioned projection | B07 |
| UI | `src/ui/App.tsx`, `Presence.tsx` | `src/ui/WorkView.tsx`, `src/state/useWork.ts` | B07 |
| Models | `server/llm/types.ts`, `gemini.ts` | `server/llm/provider.ts`, `router.ts` | B08 |
| Voice | `server/voice/live/`, `src/lib/audio/` | response-ID-aware streaming path | B08 |
| Learning | `server/learning/`, `server/memory/` | correction and skill-evaluation records | B09 |
| Diagnosis | `server/autonomic/`, events | `server/health/` | B10 |

`server/conversations/` remains the existing history repository. The planned singular `server/conversation/` owns coordination, not a second history store. If renaming for clarity, do it as a separate recorded refactor, not while implementing behavior.

## Faculty contract

`server/llm/provider.ts` defines `Faculty` and `FacultyProvider`. Every model — hosted or local — implements the same interface. `server/llm/router.ts` selects a faculty by `FacultyRole` (reason/decide/respond/learn/live), budget and mode. On timeout/quota it returns a bounded `unknown` or heuristic result; it never silently switches to a paid route. Swapping the provider does not change `server/app.ts` call sites.

## Interfaces to implement and test

These are specification signatures, NOT current exports. B03 creates their Zod schemas and TypeScript types together.

- `acceptWork(caller, request, requestId) -> AcceptedJob`: returns a durable job ID and state, never an invented success.
- `readJob(caller, jobId) -> WorkSnapshot`: checks access and returns version, status, step summaries, artifact references and pending approvals.
- `requestPause/Resume/Cancel(caller, jobId, expectedVersion, requestId)`: compare version, persist intent, return current state. Stale version gives a conflict with current version.
- `claimStep(workerId, now) -> Lease | null`: only the repository grants leases.
- `executeStep(lease, toolInput, signal) -> AttemptOutcome`: adapter checks tool schema and current clearance before dispatch.
- `verifyAttempt(attemptId) -> VerificationEvidence`: authoritative re-read, not model self-grading.
- `buildResponseFrame(turn, workSnapshot, memoryContext)`: separates confirmed facts, unknowns and proposed actions.

Use opaque monotonic IDs from the existing ID module. Time is injectable. Repositories do not know React; React does not import mutable server services. Shared contracts must be safe to bundle without database/credential imports.

## First complete use case: a source-backed brief

Owner approves sources and asks for a brief. Coordinator creates a DAG: fetch selected sources → extract cited claims → draft → check supported claims → save artifact. Fetching can run concurrently; draft waits for successful inputs. Verification failure keeps the artifact a draft. The workspace can show partial drafts clearly labeled.

First implement this against owner-provided text documents. That makes the full workflow testable offline. Then add approved network sources and record fetch time, source URL, content hash and unavailable sources. Do not claim web research is available in local-only mode.

## What happens to the old twelve stages?

Do not delete the existing runtime on day one. B02 stabilizes it. B06 adds a narrow coordinator in front of existing text and voice callers. Existing memory/identity/action checks remain reusable services. New long jobs go to the work engine; old reminders continue through the stabilized task adapter.

Keep an explicit routing table: greeting/conversation, work request, work status, view command, correction, control command, clarification. Exactly one owner of dispatch. Do not run both legacy execution and new job creation for the same turn. A feature switch is allowed only with tests proving the two routes do not double-execute.

## Transactions versus network calls

A database transaction is like stapling several notebook pages together: either all pages appear or none do. It cannot undo an email already sent by another service. Keep local state plus outbox append in one short SQLite transaction. Do network work outside transactions. Reconcile external outcomes using provider receipts/idempotency before retrying.

No row is `verified` merely because a transaction committed. The transaction preserves a verification result; the verifier establishes whether the intended effect exists.

## Connecting a new capability

Declare tool input/output and effect class → implement real adapter → implement independent postcondition → register both → expose its schema to planning → add one owner-journey test → include it in capability health. If any wire is absent, it stays unavailable. A tool listed in a prompt without a connected executor is a defect.
