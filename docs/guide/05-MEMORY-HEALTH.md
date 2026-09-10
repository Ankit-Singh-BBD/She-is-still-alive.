# 05 — Learn from evidence, know what is broken

[Book](../MADHURITA_BUILD_BOOK.md) · [B09](../build/tasks/B09.md) · [B10](../build/tasks/B10.md)

## Memory is a notebook, not magic intelligence

A useful notebook records what happened, who said it, when it was true, and what later corrected it. It does not turn every sentence into a permanent fact.

Keep existing episodic, semantic, preference, habit, relationship and learned-pattern domains. Add typed correction and skill records rather than replacing the database. The model proposes candidates; application code validates and stores them.

Every candidate needs source IDs, subject, observation time, confidence, sensitivity, domain, expiry if applicable, and claim status: observed, inferred or confirmed. Model confidence is a proposal, not a measured probability. A user's correction outranks an earlier inference. Never promote an assistant's own invented statement to evidence by reading it back from the transcript.

## Correction algorithm

1. Resolve the specific fact/preference being corrected. If ambiguous, ask which one.
2. In one transaction create a correction record linking old and new assertions, mark the old assertion superseded, store provenance and append an event.
3. Invalidate affected retrieval caches and derived skills. Retain history for inspection; do not erase the reason for the change.
4. On the next turn, retrieve the new assertion and exclude the superseded one from active facts.
5. Test again after closing and reopening the database. In-memory success is insufficient.

Example: "Mujhe boss mat bolo, Ankit bolo." Update this owner's address preference, not every identity and not the global prompt. This is a general preference mechanism, not a hardcoded example branch.

## People Graph — she knows who matters, with consent

The **People Graph** is the `people` field of `WorldModel` (`server/world/people.ts`, planned). It extends the existing `relationship` domain into a live, consent-scoped graph — not a scraped address book.

- **Source:** only explicit owner-told relationships ("Pepper meri colleague hai") and permitted history where the owner allowed remembering a person. No contact scraping, no inference of a new person from a single mention without confirmation.
- **Record:** `personId`, `displayName`, `relation` (family/colleague/friend/other), `allowedFields` (what may be remembered about this person), `provenance` (ownerTold | observedWithConsent + source turn/job id), `lastSeenAt`, `sensitivity`. Each field needs its own consent; a missing consent means `unknown`, never guessed.
- **Behavior:** unknown people are not invented. Corrections revoke or narrow consent ("Pepper ke baare me ab kuch mat yaad rakhna" → supersede + invalidate). Deletion is durable and auditable.
- **Use:** the coordinator injects a bounded `peopleContext` (salient top-N people + relation + last permitted context) into `ResponseFrame` alongside `world`. The model sees only that, never the full graph. Every stance line about a person ("Aapne Pepper se kal mana kiya tha") must cite a verified world/person fact.
- **Privacy:** per-person consent, per-field policy, no cross-owner sharing. See 01-VISION and 02-CONNECTIONS.

## Retrieval algorithm

Filter identity, lifecycle and permitted sensitivity in the database first. Retrieve bounded lexical candidates; optionally add embedding candidates from a qualified model. Rank by relevance, recency and importance. Preserve source IDs and correction links. Build a token-budgeted context with mandatory current instruction and relevant preferences first; do not silently slice off the user request.

Use conversation summaries plus precise source references for long history. A summary is lossy; fetch the original turn when a decision depends on exact wording. Compare retrieval against held-out Hinglish paraphrases. More rows in memory is not a success metric.

## Learning a skill — precise lifecycle

A skill is a versioned recipe: applicable conditions, tool schema versions, steps, evidence requirements and known failure cases. Store candidate skills separately from active skills.

```
completed jobs → propose one candidate lesson
  → attach supporting and contradicting outcomes
  → evaluate on HELD-OUT cases in a sandbox
  → compare with baseline
  → gate: promote only if the gate passes
  → record skill version on every new job
  → rollback promotion on regression
  → never execute generated code merely because it was called a skill
```

Track task success, correction recurrence, unsupported-claim rate and transfer to unseen cases. **Weight updates/fine-tuning are NOT part of this release.** They require a separate curated dataset, evaluation, compute budget and approval. Retrieval and tested skills do not establish AGI. See B09 for the acceptance test.

## Health is another evidence notebook

Planned `HealthObservation`: `componentId`, `checkedAt`, `status` (`healthy`/`degraded`/`unavailable`/`unknown`), `evidenceRef`, `affectedCapabilities`, `nextCheckAt`. A missing probe is `unknown`, not healthy. Keep boot configuration separate from latest operational health.

Initial probes: DB read/write on a disposable probe record, worker heartbeat/expired leases, model timeout/quota, source connector reachability, voice session state, event delivery lag, artifact hash validation. Cap probe frequency and cost. Aggregate repeated errors without hiding first/last occurrence.

Recovery rules are bounded recipes: retry a transient read, reconnect transport, reconcile a stale lease, or switch to a previously qualified permitted route. Each rule defines maximum attempts, cooldown, preconditions, rollback and postcheck. Never auto-delete data, rewrite production code or purchase more quota as recovery. See B10.

Application-hosted diagnosis cannot report while its entire process is dead. A separate process supervisor/monitor is required for that failure class; B10 must document its deployment and test restart. A PWA alone is not that supervisor.

## Safe initiative

An approved standing goal supplies scope and budget. Candidate selection uses urgency, owner priority, expected benefit and dependencies. Work eligibility and notification timing are separate: useful permitted work can proceed silently during quiet hours. Tell the owner about a blocker when action is needed, not every heartbeat. No eligible task means honestly idle, not imaginary busyness. Cap `proactive_decision` rows; a blocked queue must not mask newer work.
