# Madhurita — implementation inventory, not a completion certificate

## Review boundary

Static repository review dated 2026-09-10. Branch: `docs-rewrite` from `9651afd675a10a9f73d6294e5d4b330f541fbcde` (main). This v3 documentation rewrite modifies Markdown and JSON only — no application source, tests, migrations or config were changed. No build, test run, browser session, real-provider call or hardware benchmark was executed as part of this change. Historical test counts and claims in old prose are not fresh evidence.

B07 truncation (97 bytes) has been fixed; B08–B11 task cards have been created; the Build Book now defines the three-layer house, the Faculty seam (LLM-agnostic, swappable without architecture change), UI projection-only principles, the Mac roadmap, and the precise skill lifecycle. PLAN has been bumped to `specVersion: "3"` and CHECKPOINT's `nextAction` points to B00/s1 baseline checks. The instructions below start that measurement.

The substantive code paths surveyed remain those listed below. This is not a claim that every source or test file received a line-by-line audit. Start [B00](build/tasks/B00.md) to measure the checked-out tree.

## Existing structure

| Existing location | What static reading shows |
|---|---|
| `server/main.ts` | Loads environment, starts composition root and HTTP/voice server, handles shutdown |
| `server/app.ts` | Constructs DB, identity, tools, tasks, loops, faculties, learning, personality, realtime and autonomic services |
| `server/cognition/runtime.ts` | Serial stage orchestration with traces and per-identity cycle gate |
| `server/tools/index.ts` | Seven core tools: four memory/preference tools and three reminder tools |
| `server/actions/pipeline.ts` | Single-tool validation, authorization, execution, verification and result persistence |
| `server/tasks/executor.ts` | Task polling, claiming, retry and reminder dispatch |
| `server/loops/manager.ts` | Event/schedule/condition loops with partly in-memory trigger state |
| `server/memory/retrieval.ts` | In-memory ranking of retrieved rows using token overlap, recency and importance |
| `server/advanced/reflection.ts` | Recurring-term extraction from episodes |
| `server/advanced/dream.ts` | Exact duplicate folding; currently publishes `memory.consolidated` |
| `server/autonomic/noticing.ts` | Exhausted-task and stalled-loop notices |
| `server/voice/live/` | Live provider transport, turn handling and rendering of authorized responses |
| `src/ui/App.tsx` | Session, dialogue, presence, voice and WebGL canvas composition |
| `src/ui/Presence.tsx`, `Ledger.tsx` | Conversation surface and on-demand internal counts/status |
| `public/sw.js` | Shell caching; not an autonomous background worker or offline assistant |

Planned additions (not yet code): `server/llm/provider.ts` + `router.ts` (Faculty seam, B08), `server/work/` (B03–B04), `server/health/` (B10), `server/conversation/coordinator.ts` + `ResponseFrame` (B06), `server/http/routes/work.ts` + `src/ui/WorkView.tsx` + `src/state/useWork.ts` + per-job SSE (B07).

Fourteen numbered SQL migration files exist at this revision. New migration numbers must be allocated from the actual tree at implementation time, not from this sentence.

## Important gaps to reproduce, not just repeat

- Task execution checks pipeline `success` without requiring `verified` before marking completion.
- Recurring payloads are executed once by the current executor; no next occurrence is created there.
- A crashed process can leave tasks `running` while polling only claims `pending` rows.
- Loop trigger state is not rebuilt for existing loops at startup; JS callback conditions cannot survive JSON serialization.
- Cancellation of an in-flight task can be overwritten by later unconditional completion.
- Reminder delivery accepts a non-null cycle rather than separately proving persistence, dispatch and user receipt.
- Task writes and corresponding event publication are not consistently a single atomic transaction.
- The tool roster does not contain general research, document production, browser operation or a durable multi-step planner.
- Stage/status visualizations do not constitute a live artifact workspace.

[B02](build/tasks/B02.md) owns reproductions for the existing reliability findings. B03–B11 own proposed capabilities. Do not mark a finding fixed from a comment alone.

## Current models: names found, suitability not established

`server/config/env.ts` declares reasoning default `gemini-3.5-flash-lite` and live default `gemini-3.1-flash-live-preview`. These strings are repository facts, NOT independently verified availability, pricing or quality recommendations. The actual deployment may override them. v3 adds the Faculty interface so any provider can be swapped without architecture changes — see [model selection](guide/04-VOICE-MODELS.md) and B08. Read model selection before choosing replacements.

## Run the existing application

Use Node compatible with `.nvmrc` and `package.json`. On a trusted checkout:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

Inspect `.env.example`; copy it only if no local `.env` already exists. Never overwrite someone's settings. Without a configured model the existing deterministic path is limited, not equivalent to a fluent general assistant. The actual listen address comes from the running server. These are existing commands, not commands verified by this documentation update.

Mac integration (planned, stages 1–4) lives in `scripts/launchd/` and a future Tauri wrapper — not in this release. See the Build Book's Mac roadmap.

## What remains pending

The entire v3 acceptance process. [PLAN](build/PLAN.json) intentionally starts all tasks at `pending`. [CHECKPOINT](build/CHECKPOINT.json) starts uninitialized at B00/s1 with `nextAction` updated for v3. Do not turn these into a second unverified status story: B01 adds evidence validation; until then follow START manually.

Old contradictions are retired: a current renderer and Ledger exist even though v1 prose said otherwise. Origin-story statements, comments and inventory prose must never substitute for live capability health. Keep an evidence-backed inventory update at each milestone; retain the review date and tested tree fingerprint.

**Safety:** Never run `git reset --hard` / `git clean -fd` / `git checkout -- .` in this repository — six frontend files and three images once existed only in the git index.
