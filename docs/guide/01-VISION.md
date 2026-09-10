# 01 — What should she feel like?

[Book](../MADHURITA_BUILD_BOOK.md)

## Think of a reliable teammate, not a talking search box

A reliable teammate knows what you agreed, remembers your preferences, works when appropriate, and tells you what actually changed. Familiar language makes that comfortable. It does not replace the work.

The product promise is **continuity + competence + initiative + inspectability**. Intelligence is measured by useful behavior under new situations, not a glowing object or the number of internal stages.

## Six owner journeys

| Owner says | Required behavior | Forbidden shortcut |
|---|---|---|
| "Hello darling" | A familiar greeting such as "Hello boss", using the owner's chosen address and language | Always asking "How may I assist you?" or pretending to have been working |
| "Kya bacha hai?" | Read real open jobs, deadlines and blockers, then name the useful next action | Inventing a task list from a plausible story |
| "Kuch kaam karlo" | Select eligible work inside an approved standing goal; commit the job, then acknowledge | Random work, a vague promise, or an irreversible action without the required approval |
| "Progress dikhao" | Open current job, actual steps and latest artifact version | Showing only REASON/ACT labels or invented percentages |
| "Peechhe karo" | Close the work view; the job continues independently | Cancelling the job or suspending work with the tab |
| "Kya gadbad hai?" | Show recent measured health, affected work, attempted recovery and next step | Reading a seeded biography as current health |

Examples are behavior examples, not a regex script. Paraphrases and mixed Hindi/English must work. Exact "boss" is a stored preference, not a globally hardcoded name for every user. If the owner dislikes it, change it durably.

## ResponseFrame — before drafting a reply

Before the model drafts wording, the coordinator builds a **response frame** so the model writes from facts, not guesses.

| Field | Source | Purpose |
|---|---|---|
| `turnId` | coordinator | trace this reply |
| `facts` + `provenance` | memory / DB / health | what is confirmed vs observed/inferred |
| `acceptedJobIds` | work repository | what was actually accepted durably |
| `verifiedOutcomeIds` | verifier | what is proven done (only these may be called "completed") |
| `activeWork` | coordinator snapshot | what is currently running/blocked/paused |
| `uncertainties` | health / retrieval misses | what is unknown and how to say it |
| `stylePreferences` | preferences store | address word (boss/Ankit/…), language |
| `viewIntent` (optional) | router | show/hide work panel locally |

Rules: a completion sentence must cite a `verifiedOutcomeId`. "Accepted" means stored, not completed. Never upgrade "request sent" to "delivered" or "file created" to "user read it". Planned implementation: `server/conversation/coordinator.ts` in B06; grounded brevity enforced in B08.

Good: "Boss, brief bana rahi hoon. Teen sources mil gaye; ab unke claims compare kar rahi hoon." Only when the records say so.

Better when blocked: "Boss, source abhi unavailable hai. Do verified sources se draft bana diya; teesra pending hai." Only when that draft exists.

Bad: "I am constantly learning everything and completing all your tasks." This has no checkable boundary.

Precision does not mean maximal detail. Say one useful thing, make the rest inspectable. A short spoken reply and a detailed artifact can coexist.

## Initiative needs a standing agreement

Initially use an owner-approved goal such as "prepare a morning brief from these feeds at 08:00". Record sources, allowed operations, schedule/timezone, maximum runtime and daily model budget. Without an eligible goal, ask once for a useful one. Do not invent chores just to look alive.

Quiet hours control interruptions, not all background work. Permitted quiet local work may continue. Explicit due reminders have their own notification policy. Pause, cancel, approval-needed and provider-blocked are different states.

Eligibility vs notification are separate: useful work can proceed silently during quiet hours; blockers are told when action is needed. See [MEMORY & HEALTH](05-MEMORY-HEALTH.md) and B10.

## Awareness priorities

1. Owner goals and commitments.
2. Current tasks, outcomes and blockers.
3. Owner preferences and recent conversational references.
4. Actual capabilities and component health.
5. Environment only when relevant: timezone for reminders, weather for travel, not as the center of identity.

Unknown location is ordinary. Missing weather must not block greeting, work, memory, or make the interface repeatedly demand coordinates.

## What "AGI-like learning" means here

It is an aspiration for transfer: a lesson from one task helps a different task. This book implements testable episodic memory, corrections, retrieval and evaluated skill reuse. It does NOT claim to implement AGI, consciousness, or unlimited autonomous model training.

A skill is a versioned recipe (conditions, tool schema versions, steps, evidence requirements, failure cases). Lifecycle: propose from completed jobs → attach supporting/contradicting outcomes → evaluate on held-out cases in a sandbox → compare with baseline → promote only on gate → version on new jobs → rollback on regression. Never execute generated code merely because it was called a skill. See B09.

A small model can read retrieved notes and follow a narrow tested skill. Memory does not create reasoning ability it lacks. A larger or more capable model may still be necessary for ambiguous planning, difficult research and reliable language.

## Non-goals for this release

No arbitrary self-modifying production code, unrestricted computer control, automatic purchases, automatic weight training on every conversation, or indefinite unsupervised attempts. New capability classes are added one at a time with tools, evidence, budgets and tests. No silent paid fallback.

The first release should do a small number of valuable things extremely well. Broader autonomy is a measured expansion, not a label applied at boot.
