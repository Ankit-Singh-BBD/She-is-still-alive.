# Madhurita Build Book v3 — a companion that actually does the work

This is the new product specification and tutorial index. It replaces v2, including its prose-only model/provider description and truncated B07 task card. Old versions remain in Git history. Existing source comments referring to Parts I–XXVIII are historical references, not instructions to restore the old design.

**Read this like a school project:** first understand the thing, then connect one small part, test it, and write down what happened. You do not need to remember the whole book. A small model does not become a stronger model by reading this book; the build process gives it smaller jobs and checks its work.

**Status:** specification written; v3 application work has NOT been performed by this documentation change. Every task starts pending. The build supervisor described here is also a deliverable, not an already-installed tool.

**Safety note:** Six frontend files and three UI reference images existed only in the git index at a past revision (see `.claude-omniroute` memory). Never run `git reset --hard`, `git clean -fd`, or `git checkout -- .` in this repository. Create branches, never destroy the index.

## The one-sentence goal

Madhurita remembers the owner's goals and preferences, performs permitted work, shows actual work on request, continues when the view is hidden, reports problems honestly, and learns useful lessons from evidence.

She is not a promise of consciousness, general human-level intelligence, or unlimited free computing. A pleasant voice is not proof of intelligence. A green unit test is not proof of a useful product.

## Start here

- **New to technology:** begin with [FIRST DAY — Hindi walkthrough](guide/07-FIRST-DAY.md). It explains the tools, commands, vocabulary and how to ask an agent to build.
- **Builder or agent:** read [START](guide/00-START.md), then the next task in [PLAN](build/PLAN.json).
- **Owner:** read [the intended experience](guide/01-VISION.md) and [voice/model choices](guide/04-VOICE-MODELS.md).
- **What exists today:** [inventory](MADHURITA.md). It is a dated static review, not a current health check.
- **Resuming after forgetting:** [CHECKPOINT](build/CHECKPOINT.json). Reconcile it with files and evidence; never trust a claimed completion without checking.

## Chapters: which question does each answer?

| Chapter | Simple question |
|---|---|
| [00 START](guide/00-START.md) | What exactly do I read and do next? |
| [01 VISION](guide/01-VISION.md) | What should living with Madhurita feel like? |
| [02 CONNECTIONS](guide/02-CONNECTIONS.md) | Which part talks to which other part? |
| [03 WORK CONTRACT](guide/03-WORK-CONTRACT.md) | How does work survive failure, restart and interruption? |
| [04 VOICE & MODELS](guide/04-VOICE-MODELS.md) | Why are models needed, and how are they selected without imaginary promises? |
| [05 MEMORY & HEALTH](guide/05-MEMORY-HEALTH.md) | What does learning mean, and how does she diagnose herself? |
| [06 EXPERIENCE & TESTS](guide/06-EXPERIENCE-TESTS.md) | What does the owner see, and what proves that it works? |

## The three-layer house

Madhurita's runtime is layered so one layer can be improved without rebuilding the others. Layers speak through interfaces, not direct imports of each other's internals.

```
Layer 1 — FACULTIES (dimag)
  server/llm/provider.ts  → Faculty interface + FacultyProvider factory
  server/llm/router.ts    → role-based routing (reason/decide/respond/learn/live)
  server/llm/gemini.ts    → one provider implementation (replaceable)
  Any LLM is usable if it implements the Faculty interface.
  Modes: local-only / hybrid / quality (see 04-VOICE-MODELS).

Layer 2 — COORDINATOR + WORK TABLES + WORLD MODEL (durable body + duniya ki samajh)
  server/work/contracts.ts, repository.ts, coordinator.ts
  server/world/model.ts, world/people.ts, world/calendar.ts  ← NEW in v3
  WorldModel: time + weather + location + people + calendar + devices
  SQLite is the single source of truth — every body part writes there.
  All durable state: jobs, steps, artifacts, leases, outbox events, world.
  Restart = resume from DB. No in-memory Map is authoritative.

Layer 3 — TOOLS + HEALTH (haath/aankh)
  server/tools/*, server/actions/registry.ts, server/health/*
  Real adapters with independent verifiers.
  Health probes report what is actually available right now.
```

Detail: [CONNECTIONS](guide/02-CONNECTIONS.md). Planned seams: [B08](build/tasks/B08.md), [B10](build/tasks/B10.md).

## WorldModel — weather is one signal among many

`server/environment/` today is weather-centric: Open-Meteo is the only polled external feed, weather owns the only sweep timer and the only palette modifier. That was the cheapest signal to build, not the intended hierarchy.

v3 corrects this: weather becomes **one field in `WorldModel`**, not the center.

```
WorldModel {
  time:       TimeOfDay            // from clock + solar (already exists)
  weather:   WeatherSnapshot       // Open-Meteo — one modifier, ~15min TTL
  location:  Location | null       // coarse, opt-in, weather's prerequisite
  people:    PeopleGraph           // who matters, relation, recent context
  calendar:  CalendarSnapshot      // next event / busy-free — when permitted
  devices:   DeviceSnapshot        // online, battery, mic, network health
}
```

Rules:
- Every field may be `unknown`/`null` independently. Missing weather, missing calendar, or missing location **must not block** greeting, work, memory or conversation.
- Weather stays a **modifier** (desaturate/darken the hour's palette), never a center of identity. See `server/environment/palette.ts` rule: `unknown` weather applies no modifier.
- Each field has its own freshness TTL and probe; no single feed drives the sweep timer.
- Calibration, consent and polling policy live with each field — e.g. `PeopleGraph` is built from explicit owner-told relationships and permitted history, not scraped contacts.

Planned: `server/world/model.ts` aggregates these feeds for `ResponseFrame` and health. See 01-VISION awareness priorities and B10.

## LLM-agnostic Faculty contract

All language-model access goes through one interface. The rest of the application does not import `@google/genai` (or any other SDK) directly.

```ts
// Planned: server/llm/provider.ts
interface Faculty {
  id: string;                      // e.g. "gemini-flash", "local-qwen"
  role: FacultyRole;               // reason | decide | respond | learn | live
  complete(prompt: FacultyPrompt): Promise<FacultyResult>;
}
interface FacultyProvider { createFaculty(role: FacultyRole): Faculty; }
type FacultyRole = 'reason' | 'decide' | 'respond' | 'learn' | 'live';
```

- **Swapping the LLM does not change the architecture.** Replace the provider implementation behind the interface.
- **Fallback is deterministic:** on timeout/quota, the router returns a bounded `unknown` / heuristic result, not a silent paid call. Zero-paid default is enforced there.
- **Evaluation is held-out:** a faculty is promoted only after passing held-out owner tasks (see 04-VOICE-MODELS and B08 gate).

## Madhurita as an independent entity — who she knows

Madhurita is not a mirror that only talks about the owner. She is a **real entity with her own understanding** who lives in the owner's world.

- She knows **people**, not just preferences: Pepper Potts, the owner's daughter, colleagues, family — who they are, how they relate to the owner, what was last said, and what is permitted to remember about each person. This is the `PeopleGraph` — an explicit, consent-scoped graph, not a scraped address book. Planned tables/fields extend the existing `relationship` domain (B09/B10).
- She knows **environment**, not just weather: where the owner roughly is, what time it is there, whether a calendar block is active, whether a device is offline — the `WorldModel` above. This lets her act independently: "Sir, aapne Pepper se kal mana kiya tha, phir wahi kar rahe ho — yaad dilau?"
- She has a **stance**: within ResponseFrame she may add a grounded, brief independent observation when the world state warrants it — e.g. whispering because a meeting is active, or noting a prior commitment to another person. She never invents people or events; every such line cites a verified world fact.
- **Privacy boundary:** WorldModel respects per-person consent and per-feed permission. A person unknown to the system is not hallucinated. See 01-VISION.

## UI principles

- **Single source of truth → pure projection.** The UI reads snapshots and events from the server. It holds no durable work state. Every user intent becomes an API call → DB write → outbox event → SSE → UI update.
- **Every interaction is an event the body knows.** Clicking "pause", closing a panel, saying "stop speaking" — each produces a server-observable record. No `onClick` that the brain never sees.
- **Capability-driven surfaces.** The ribbon shows currently available capabilities (research, document, browser, etc.) with health dots from `HealthObservation`. What is shown depends on what is actually available and what is running.
- **Cinematic = real progress + verified artifacts + transitions.** No invented percentages, no mock progress, no fake glow. Good typography, spatial continuity, measured phases, artifact `content_hash` badges. Effects must not hide latency or block audio.

Detail: [EXPERIENCE & TESTS](guide/06-EXPERIENCE-TESTS.md). Planned UI: [B07](build/tasks/B07.md).

## What "AGI-like learning" means here

It is an aspiration for transfer: a lesson from one task helps a different task. This book implements a **testable skill lifecycle**, not weight training or open-ended self-modification.

```
candidate skill (from completed jobs)
  → sandbox evaluation on HELD-OUT cases
  → compare vs baseline
  → gate → PROMOTE (versioned, recorded on new jobs)
  → rollback on regression
```

- Skills are versioned recipes (conditions, tool schema versions, steps, evidence requirements). They never execute arbitrary generated code.
- Model-weight fine-tuning is explicitly NOT in scope for this release. It would require a separate curated dataset, compute budget, evaluation and owner approval.

Detail: [MEMORY & HEALTH](guide/05-MEMORY-HEALTH.md) and [B09](build/tasks/B09.md).

## Build order

| Task | Result | Depends on |
|---|---|---|
| [B00](build/tasks/B00.md) | Measured baseline and actual hardware/provider constraints | nothing |
| [B01](build/tasks/B01.md) | Restart-safe build packet/checkpoint verifier | B00 |
| [B02](build/tasks/B02.md) | Existing task/loop reliability repaired | B01 |
| [B03](build/tasks/B03.md) | Durable work records and executable contracts | B02 |
| [B04](build/tasks/B04.md) | Leased, restart-safe work coordinator | B03 |
| [B05](build/tasks/B05.md) | First useful multi-step workflow with real artifacts | B04 |
| [B06](build/tasks/B06.md) | Conversation routes to work and accurate responses | B05 |
| [B07](build/tasks/B07.md) | On-demand live work view and reconnect | B06 |
| [B08](build/tasks/B08.md) | Measured model routing and interruptible voice | B07 |
| [B09](build/tasks/B09.md) | Correctable memory and evidence-backed skill learning | B08 |
| [B10](build/tasks/B10.md) | Health probes, bounded recovery and useful initiative | B09 |
| [B11](build/tasks/B11.md) | Integrated owner journeys and honest release report | B10 |

These tasks are milestones, NOT single prompts. Each task lists small slices. The runner feeds one slice at a time. Do not ask a 3B model to implement a whole milestone in one answer.

## Model names in this book

Strings like `gemini-3.5-flash-lite` or `gemini-3.1-flash-live-preview` found in `.env.example` or `server/config/env.ts` are **repository examples**, not verified availability/price/quality claims. Before selecting a model, verify against the provider's current listing AND a real minimal request on the owner's authorized account, then pin the version. See [VOICE & MODELS](guide/04-VOICE-MODELS.md).

## Mac integration roadmap (planned, not required for release)

| Stage | What it adds | Files / mechanism |
|---|---|---|
| 1. Stay alive | Survive terminal close; restart on crash/reboot | `scripts/launchd/com.madhurita.plist`, `scripts/launchd/install.sh` (`launchctl load`) |
| 2. Menu bar | Tray icon, show/hide, quit, health dot | Tauri wrapper (separate branch), talks to same `server/` HTTP |
| 3. Hotkey | Global "talk" shortcut | Hotkey registered in wrapper, e.g. Option+Space |
| 4. Siri bridge | "Hey Siri, ask Madhurita…" | Apple Shortcuts / AppleScript invoking HTTP |

`server/` does not change for stages 1–4. No work may be started without an approved goal even when launched from Siri. This book does not promise these stages in the same release as B11.

## Rules that remain true in every chapter

1. A model proposes meaning, plans or wording. Application code validates and authorizes effects.
2. Only evidence earns `verified`. `accepted`, `started`, `returned`, `verified`, `notified` and `seen` mean different things.
3. Long-running work belongs to a durable coordinator, not to a browser tab or a waiting chat request.
4. One durable source may have many worker processes and projections. Multiple workers are fine when leases and versions prevent competing ownership.
5. A view may open or close locally. That is not a competing database. Never send a persistent task cancellation merely because its panel closed.
6. A failed dependency yields a useful limited state, not a fake completion. No paid fallback without explicit owner permission.
7. Observations, inferences and confirmed facts remain distinguishable. Corrections must affect subsequent behavior.
8. Preserve existing useful code, owner data, migrations, authorization, provenance and regression tests. No clean-slate data deletion.
9. No new dependency without checking its identity, license, compatibility, necessity and installation source.
10. Do not edit acceptance tests to make broken behavior pass. Contract changes require a recorded owner decision and a regression review.

## What this book cannot guarantee

No document can remove every flaw, fit every possible context window, make every 3B model competent, or force an agent platform to keep running. External orchestration, enough hardware, executable tests and review are required. Zero observed failures in a finite test set is not zero possible failures.

The owner's ambition stays high. When budget and quality conflict, report the conflict rather than secretly lowering the target. A narrower product delivered honestly is better than claiming general intelligence.

## Change discipline

The user's current instruction governs product intent. Evidence governs claims about the implementation. These docs never override platform/system instructions. A source comment is context, not permission to change the goal.

This request authorizes the documentation rewrite. Later implementation, deployments, account changes and external side effects follow their own explicit authorization. Keep updates reviewable on a working branch; do not merge or deploy merely because a task passed.
