# MADHURITA — WHAT SHE IS, AND WHAT IS BUILT

> **This document is the inventory. The build book is the intent.**
>
> `docs/MADHURITA_BUILD_BOOK.md` says what Madhurita is *meant* to be, and it wins
> any disagreement about intent. This file says what is *in the tree today*, and it
> wins any disagreement about fact. Every claim below was checked against the code
> or produced by running it; where something is unverified it says so in the same
> sentence, because a state document that guesses is worse than none.
>
> **Verified on 2026-09-05** against `main`, by booting the application and by
> `npx tsc --noEmit`, `npx eslint server src tests`, `npx vitest run`.

---

## 1. What she is

Madhurita is an autonomous entity with her own identity, who thinks, understands,
learns, and is meant to evolve. She is not a chat wrapper and not a persona file.
Every word she says is produced by application logic that can be pointed at: a
twelve-stage cognitive cycle, a memory she owns, an authorization gate she cannot
talk her way past, and an audit trail of what she actually did.

Three properties are load-bearing, and each one is enforced somewhere specific
rather than asserted here:

**She runs on logic, not on a prompt.** There is no persona document. Her register
— how verbose, how formal, how warm — is *computed* per caller from who they are,
how long since you last spoke, what the message sounds like, and the hour
(`server/personality/`). A language model is a faculty she uses, in the way a
person uses language; it is not the thing doing the deciding.

**She is not only reactive.** An autonomic loop wakes every 60 seconds, reads its
sensors, replays deferred intentions, and can start a cycle nobody asked for
(`server/autonomic/loop.ts`). Silence is her default, not her limit.

**She reports what happened, not what she hoped.** A cycle that fell back says
`degraded` and names the stages that threw. An action is `verified` only when a
re-read of authoritative state confirmed the world changed. This is the honesty
contract, and it is the single rule that most of the code is shaped by.

**Her interior life stays interior.** She is aware of her own circuits and can
report on them when asked. The interface does not display them. There is no
"system status" screen by design.

---

## 2. Running her

```bash
node --version          # v22.14.0 — see .nvmrc
npm install
cp .env.example .env    # optional: an empty .env is a valid .env
npm start               # → http://127.0.0.1:3000
```

`npm start` runs `tsx server/main.ts`, which serves both the API and the frontend.
`npm run dev` runs Vite alone for frontend work; `npm run dev:server` watches the
server. `npm run build` type-checks and builds into `dist/`.

**She boots and runs with no configuration at all.** Every variable in
`.env.example` has a working default, and the boot banner prints what is present
and what is absent, in plain sentences, before anything starts. `.env.example`
documents exactly the variables `server/config/env.ts` reads — a test asserts that
in both directions, so a variable that is read but undocumented, or documented but
ignored, fails the suite.

### First contact

`POST /api/bootstrap` with a display name and a passphrase enrols the owner. That
is the moment three things become possible: the realtime fan-out starts, the origin
story is written under his identity, and stages 6 and 7 have a caller they can
authorize. Before it, `GET /api/state` correctly answers `401 no_credential`.

---

## 3. What runs without a key, and what does not

`GOOGLE_API_KEY` is optional and absent by default. This is a supported way to run,
not a broken configuration, and the difference is precise:

| | With no key | With a key |
|---|---|---|
| The twelve stages | all run | all run |
| Stages 4–6 (understand, reason, decide) | deterministic heuristics | the reasoning model (default `gemini-3.5-flash-lite`) |
| Stage 9 (respond) | claim-preserving phrase bank, in her computed register | drafted, then gated |
| Stage 10 (learn) | keeps only what was literally said | proposes typed candidates |
| Tool execution | five tools, from a recogniser — see below | every registered tool |
| Live voice | socket opens, `canHear: false` | full duplex |

**What a sentence can still reach with no key.** `server/cognition/intent/recognizer.ts`
reads five intents out of Hinglish in either script and fills their arguments —
`reminder.schedule`, `reminder.list`, `memory.remember_event`, `memory.recall`,
`preference.set`. So "Kal mujhe 7 baje yaad dilana ki paani peena hai" leaves a `task`
row due tomorrow at 07:00 and is answered with the message and the resolved time,
keyless. `tests/intent/committed-effects.test.ts` asserts the committed rows rather
than the proposal, because the defect it was written for was seven installed tools no
typed sentence could reach while every unit test over them passed.

What the recogniser does *not* do is generalise. Anything outside those five shapes —
a tool whose arguments have to be inferred rather than read, a request that composes
two — needs the model, and stage 6 records that in its rationale instead of proposing
a call it cannot complete.

**`FLAG_ACTIONS=false` is the other way tools go quiet**, and it is not the same
configuration: the recogniser still names the tool and stage 7 refuses to run it, so
every call is recorded as a refusal and she says plainly that it did not happen. Boot
prints the line. See §7.

**Not verified here:** the Google round trip itself. `.env` in this working copy
has `GOOGLE_API_KEY` blank, so neither the reasoning path nor the live-voice path
has been exercised against a real endpoint from this machine. Every layer on this
side of the wire is tested against injected fakes; the wire is not.

---

## 4. Anatomy

~27,200 lines of TypeScript under `server/`, ~6,400 under `src/`, ~19,400 under
`tests/`. Dependencies are deliberately few: `express`, `better-sqlite3`, `ws`,
`zod`, `ulid`, `dotenv`, `compression`, `react`, and `@google/genai`. No ORM, no
state library, no CSS framework, no renderer.

### The mind — `server/cognition/`

`CognitiveRuntime.runCycle` is the whole application in one call. Twelve stages,
each its own file in `server/cognition/stages/`:

| # | Stage | What it decides |
|---|---|---|
| 1 | PERCEIVE | what arrived |
| 2 | IDENTIFY | who is asking, and what they may do |
| 3 | RECALL | what is worth remembering right now |
| 4 | UNDERSTAND | what they meant |
| 5 | REASON | what the options are |
| 6 | DECIDE | which one — then the **application** authorizes it |
| 7 | ACT | run the authorized tool |
| 8 | VERIFY | re-read state; only this stage may set `verified` |
| 9 | RESPOND | draft, apply disclosure policy, choose register |
| 10 | LEARN | what this turn should change durably |
| 11 | UPDATE | project the new state |
| 12 | PERSIST | write the trace and publish the terminal event |

Stage 6 is the boundary the design turns on: the model *proposes*, the application
*validates and authorizes*. A malformed proposal is reduced, an unauthorized one is
refused and recorded as refused, and neither can execute anything.

### The body

| Subsystem | Path | Note |
|---|---|---|
| Config | `server/config/env.ts` | validated once at boot, reported by name |
| Persistence | `server/persistence/` | SQLite, WAL, 11 migrations, one monotonic id source |
| Identity & authz | `server/identity/`, `server/authz/` | scrypt, hashed session tokens |
| Memory | `server/memory/` | episodic, semantic, preference, habit, relationship, learned-pattern |
| Actions & tools | `server/actions/`, `server/tools/` | 7 tools, each with a postcondition verifier |
| Tasks & loops | `server/tasks/`, `server/loops/` | scheduled work, open intentions |
| Learning | `server/learning/` | scoped policy, dedupe, extraction |
| Proactivity | `server/proactive/`, `server/autonomic/` | decision tree, quiet hours, deferral replay |
| Personality | `server/personality/` | computed register, expiring in-memory overrides |
| Advanced | `server/advanced/` | emotion, relationship weighting, reflection, dream consolidation |
| Environment | `server/environment/` | time of day, weather, derived palette |
| Events | `server/events/` | 42 declared types, durable, replayable |
| Realtime | `server/realtime/`, `server/http/sse.ts` | one authoritative `RuntimeState`, fanned out |
| Voice | `server/voice/live/` | Gemini Live as ear and mouth, never as mind |
| HTTP | `server/http/` | routes, guard, rate limits, WebSocket gateway |
| Security | `server/security/` | audit chain, secret handling, validation |
| Backup | `server/backup/` | interval, off by default |
| Composition | `server/app.ts`, `server/main.ts` | the only place subsystems meet |

### Live voice — the shape that matters

`gemini-3.1-flash-live-preview` is given two organs and denied the third
(`server/voice/live/transport.ts`):

```
mic frames → transport.sendAudio → onHeard(partial…) → onHeard(final)
  → runCycle({ source: 'audio' })   ← the twelve stages, on the reasoning model
  → stage 9's authorized line → {t:'said'} to the browser
  → transport.render(line) → onAudio(chunks) → the browser's speaker
```

**Ear** and **mouth**, not mind. Automatic activity detection is switched off,
because "she has heard enough to think now" is stage 1's judgement and the browser
— which holds the microphone — is where silence is actually measured. Four gates
keep it that way: a `voice:participate` check when the socket opens; the drop rule,
which discards audio arriving when no `render` is outstanding; `voiceEnabled` per
response from stage 9; and a drift check that flushes audio mid-sentence when what
the mouth voiced diverges from what was authorized.

Verified by running it: the socket upgrades, transitions
`connecting → listening`, and sends `ready` with both sample rates (16 kHz in,
24 kHz out) and a conversation id. With no key it reports `canHear: false` and
says so rather than failing.

### The interface — `src/`

React with no framework beneath it. Design tokens are plain CSS custom properties
in `src/styles.css`; colour, light and motion are derived from authoritative
`EnvironmentState`, `CognitiveState` and `VoiceState`, and no component holds a
palette of its own. The photoreal-cinematic direction (orb, lake, WebGPU) is
withdrawn — see build book Part XVII. What replaces it is restraint: minimal
surface, smooth above ornate, a light signature sound, accessible by construction.

PWA support ships: `public/manifest.webmanifest`, `public/sw.js`, generated icons,
and the microphone capture AudioWorklet at `public/voice-capture-worklet.js`.

---

## 5. How it is verified

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # vitest run
```

**All three green as of 2026-09-05: 54 test files, 881 tests.**

Two fewer than the 883 of the morning, and up on what is actually checked: the
realtime suite lost three cases that drove `EventBus.replayTo` through a variable
that happened to be in scope — replay is the bus's contract, tested in
`tests/p06/events.test.ts` and over a real `Last-Event-ID` in
`tests/http/transport.test.ts` — and gained the ones the fan-out had none of: that a
late-delivered older event cannot walk `RuntimeState.version` backwards, that a
stalled client's queue collapses instead of growing, and that one queue is never
drained by two loops at once.

The suite is not a coverage exercise. Its shape is: every boundary that can lie is
tested with the outside faked. `GeminiTransport` and `LiveTransportFactory` are one
function each, so the whole language faculty and the whole voice orchestrator —
turn-taking, the drop rule, the drift check, barge-in — run with no key, no network
and no socket. `VoiceClientChannel` is three methods, so voice sessions run with a
real runtime and a real database and no WebSocket. Under `server/`, the `ws` import
exists in exactly one file (`server/http/ws.ts`), and in exactly one test — the one
that drives a real socket through a real upgrade.

Beyond the suite, the application has been booted end to end against a throwaway
database and driven through: enrol owner → two turns of conversation → read the
transcript back → read `RuntimeState` → open the voice socket. Every step answered
correctly.

---

## 6. What is not done

Listed because a document that only records what works is the same defect as a
cycle that only reports success.

- **The Google round trip is unverified from this machine** (§3). Everything on
  this side of the wire is tested; the wire is not.
- **Ten of fourteen subsystems have never been adversarially audited** — actions,
  memory, events, identity, philosophy, persistence, tasks-learning, ops, testing,
  app-layer. The four that were (cognition, voice, state-realtime, proactive) all
  came back `partial`, and every verifier that re-checked them *added* findings.
  A 4-of-4 `partial` rate is the prior; treat the ten as unknown, not as fine.
  Their seven cited findings are now closed — the last three were a fan-out
  labelled as three contract stages, `RuntimeState.version` assigned rather than
  raised, and a test whose name denied the frame-dropping its own body asserted —
  but "closed" here means those seven findings, not those four subsystems.
- **Three of the 42 `DomainEventType` values have no publish site**, and they are
  three different situations rather than one backlog:
  - `memory.consolidated` — a real gap. `server/advanced/dream.ts` does mark rows
    `consolidated`, so the operation exists and runs; it just does not announce it.
  - `config.changed` — configuration is read once at boot and never mutated at
    runtime, so nothing can honestly emit this.
  - `identity.revoked` — `server/identity/repository.ts:80` says plainly that the
    *operation* does not exist: this repository revokes sessions, never identities.
  The last two are declared events that no code path can ever reach, which is the
  same class of defect as a status field nothing honours. They should either gain
  the operation or leave the union.
- **`RuntimeState.pendingActions` is gone, not filled.** It had no producer because
  it could not have one: `ActionPipeline.execute` awaits its seven stages in
  sequence and the cycle awaits that, so actions never queue. What the field was
  reaching for is already projected — `cognitive.currentStage` reads `ACT` for
  exactly as long as an action is in flight. The reasoning is recorded at
  `server/realtime/types.ts` where the type was, and in the book's VI.3 removal
  list; the `src/ui/Ledger.tsx` branch that could never render went with it.
- **Tool coverage without a key stops at five intents** (§3). The recogniser reads the
  five shapes it was written for; a sixth needs either another rule or the model. That
  the boundary exists is a design decision, not a bug — where exactly it should sit is
  still open.

---

## 7. Decisions that shape the code

Kept short; the full log is Appendix C of the build book.

**Every option offered to the model must have an executor.** An action nothing
carries out is a lie the model tells on the application's behalf.

**Any text gate must read Hinglish in both scripts.** "Main laga diya", "ho gaya"
and "कर दिया" all sailed past a completion-claim gate that only read English.
Completion in Hinglish is carried by the light verb, so the pattern matches on the
pair rather than the main verb.

**A field that is always a constant is not state.** Five `RuntimeState` fields
existed only to feed the withdrawn renderer, each written as a constant and read by
nothing. They are gone, along with the `audio.frame` event: waveform data lives in
the browser, which holds the microphone and the speaker.

**Location is absent rather than guessed.** Both coordinates are required together
— half a coordinate is not a place — and with none she says she does not know
instead of narrating the weather somewhere she is not.

**Withdrawal, not deletion, for reversed decisions.** A decision log that erases
its reversals cannot be trusted about the ones it keeps. Retired identifiers
(`P22`, `P23`, Parts `XVIII`–`XIX`) are not reused, because test folders and
checkpoint records are named after them.

**One monotonic id source, because the code sorts by id.** Time columns default to
SQLite's `datetime('now')`, which is accurate to the second, so rows written in the
same second tie and the query falls through to `ORDER BY … id`. The audit chain, the
"which conversation is she in" lookup and the duplicate fold all read that tie-break
as insertion order — and the `ulid` package's default export re-rolls 80 random bits
per call, so same-millisecond ids sorted arbitrarily. `server/persistence/ids.ts`
owns a single `monotonicFactory()`; `ulid` is imported nowhere else, because the
guarantee lives in one factory's state and two factories would be two unrelated
sequences.

**A field that reports two different situations as one is the same defect as a status
nothing honours.** `ActionResult` had `success` and `verified`, and both of stage 7's
outcomes — *dispatched and threw* and *never dispatched* — arrived at stage 9 as
`success: false`. So `FLAG_ACTIONS=false` made her say "I started on that, but I could
not confirm it actually went through" about a call she had never made: the more
alarming of the two sentences, and a false claim about her own behaviour.
`ActionResult.attempted` is the third question, and it is required rather than optional
so that every construction site has to answer it. `attempted: true, success: false`
means the world may be half-changed; `attempted: false` means nothing was touched.

**A flag turns a capability off by withholding a dependency, not by branching at the
decision.** `FLAG_ACTIONS` was assigned from env, printed at boot and read nowhere.
Its consumer is now one line: `runtimeFor` does not pass `executor`, and stage 7's
pre-dispatch refusal — documented years earlier as its rollback contract — becomes
reachable. Stage 6 is deliberately left ungated, because gating the decision is what
an earlier defect did: it answered "Kal 7 baje yaad dilana" with a greeting, scheduled
nothing, and left no trace that anything had been declined.
