# Madhurita Build Book v2 — a companion that actually does the work

This is the new product specification and tutorial index. It replaces v1, including its fixed twelve-stage requirement, blanket ban on diagnostic views, and claim that a prose inventory cannot become stale. Old versions remain in Git history. Existing source comments referring to Parts I–XXVIII are historical references, not instructions to restore the old design.

**Read this like a school project:** first understand the thing, then connect one small part, test it, and write down what happened. You do not need to remember the whole book. A small model does not become a stronger model by reading this book; the build process gives it smaller jobs and checks its work.

**Status:** specification written; v2 application work has NOT been performed by this documentation change. Every task starts pending. The build supervisor described here is also a deliverable, not an already-installed tool.

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
