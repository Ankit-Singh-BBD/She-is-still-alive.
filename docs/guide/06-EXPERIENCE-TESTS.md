# 06 — Show real work and prove the whole journey

[Book](../MADHURITA_BUILD_BOOK.md) · [B07](../build/tasks/B07.md) · [B11](../build/tasks/B11.md)

## Three surfaces, not a wall of dashboards

**Presence:** conversation, clearly labeled microphone/send, current relevant work, important blocker. Familiarity comes from continuity and words, not permanent weather chatter.

**Work:** opened by "dikhao" or a visible Show work control. Show goal, current step, verified steps, timestamp, latest actual artifact (resolved bytes, `content_hash` badge), blockers, pause/resume/cancel. If no active job exists, say so and offer recent work; never animate a fictitious task.

**Review:** completed outcomes, corrections and useful learned lessons with evidence. Diagnosis is available on request; raw internal traces are not the default home screen.

Atmosphere is optional and off by default in the proposed experience. No mandatory orbit/orb scene. Cinematic means confident transitions, good typography, spatial continuity and real progress — never invented progress or fake glow. Effects must not reduce clarity or audio responsiveness.

## The Work surface contract (B07)

- Opened by voice ("progress dikhao" and paraphrases) or a visible control; hiding the panel is a local UI state change, not a job cancellation.
- Shows: goal, per-step status (pending/running/verified/failed/blocked), current running step, artifact version with hash badge, blockers and allowed controls.
- Data comes from `GET /api/work/:id` snapshots and a per-job versioned SSE stream (`GET /api/work/:id/events?cursor=`). The client deduplicates by `eventId`, rejects older `jobVersion`, and refetches a snapshot on gaps.
- Controls (`pause`, `resume`, `cancel`) are durably recorded with `{requestId, expectedVersion}`; a stale version yields 409 with the current version. Duplicate `requestId` returns the original result. `stopSpeaking` is not a job cancellation.

## View behavior and reconnect

Show/hide is local UI state. Job commands use the work API. Reopening a view reads the latest snapshot. After disconnect show `lastUpdated` and stale status; reconnect fetches authoritative state and resumes events from a cursor where supported. Deduplicate event IDs, reject older versions, and fetch a snapshot on gaps. Coalesced visual updates may skip intermediate frames; durable activity history must remain separately readable.

Display percentages only for measured units. Unknown totals show phase/elapsed time. Do not show model private reasoning; show concise action explanations, tool activity and evidence instead.

Use semantic controls, visible labels, keyboard operation and focus restoration. Dialog-like overlays need focus management, Escape, and an accessible name. Body text should remain readable at 200% zoom. Test contrast on actual backgrounds, reduced motion (`prefers-reduced-motion`), small screens and microphone permissions. Do not hide a critical error in faint clipped 11px text.

## Golden journey catalog

These IDs remain stable. Test fixture words vary; do not code answers to individual examples.

| ID | Setup/action | Required observation |
|---|---|---|
| J01 | Owner has preferred address; greets in Hinglish | familiar, correct language; no invented work |
| J02 | Two real open jobs; asks what remains | names real priority/deadline/blocker |
| J03 | Approved brief goal; asks to work | durable job accepted, eventual real artifact |
| J04 | Running job; asks to show | current steps and actual artifact version |
| J05 | Hide view, close tab, reopen | server work continues; snapshot is current |
| J06 | Kill process after tool effect before acknowledgement | recover without duplicate logical effect |
| J07 | Cancel while completion races | no cancelled→completed overwrite; existing effect explained |
| J08 | Correct preference; restart | next response follows corrected preference |
| J09 | Quota/network unavailable | no paid call; useful blocked/qualified fallback state |
| J10 | Ask why work failed | fresh evidence, affected work, attempted recovery and next step |
| J11 | Interrupt speech | obsolete response audio stops; job remains unless cancelled |
| J12 | Unseen wording and changed source documents | general logic works, not memorized fixtures |

J04/J05 are gated by B07. J08/J12 by B09. J10 by B10. J11 by B08. All 12 are required for the release gate in B11.

## Layers of proof

Contract tests validate schemas and state transitions. Integration tests use a real disposable SQLite database and production services. Crash tests kill and restart a child process over a temporary file DB. Browser tests exercise actual clicks, keyboard, SSE reconnect and artifact rendering. Provider probes test real account access. Listening tests use real recorded owner speech with permission.

Fakes belong at external boundaries for deterministic failures. They do not prove live provider quality. A hand-authored artifact in a test does not prove the agent produced it. Assert persisted outputs, evidence and effects, not merely that a mocked method was called.

## Release evidence

Run existing typecheck, lint, full tests and build, then the new journey suite. Record tested revision plus dirty-file fingerprint, platform, model versions, hardware, scenario seeds, test hashes, command/exit code, timestamps and artifact paths. B01 validates evidence metadata; it cannot certify subjective voice quality.

Zero observed false completion, duplicated effects or unauthorized dispatch is required across the acceptance suite. This is not a statistical claim of zero failure in the world. Compare voice with the owner's chosen baseline using paired blind ratings. Report p50/p95 latency and failures, not just best examples. Never lower an acceptance threshold because a candidate failed.

Release requires all J01–J12, evidence-backed task gates, restore/restart checks, declared offline limitations and owner sign-off on subjective experience. Otherwise label the release `partial`/`blocked` and name exactly what is absent.
