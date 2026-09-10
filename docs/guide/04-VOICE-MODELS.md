# 04 — Precise words, natural voice, and honest model choices

[Book](../MADHURITA_BUILD_BOOK.md) · Implement in [B06](../build/tasks/B06.md) and [B08](../build/tasks/B08.md)

## Why a model is needed

Rules are good at checking a time, a schema or a task state. A language model helps understand "woh wala kaam", resolve references, weigh an unfamiliar plan and choose natural wording. Speech recognition turns sound into words; speech synthesis turns words into sound. Memory supplies facts from previous days. These are different jobs; one model need not do all of them.

A stronger model does not fix missing tools. A perfect tool does not fix misunderstanding. A familiar voice does not prove a correct result. Evaluate the complete route.

## The Faculty seam — how a model is replaced without rebuilding the app

All LLM access goes through `server/llm/provider.ts`:

```ts
interface Faculty { id: string; role: FacultyRole; complete(p: FacultyPrompt): Promise<FacultyResult>; }
interface FacultyProvider { createFaculty(role: FacultyRole): Faculty; }
type FacultyRole = 'reason' | 'decide' | 'respond' | 'learn' | 'live';
```

A provider (`server/llm/gemini.ts` today, a local stub like Ollama/Qwen tomorrow) implements `FacultyProvider`. The rest of the application consumes `Faculty`. `server/llm/router.ts` selects the faculty by role, budget and mode. Swapping the provider does not change `server/app.ts` call sites. See B08.

## What makes a voice conversation feel intelligent?

1. Understand the current sentence plus recent references, not the last sentence alone.
2. Use the owner's chosen address and language naturally; do not add a support-agent greeting to every turn.
3. Respond promptly, without waiting for long work to finish. Acknowledge only after accepting work durably.
4. Keep the actual result and uncertainty precise. "Saved locally" is different from "uploaded".
5. Stop output promptly when interrupted; accept a correction without restarting the conversation.
6. Remember corrections next session. Show work rather than narrating imaginary activity.

Voice quality also depends on microphone noise, VAD, endpoint detection, accent, prosody, audio buffering and network jitter. A better language model alone cannot solve all of these.

## The current selection: what we know

Strings like `gemini-3.5-flash-lite` or `gemini-3.1-flash-live-preview` found in config are **repository examples**. Their current account availability, free quotas, billing behavior and quality were NOT independently checked for this documentation rewrite. Comments claiming they answered in another session are not today's probe.

The architecture's use of separate reasoning and live voice roles is reasonable. Using five sequential reasoning calls before speech, and treating a generative live model as a strictly verbatim renderer, deserve latency and drift measurements. Do not replace working plumbing solely because a newer name sounds better.

## Candidate roles, not one universal winner

| Role | Minimum measured ability | First economical approach |
|---|---|---|
| Fixed commands | exact intent and slots | deterministic parser with explicit fallthrough |
| Simple language/slots | Hinglish references and valid schema | small local instruct model if it passes |
| Multi-step planning | dependencies, tool arguments, clarification | strongest permitted model that passes owner tasks |
| Response drafting | grounded, concise, natural Hinglish | measured local or hosted model |
| Retrieval | semantic relevance across spellings/languages | lexical baseline plus evaluated embedding model |
| Speech recognition | owner accent/noisy-room accuracy | local Whisper-family candidate or measured hosted service |
| Speech synthesis | Hindi/English names, prosody, first audio latency | tested local TTS or permitted hosted voice |
| Build worker | small code edits and test repair | small coding/instruct candidate under B01 supervisor |

Qwen2.5-3B-Instruct is an identifiable example to benchmark, NOT a guaranteed best/current recommendation. Verify its model card, license and local runtime compatibility at https://huggingface.co/Qwen/Qwen2.5-3B-Instruct . OpenAI Whisper's code/model information is at https://github.com/openai/whisper . Neither reference establishes suitability for this owner. Do not invent package names or install random similarly named packages.

## Three modes — choose one, honestly

Unlimited frontier-quality voice, unrestricted autonomy, zero cost, no hardware constraints and no quality loss cannot all be guaranteed. Free tiers have quotas and may change; local inference consumes RAM/VRAM, electricity and hardware. A 3B model at 4-bit has roughly 1.5 GB of raw weight bits, but runtime, quantization metadata, KV cache, context and concurrent ASR/TTS need additional memory. This is not a hardware fit promise.

| Mode | Value | Behavior on quota/budget exhaustion |
|---|---|---|
| `local-only` | No paid/hosted calls at all | Work that needs the network is blocked with a useful limited state |
| `hybrid` (default zero-paid) | Local plus explicitly allowed hosted quotas | Queue / block / use an already-qualified local route, labeled as limited |
| `quality` | Stronger options permitted | Enable paid usage only after an explicit owner budget decision |

Mode is configured at deployment (e.g. `FACULTY_MODE` in env, see B08). Changing mode is a recorded owner decision, not an automatic switch. Do not rotate accounts to evade quotas.

For this owner the default is zero-paid (`local-only` or `hybrid` with zero paid spend). If no zero-paid candidate passes a required quality gate, that capability is `BLOCKED`, not silently accepted with lower quality.

## Verify availability before selection

Use the provider's current model listing AND a real minimal request on the owner's authorized account. Check structured output, streaming, tool/schema support, voice language, context/output limits, quotas, data terms and billing project. Listing alone does not prove access.

Provider reference pages to consult at selection time: https://ai.google.dev/gemini-api/docs/models , https://ai.google.dev/gemini-api/docs/pricing , https://ai.google.dev/gemini-api/docs/rate-limits . These links were not live-verified during this update; record `checkedAt`, exact model/version, region, account tier, quota and observed response. Do not copy remembered prices into config.

Pin the deployed model version where possible. A moving alias requires requalification when its resolved version changes. Store deployment truth in a capability registry, not an origin-story memory.

## Evaluation before routing

Build a representative owner-approved set: greetings, pronouns, corrections, Hindi/Roman/English variants, interruptions, ambiguous dates, actual tools, missing tools, long turns, outage and wrong-premise questions. Keep held-out cases away from implementation prompts. Run the same inputs through candidate routes on the same hardware and compare correctness, task completion, unsupported claims, latency, audio intelligibility and actual cost.

Use a paired blind listening comparison against an owner-selected reference recording or accessible baseline. "Like GPT voice" is a preference target until a reference and rubric exist. Human feedback is required for warmth/prosody; an LLM judging its own answer is insufficient. No finite benchmark can prove "0.1% loss never occurs". Record distributions and sample sizes, not just averages.

## Response pipeline

B06 builds `ResponseFrame`: `turnId`, facts with provenance, `acceptedJobIds`, `verifiedOutcomeIds`, `activeWork`, uncertainties, style preferences and optional `viewIntent`. Business completion statements come from verified outcomes; free-form conversation uses scoped evidence. A generic output regex is supplementary, not the source of truth.

Separate brief spoken text from detailed visual artifacts. Draft short, independently grounded utterance segments (B08). Validate each segment before sending it to TTS; do not speak raw planner output or private reasoning. Bind audio chunks to `{responseId, seq}`. Barge-in invalidates the `responseId` and flushes the playback queue so late packets cannot resume obsolete speech.

Local ASR → coordinator → grounded response → local TTS is the economical baseline to test. A live speech-to-speech route is acceptable only if actions still go through application authority and its outcomes remain grounded. Keep actual audio sample rates explicit. Do not add fake filler to hide latency.

## Starting latency objectives, not promises

Measure speech-end to accepted acknowledgement, first useful audio, final answer, work acceptance and barge-in stop separately. Initial engineering targets: p95 durable work acknowledgement under 500 ms for local acceptance; p95 first useful audio under 1.5 s on a declared deployment; p95 barge-in silence under 200 ms. Provider/network time counts in perceived latency. B00 establishes feasibility; B08 reports misses rather than changing thresholds silently. Complex work may take minutes; acknowledgement is not its completion.
