# 03 — Work that survives interruption

[Book](../MADHURITA_BUILD_BOOK.md) · Implementation: [B03](../build/tasks/B03.md), [B04](../build/tasks/B04.md)

## A job is a folder; steps are pages

A **job** is “prepare my brief”. A **step** is “fetch source A”. An **attempt** is one execution of that step. An **artifact** is the actual saved brief. A **receipt** is evidence from a tool/provider. A **lease** says which worker may act right now. A **fencing token** is the lease generation number: an old worker cannot overwrite a new worker's result.

All records below are PLANNED. Implement schemas and migrations before execution.

## Records and constraints

Use existing identity IDs and application ID generation. Store timestamps consistently as epoch milliseconds in new tables. Do not silently reinterpret old timestamp columns. JSON columns contain validated data with `schemaVersion: 1` where objects evolve.

| Table | Required fields and constraints |
|---|---|
| `work_job` | id PK, identity_id FK, request_id, goal, status, version, created_at, updated_at, deadline_at nullable, max_runtime_ms, max_model_calls, model_calls_used, max_cost_units, cost_units_used, priority, control_intent nullable; UNIQUE(identity_id,request_id) |
| `work_step` | id PK, job_id FK, position, tool_id, input_json, status, version, next_eligible_at, max_attempts, lease_owner nullable, lease_expires_at nullable, fence integer default 0; UNIQUE(job_id,position) |
| `work_dependency` | step_id FK, depends_on FK; composite PK; application verifies both are same job and graph has no cycles |
| `work_attempt` | id PK, step_id FK, occurrence_key, ordinal, fence, status, started_at, ended_at nullable, idempotency_key, provider_receipt nullable, result_json nullable, error_code nullable, verification_json nullable; UNIQUE(step_id,occurrence_key,ordinal) |
| `work_artifact` | artifact_id, version, job_id FK, step_id FK, kind, media_type, content_hash, content_ref, created_at, verification_status; PRIMARY KEY(artifact_id,version); immutable content versions |
| `work_outbox` | id PK, job_id FK, job_version, type, payload_json, created_at, published_at nullable; UNIQUE(job_id,job_version) |
| `work_approval` | id PK, job_id FK, plan_hash, action_scope_json, status, requested_at, expires_at, decided_at nullable, decided_by nullable |

`max_cost_units` is integer micro-units of the configured currency, not floating-point dollars; currency and pricing version are recorded in the budget policy. For zero-paid mode, max permitted paid spend is zero and unpriced hosted calls are refused. Reserve estimated call budgets atomically before dispatch, reconcile actual usage afterward, and do not oversubscribe with concurrent calls.

Artifact content may initially be stored as SQLite text/BLOB through an artifact repository to preserve atomicity for small documents. Set a tested size limit. Future filesystem artifacts require atomic rename and crash reconciliation; do not expose arbitrary host paths in API responses.

## Status meanings

Jobs: `queued`, `running`, `waiting_approval`, `blocked`, `paused`, `verifying`, `completed`, `failed`, `cancelled`.

Steps: `pending`, `running`, `retry_wait`, `reconciling`, `waiting_approval`, `blocked`, `verified`, `failed`, `cancelled`.

Attempts: `started`, `returned`, `verified`, `failed`, `unknown`.

A job is completed only when every required step is verified and all required artifacts satisfy their acceptance rules. It is not completed because a model finished its answer. A recoverable outage is blocked/retry_wait, not permanent failure.

## Legal transitions

- queued → running when an eligible first step is leased.
- running → verifying when required execution has returned and final acceptance remains.
- verifying → completed only on evidence; verifying → running for a bounded repair; otherwise blocked/failed.
- queued/running/verifying → waiting_approval, blocked or paused when a recorded condition requires it.
- paused/blocked/waiting_approval → queued only after explicit resume or recorded resolution, with fresh approval where necessary.
- Any nonterminal job → cancelled only after dispatch stops and in-flight effects are reconciled. Until then store `control_intent=cancel` and show “stopping”.
- completed/failed/cancelled are terminal. A retry of terminal work creates a linked new job, not rewritten history.

## Claim, execute, verify: exact worker algorithm

1. In a short transaction select an eligible step: job permits dispatch, dependencies verified, budget available, next_eligible_at reached, no live lease. Order by owner priority, then oldest eligible time, then ID.
2. Compare-and-update its version. Set running, worker ID and expiry; increment fence; insert the attempt with the SAME fence. Reserve the call budget. Commit. A losing worker gets no lease and performs no effect.
3. Resolve input references from verified dependency artifacts. Validate the resolved input against the tool schema. Recheck permission, approval plan hash and cancellation before dispatch.
4. Call the real tool outside the transaction. Pass timeout, AbortSignal where supported, idempotency key and a progress callback. Heartbeat the lease only while the worker is alive and still owns its fence.
5. Record returned result/receipt, then reread the authoritative effect. A successful HTTP status alone is not the business postcondition.
6. In one transaction, conditional on the current fence/version, store evidence, update step/job, increment job version, append one aggregate change to outbox. Do not accept a stale worker's state writes.
7. Publish the outbox event after commit. A crash can cause redelivery, so consumers deduplicate by event ID/version. Publication is at-least-once, not magical exactly-once delivery.
8. Release the lease; schedule eligible next steps. A final job verifier checks goal-specific acceptance before completion.

Fencing protects our database, not an external service that ignores fencing. For external writes use provider idempotency or reconcile the effect before any retry. If neither is possible, mark unknown/blocked and ask for review. Never claim universal exactly-once execution.

## Idempotency and repeated schedules

The same accepted request ID returns the same job. A caller gets a request ID before sending and retains it across a network retry. A new intentional request gets a new ID.

An external effect key is stable across retries of the SAME logical step occurrence; attempt IDs are different. A later scheduled occurrence has a different occurrence key. Store the occurrence and next due time durably, with a uniqueness constraint preventing duplicate occurrence creation.

Use an explicit IANA timezone on schedules. Document behavior for daylight-saving gaps/overlaps: skip nonexistent wall times and choose the first occurrence of repeated wall times by default; show this policy to the owner. Compute next occurrence from the schedule anchor, not from task finish time. Missed schedules default to one catch-up plus a recorded skipped-count, not a burst of all missed runs.

## Pause, hide, cancel and stop speaking

- Hide: local UI state only; no job API call.
- Pause: prohibit new step dispatch; finish or reconcile the current safe boundary, then mark paused.
- Cancel: persist control intent immediately; signal supported tools; reconcile what already happened; never overwrite cancelled with completed.
- Stop speaking: flush audio for one response ID. It does not cancel a job unless the owner asks to stop the work.
- Resume: fresh version/permission/approval check; continue from verified steps, never repeat them just to rebuild the screen.

If the provider cannot abort, say “Stopping after the current operation”; do not claim the operation stopped. Keep receipts for effects that happened before cancellation.

## Crash recovery

On boot load nonterminal jobs. Live leases remain owned until expiry. Expired running attempts become reconciling. Check provider receipt/idempotency: effect exists → verify it; confirmed not dispatched → retry within budget; unknown → block. Verified steps never rerun. Do not set all running work back to pending indiscriminately.

Local DB write plus outbox write must be atomic. Add crash injection before/after claim, dispatch, provider success, artifact persistence and event publication. A retry must preserve the original effect key.

## Progress is an observation, not a timer

A progress event contains jobId, stepId, jobVersion, eventId, timestamp, phase, completedUnits/totalUnits when meaningful, and latest artifact references. If the total is unknown, show an indeterminate phase and elapsed time. Model tokens generated are not percent of research completed.

Artifact rows need a stable logical artifact ID plus immutable version. Implement their primary key as (artifact_id,version), not a global primary key on artifact_id alone; the introductory table's id names the logical identity. Step/job links remain present on every version. content_ref must resolve through the artifact repository to bytes whose hash matches content_hash.

## API contract for B07

Planned endpoints: POST /api/work, GET /api/work, GET /api/work/:id, POST /api/work/:id/pause, /resume, /cancel, and GET /api/work/:id/artifacts/:artifactId/versions/:version. Acceptance returns 202 only after job persistence. Reads return 200; access/missing resources use the project's existing error conventions; stale expectedVersion returns 409 with current version. Duplicate request IDs return the original accepted result.

Write bodies carry requestId and schemaVersion; control bodies also carry expectedVersion. Reuse authenticated caller resolution; never accept identityId from the request body as authority. WorkSnapshot contains schemaVersion, jobId, version, status, controlIntent, timestamps, step summaries, artifact descriptors, blockers and allowed controls. Exclude provider credentials and raw internal traces.

## Required invariant examples

Two workers race → one logical effect. Success without postcondition → not completed. Hide tab → job progresses. Crash after external success → reconcile, not duplicate. Cancel versus finish → legal monotonic outcome with receipt. Reconnect → latest snapshot and retained artifact. Failed outbox publish → event later replays. Unsupported input reference, cyclic plan or unbounded budget → reject before acceptance.
