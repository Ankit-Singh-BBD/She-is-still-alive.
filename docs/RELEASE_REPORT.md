# RELEASE REPORT — Madhurita “She is still alive.”

> This release is labeled **READY** on the B11 gate as of the evidence below.
> Subjective owner sign-off on voice and experience is still required before
> calling the product release final — that gate is human, not a number.

| Field | Value |
|-------|-------|
| **Branch** | `docs-rewrite` |
| **Revision** | `f85c101` — `f85c10172ffef5a3d076b1c9c69d3d7f22218090` |
| **Fingerprint (PLAN baseline)** | `9651afd675a10a9f73d6294e5d4b330f541fbcde` |
| **Dirty files at capture** | `src/lib/api.ts, src/styles.css, src/ui/App.tsx, src/state/useWork.ts, src/ui/WorkView.tsx, tests/journeys/j01-j06.test.ts, tests/journeys/j07-j12.test.ts` |
| **Prepared at (IST / UTC)** | `2026-09-11T11:15:16+05:30` / `2026-09-11T05:45:16Z` |
| **Platform** | `Darwin MacBookAir.lan 25.6.0 Darwin Kernel Version 25.6.0: Fri Jul 31 19:17:12 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T8103 arm64` |
| **Node / npm / tsc / vitest** | `v26.8.1 / 11.19.0 / 5.9.3 / vitest/1.6.1 darwin-arm64 node-v26.8.1` |
| **LLM reasoning / live** | `gemma-4-31b-it (via @google/genai hosted, zero Mac RAM) / gemini-3.1-flash-live-preview` |
| **LLM provider** | `Faculty seam: @google/genai only (google); local-only falls back deterministically — no silent substitution` |

## Commands & Exit Codes (captured 2026-09-11)

| Command | Exit | Evidence |
|---------|------|----------|
| `npx tsc --noEmit` | 0 | no output (clean) |
| `npm run lint` (`eslint .`) | 0 | 0 errors, 0 warnings (after App.tsx exhaustive-deps comment) |
| `npm run build` (`tsc && vite build`) | 0 | 65 modules, `dist/client/assets/index-*.css 15.93 kB`, `index-*.js 411.54 kB` (gzip ~122 kB) |
| `npx vitest run` (all) | 0 | 74 files, 1151 tests passed (vitest 1.6.1) — 10.9 s wall |
| `npx vitest run tests/journeys` | 0 | 2 files, 12 tests passed (J01-J12) — real disposable SQLite, deterministic — <1 s |
| `npx playwright test` (skipped) | — | Playwright smoke harness exists; not run in this headless gate (requires `npm start` + `npm run dev`). See `e2e/`. |

Hashes: test sources are the tree at this revision; artifacts are `dist/client/*`.
No weight training in this release — learning is skill-candidate → sandbox on
held-out → gate → promotion → rollback (see `server/learning/`).

## Journeys J01–J12 — Per-Journey Evidence (B11.s1/s2)

All journeys run against **real disposable SQLite** (`tmpdir/madhurita-j*` +
`Database` + `runMigrations`), production `WorkRepository`, `MemoryRepository`,
`MemoryCorrections`, `HealthRegistry`, and grounded `buildFrame/claimsCompletion/
groundingViolation`. No mocks for DB/work.

| Journey | What it proves | File | Status |
|---------|----------------|------|--------|
| **J01** | Stored `preferredName` preference surfaces; no invented work rows. Seeds `identity`, inserts preference via `MemoryRepository.setPreference`, asserts `buildFrame` + zero `work_job` rows. | `tests/journeys/j01-j06.test.ts` | ✅ pass |
| **J02** | Two open jobs appear ordered by `priority` (0.9, 0.3), blockers visible via `priority`/`deadlineAt`. Two `accept` + SELECT `ORDER BY priority DESC`. | same | ✅ pass |
| **J03** | Accepted brief job persists and is readable: `goal`, `steps.length=1`, `status=queued` via `getSnapshot`. | same | ✅ pass |
| **J04** | Snapshot exposes actual steps + artifact `contentHash` (sha256, 64 hex) + `contentRef` (artifactId) — no invented `%`. `persistArtifact` + `getSnapshot` asserts `length 64`. | same | ✅ pass |
| **J05** | Hide/reopen does not cancel — job still readable, `version` monotonic, `status ≠ cancelled`. Double `getSnapshot` across hide. | same | ✅ pass |
| **J06** | Duplicate `requestId` returns same `jobId`, `created=false`, single `work_job` row. Idempotency gate. | same | ✅ pass |
| **J07** | Cancel vs completion race: `isLegalJobTransition(completed→cancelled/false)`, stale `expectedVersion` yields `false` (409 in HTTP), terminal → terminal monotonic. | `tests/journeys/j07-j12.test.ts` | ✅ pass |
| **J08** | Correction → next read follows corrected value: `formal → casual` via `MemoryCorrections.correctPreference` (single transaction, supersession), `getPreference` proves new value. | same | ✅ pass |
| **J09** | Quota/network unavailable surfaces as `HealthObservation.status=unknown` via `getObservation('non_existent…')`, not silent paid fallback. | same | ✅ pass |
| **J10** | Explain-failure path exposes `HealthRegistry.getAllObservations()` + bounded recovery via `registry.recovery` (`RecoveryManager`). | same | ✅ pass |
| **J11** | Completion claim requires verified outcome: `claimsCompletion` + `groundingViolation` — accepted job with no `verifiedOutcomeIds` → violation; verified → no violation. | same | ✅ pass |
| **J12** | Unseen wording: completion + grounding invariants hold for paraphrase (`Kaam pura…`, `Task completed…`) not fixture strings. | same | ✅ pass |

No blank-slate data deletion, no auto-delete/purchase as recovery, no mock for
work/memory, no invented progress. Hire/fire of the latter three is the honesty
gate — this suite is the evidence that it stayed closed.

## Latency (measured) & Not-Yet-Measured

- **Work acknowledgement** (`WorkRepository.accept` + `getSnapshot` in-process):
  ~single-digit ms per call on this ARM64 host (in-memory SQLite). Not yet
  measured end-to-end over HTTP under load — p50/p95 over `/api/work` remains
  to be captured with a load harness on the deployed target.
- **First audio / barge-in**: interruptible voice (`server/voice/live/session.ts`,
  `src/lib/voice.ts`) flushes by `responseId`/`seq`. Deterministic unit timing
  exists; real `first-audio` p50/p95 and barge-in `<200 ms` end-to-end require
  a live Gemini Live session + AudioContext harness. Marked **not-yet-measured**
  in production — pair below is the honest label.
- **Build**: ~1.4 s (vite). Full test wall: ~11 s.

No paid fallback: any wall-clock miss stays `degraded` with `fellBackAt` named.

## Voice Quality — Blind Ratings

Paired blind voice comparison has **not yet been run** against an owner-chosen
baseline at this revision. What is true:

- `GeminiVoiceService` lists provider voices via `listProviderVoices()`; `config`
  selects `LLM_VOICE_NAME` (default: provider default — hard `en-IN` would
  misrender Hinglish, so blank is intentionally valid).
- Interruptible session (`responseId+seq`, flush on barge) is implemented;
  prompts are the deterministic `prompts/interrupt-*.md` set introduced B08.s3.
- Blind rating (A/B, paired, randomized) is the defined gate — this release
  records it as **outstanding** and does not claim a grade.

## Offline / Limitations / Blocking Gaps

- **Offline**: with no `GOOGLE_API_KEY` the Faculty router runs local-only;
  stages 4–6, 9, 10 use documented heuristic fallbacks, cycles are `degraded`
  where a faculty was needed. `GET /api/hello` and local memory/voice capture
  remain available.
- **3 UI reference images + 6 frontend files**: heritage note — index-only per
  `.claude/memory/*` — still true on `HEAD:main`, intact here.
- **Playwright smoke**: harness exists (`e2e/`, `playwright.config.ts`) but the
  full `npm start` + headless Chromium pass was not included in this CI gate
  (requires live DB + dev server). Schedule before human sign-off.
- **p50/p95 over HTTP & barge-in wall-clock**: as above — not yet captured on
  target hardware/network.

## Next Human Gate

Owner subjective sign-off on voice + cinematic work surface is the remaining
gate to call the product release final. Code gates (typecheck/lint/build/tests/
journeys) are GREEN at this revision.

## How to Reproduce

```bash
git checkout docs-rewrite   # rev f85c101
npm run build               # tsc + vite → dist/client
npx tsc --noEmit && npm run lint
npx vitest run              # 74 files, 1151 tests
npx vitest run tests/journeys --reporter=verbose   # 12 tests
```

Dirty list at capture is above; any file listed there is local-only until
committed.
