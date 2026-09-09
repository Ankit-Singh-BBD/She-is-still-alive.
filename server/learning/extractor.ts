/**
 * The two ways she learns out of band, and the reason there are two.
 *
 * `LearningPipeline` declared a `LearningExtractor` and every caller in the
 * repository — including two "production readiness" tests — satisfied it with
 * `{ extract: async () => [] } as never`. A pipeline whose only extractor
 * returns nothing is a pipeline that reports `learned: false` forever while
 * looking wired, so this file supplies the real ones:
 *
 *  - `LlmLearningExtractor` asks the language faculty what is worth keeping.
 *  - `RuleBasedLearningExtractor` reads only what was literally stated, and is
 *    what runs when no model is configured.
 *
 * Neither of them decides anything. An extractor's whole output is a list of
 * *candidates*; `LearningPipeline` then applies the confidence and importance
 * thresholds, the Scoped Learning Policy, the dedupe engine and the per-cycle
 * cap, and only then writes a row. So the worst either can do is propose
 * something the application throws away — which is the same boundary the
 * cognitive stages hold the model to.
 *
 * ## Scope is not the extractor's to choose
 *
 * `ExtractionProposal` carries `sensitivity` and `subjectKind`; `LearningCandidate`
 * has no such fields and this file drops them on the floor. That is deliberate.
 * Who a memory is about and who may hear it is decided by
 * `DefaultGuestLearningPolicy` from the *caller's* kind — a guest's claim about
 * the owner is quarantined no matter how the model labelled it. Passing the
 * model's own labelling through would let it grant itself owner scope.
 *
 * ## Failure is loud here too
 *
 * A faculty that throws is not caught. `LearningPipeline.processCycle` does not
 * catch it either, so it reaches the caller, who can record that this cycle was
 * not learned from. Returning `[]` on a transport failure would be
 * indistinguishable from "there was nothing to learn", and the difference
 * between those two is the whole point of keeping a record.
 */

import type { IdentityKind } from '@server/identity/types.js';
import type { MemoryDomain } from '@server/memory/types.js';

import type { CycleRecord, LearningCandidate, LearningExtractor, Message } from './types.js';

/**
 * The narrow slice of the language faculty an extractor uses.
 *
 * Declared here rather than imported from `@server/llm` so that `server/learning`
 * does not depend on the whole faculty class — and so a test can drive this file
 * with a three-line object. `LanguageFaculties` satisfies it structurally.
 */
export interface TranscriptLearningFaculty {
  readonly modelId: string;
  proposeExtractionsFromTranscript(input: {
    cycle: { status: string; decision?: string | undefined; answered?: string | undefined };
    messages: readonly { role: string; text: string }[];
    speakerKind: string;
    alreadyKnown?: readonly string[] | undefined;
  }): Promise<
    Array<{
      domain: MemoryDomain;
      data: Record<string, unknown>;
      confidence: number;
      importance: number;
    }>
  >;
}

/**
 * Resolves an identity id to its kind, or `undefined` when it cannot.
 *
 * A function rather than an `IdentityRepository` because that is all either
 * extractor needs, and because the pipeline resolves the kind again from
 * authoritative state before the policy runs — this value is for the prompt and
 * for the candidate record, not for an authorization decision.
 */
export type CallerKindLookup = (identityId: string) => IdentityKind | undefined;

/**
 * Lines describing what she already holds about a speaker.
 *
 * Injected rather than read here so an extractor keeps no repository dependency
 * of its own, and awaitable because the one real implementation
 * (`knownMemoryLookupFrom`) goes to the database. When absent the prompt says so
 * plainly instead of implying she remembers nothing.
 */
export type KnownMemoryLookup = (
  identityId: string,
) => readonly string[] | Promise<readonly string[]>;

/**
 * Least privilege when the lookup cannot answer.
 *
 * `guest` is the strictest kind in `DefaultGuestLearningPolicy`, so a failed
 * lookup narrows what may be learned rather than widening it. The pipeline's own
 * `resolveCallerKind` defaults the same way for the same reason.
 */
const UNKNOWN_CALLER_KIND: IdentityKind = 'guest';

// ── The rule-based extractor ───────────────────────────────────────────────

/**
 * Never learned, whatever the sentence looks like.
 *
 * The LEARN instruction tells the model the same thing, but an instruction is a
 * request and this is a check. A rule extractor that matched "call me" against
 * "call me when the OTP arrives" would write a credential into a durable table
 * that no later redaction reaches.
 */
const NEVER_LEARN =
  /\b(?:password|passcode|passphrase|otp|one[- ]time|pin|secret|api[ -]?key|token|cvv|card number|aadhaar|aadhar|pan number|account number)\b/i;

/** One thing a sentence can plainly state. */
interface StatedRule {
  pattern: RegExp;
  domain: MemoryDomain;
  /** The domain payload, or `undefined` to decline this match. */
  build(match: RegExpMatchArray): Record<string, unknown> | undefined;
  confidence: number;
  importance: number;
  reasoning: string;
}

/**
 * What the rules will admit — English and Roman-script Hinglish, both.
 *
 * Every entry matches a *statement about the speaker themselves*. There is
 * deliberately no rule for `episodic` (every exchange would produce one, and
 * "most exchanges leave nothing behind" is the actual policy), none for
 * `relationship` (getting a person's relation wrong is worse than not having
 * it), and none that infers rather than reads.
 *
 * Confidence is high because these are quotations, not inferences: the value was
 * literally in the sentence. Importance is what decides whether it survives the
 * pipeline's threshold, and it is set by how long the fact is likely to hold.
 */
const STATED_RULES: readonly StatedRule[] = [
  {
    pattern: /\bmy name is\s+(.{2,60})$/i,
    domain: 'semantic',
    build: (m) => named(m[1], 'is named'),
    confidence: 0.95,
    importance: 0.9,
    reasoning: 'The speaker stated their own name.',
  },
  {
    pattern: /\bmera naam\s+(.{2,60}?)\s+hai$/i,
    domain: 'semantic',
    build: (m) => named(m[1], 'is named'),
    confidence: 0.95,
    importance: 0.9,
    reasoning: 'The speaker stated their own name.',
  },
  {
    pattern: /\bcall me\s+(.{2,40})$/i,
    domain: 'preference',
    build: (m) => keyed('preferred_name', m[1]),
    confidence: 0.9,
    importance: 0.8,
    reasoning: 'The speaker asked to be called something.',
  },
  {
    pattern: /\bmujhe\s+(.{2,40}?)\s+(?:bulao|bulaao|bulana|kaho|kehna)$/i,
    domain: 'preference',
    build: (m) => keyed('preferred_name', m[1]),
    confidence: 0.9,
    importance: 0.8,
    reasoning: 'The speaker asked to be called something.',
  },
  {
    pattern: /\bi (?:like|love|prefer|enjoy)\s+(.{2,80})$/i,
    domain: 'preference',
    build: (m) => keyed('likes', m[1]),
    confidence: 0.85,
    importance: 0.6,
    reasoning: 'The speaker stated a liking.',
  },
  {
    pattern: /\bmujhe\s+(.{2,80}?)\s+pasand hai$/i,
    domain: 'preference',
    build: (m) => keyed('likes', m[1]),
    confidence: 0.85,
    importance: 0.6,
    reasoning: 'The speaker stated a liking.',
  },
  {
    pattern: /\bi (?:hate|dislike|don'?t like|do not like|can'?t stand)\s+(.{2,80})$/i,
    domain: 'preference',
    build: (m) => keyed('dislikes', m[1]),
    confidence: 0.85,
    importance: 0.6,
    reasoning: 'The speaker stated a dislike.',
  },
  {
    pattern: /\bmujhe\s+(.{2,80}?)\s+(?:pasand nahi|pasand nahin|nahi pasand)$/i,
    domain: 'preference',
    build: (m) => keyed('dislikes', m[1]),
    confidence: 0.85,
    importance: 0.6,
    reasoning: 'The speaker stated a dislike.',
  },
];

/**
 * A semantic triple about whoever was speaking.
 *
 * The subject is the literal word `speaker` rather than `owner`, even when the
 * caller *is* the owner. `DefaultGuestLearningPolicy` quarantines any semantic
 * candidate whose subject is `owner` on the grounds that a non-owner is making a
 * claim about the owner — and "my name is X" said by a guest is a claim about the
 * guest, so labelling it `owner` would send a true statement about the speaker
 * into the owner's quarantine. Who the row is about is carried by its
 * `identity_id` and `subject_kind`, which the policy sets from authoritative
 * state rather than from this string.
 */
function named(raw: string | undefined, predicate: string): Record<string, unknown> | undefined {
  const object = clean(raw);
  if (object === undefined) return undefined;
  return { subject: 'speaker', predicate, object };
}

function keyed(key: string, raw: string | undefined): Record<string, unknown> | undefined {
  const value = clean(raw);
  if (value === undefined) return undefined;
  return { key, value };
}

/**
 * The captured text, or `undefined` when it is not worth keeping.
 *
 * Rejecting a match is a normal outcome. The rules are regular expressions over
 * natural language, and a capture that came back as filler, as a whole further
 * clause, or as something that mentions a credential is better dropped than
 * stored — nothing downstream re-reads the sentence to check.
 */
function clean(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`([]+|["'`)\].,!?]+$/g, '')
    .trim();
  // Trailing courtesy and Hinglish tail particles carry no meaning in a stored
  // value, and leaving them in means 'chai' and 'chai please' dedupe as two
  // different preferences.
  value = value.replace(/\s+(?:please|plz|pls|na|naa|yaar|bhai|ok|okay|hai|hoon|thanks)$/i, '').trim();
  if (value.length < 2 || value.length > 80) return undefined;
  if (NEVER_LEARN.test(value)) return undefined;
  // A capture that still contains a rule marker means the pattern ran past the
  // clause it was meant to describe.
  if (/\b(?:pasand|my name is|mera naam|call me|i like|i love|i hate)\b/i.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * One message split into the clauses a rule may match.
 *
 * The rules are anchored to the end of a clause on purpose. Without the split,
 * "my name is Ankit and I like chai" would capture *"Ankit and I like chai"* as a
 * name — a regular expression cannot tell where one statement stops. Splitting on
 * sentence enders, commas and the joining words costs a little recall ("chai and
 * coffee" yields only the first) and buys correctness, which is the right trade
 * for something that writes to permanent memory.
 */
function clauses(text: string): string[] {
  return text
    .split(/[.;!?\n]+|,| lekin | magar | but | and | aur /i)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 4);
}

/**
 * Learning without a model.
 *
 * What runs when `GOOGLE_API_KEY` is absent, and the reason the no-model
 * configuration is a real way to run rather than a degraded one: she still keeps
 * a name she was told and a preference she was given. It reads only the
 * speaker's own messages — her half of the transcript is her own words, and
 * learning from those is how a system convinces itself of things nobody said.
 */
export class RuleBasedLearningExtractor implements LearningExtractor {
  private readonly resolveKind: CallerKindLookup | undefined;

  constructor(params: { resolveKind?: CallerKindLookup } = {}) {
    this.resolveKind = params.resolveKind;
  }

  extract(cycleRecord: CycleRecord, messages: Message[]): Promise<LearningCandidate[]> {
    const callerKind = this.resolveKind?.(cycleRecord.identityId) ?? UNKNOWN_CALLER_KIND;
    const candidates: LearningCandidate[] = [];
    const seen = new Set<string>();

    for (const message of messages) {
      if (message.role !== 'user') continue;
      if (NEVER_LEARN.test(message.text)) continue;

      for (const clause of clauses(message.text)) {
        for (const rule of STATED_RULES) {
          const match = clause.match(rule.pattern);
          if (!match) continue;
          const content = rule.build(match);
          if (content === undefined) continue;

          // Within one transcript the same thing is often said twice. The
          // pipeline's dedupe engine only sees the database, so a repeat inside
          // a single extraction would reach it as two inserts.
          const fingerprint = `${rule.domain}:${JSON.stringify(content)}`;
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);

          candidates.push({
            domain: rule.domain,
            callerId: cycleRecord.identityId,
            callerKind,
            content,
            confidence: rule.confidence,
            importance: rule.importance,
            reasoning: rule.reasoning,
            extractor: 'rule',
          });
        }
      }
    }

    return Promise.resolve(candidates);
  }
}

// ── The model-backed extractor ─────────────────────────────────────────────

export interface LlmLearningExtractorOptions {
  faculty: TranscriptLearningFaculty;
  resolveKind?: CallerKindLookup | undefined;
  /** What she already holds about this speaker, so it is not proposed twice. */
  known?: KnownMemoryLookup | undefined;
}

/**
 * Learning with a model, still inside the same gates.
 *
 * The faculty is asked what is worth keeping and answers with proposals; this
 * class turns them into candidates and nothing more. It sets no sensitivity, no
 * subject kind and no scope — see the note at the top of this file — and it
 * re-checks the credential filter that the prompt already asked for, because a
 * prompt is a request and this is a check.
 */
export class LlmLearningExtractor implements LearningExtractor {
  private readonly faculty: TranscriptLearningFaculty;
  private readonly resolveKind: CallerKindLookup | undefined;
  private readonly known: KnownMemoryLookup | undefined;

  constructor(options: LlmLearningExtractorOptions) {
    this.faculty = options.faculty;
    this.resolveKind = options.resolveKind;
    this.known = options.known;
  }

  async extract(cycleRecord: CycleRecord, messages: Message[]): Promise<LearningCandidate[]> {
    const callerKind = this.resolveKind?.(cycleRecord.identityId) ?? UNKNOWN_CALLER_KIND;

    const proposals = await this.faculty.proposeExtractionsFromTranscript({
      cycle: {
        status: cycleRecord.status,
        decision: describeDecision(cycleRecord.authorizedDecision),
        answered: describeAnswer(cycleRecord.outputJson),
      },
      messages: messages.map((m) => ({ role: m.role, text: m.text })),
      speakerKind: callerKind,
      alreadyKnown: await this.known?.(cycleRecord.identityId),
    });

    const reasoning = `Proposed by ${this.faculty.modelId} from the stored transcript.`;
    return proposals
      .filter((proposal) => !NEVER_LEARN.test(JSON.stringify(proposal.data)))
      .map((proposal) => ({
        domain: proposal.domain,
        callerId: cycleRecord.identityId,
        callerKind,
        content: proposal.data,
        confidence: proposal.confidence,
        importance: proposal.importance,
        reasoning,
        extractor: 'llm' as const,
      }));
  }
}

/**
 * Builds the extractor the configuration supports.
 *
 * Mirrors `createLanguageFaculties`, with one difference: this never returns
 * `undefined`. There is always a way to learn what was literally said, so a
 * missing model narrows what she notices rather than switching learning off.
 */
export function createLearningExtractor(options: {
  faculty?: TranscriptLearningFaculty | undefined;
  resolveKind?: CallerKindLookup | undefined;
  known?: KnownMemoryLookup | undefined;
}): LearningExtractor {
  if (options.faculty) {
    return new LlmLearningExtractor({
      faculty: options.faculty,
      resolveKind: options.resolveKind,
      known: options.known,
    });
  }
  return new RuleBasedLearningExtractor({
    ...(options.resolveKind ? { resolveKind: options.resolveKind } : {}),
  });
}

/**
 * The stored decision as one short phrase.
 *
 * `CycleRecord.authorizedDecision` is `unknown` because it comes out of a JSON
 * column, so every access here is guarded. A row written by an older version of
 * the application, or by hand in a test, yields `undefined` rather than throwing
 * — the prompt then simply does not mention what she decided.
 */
function describeDecision(decision: unknown): string | undefined {
  if (typeof decision === 'string') return decision.slice(0, 200) || undefined;
  if (decision === null || typeof decision !== 'object') return undefined;
  const proposal = (decision as { proposal?: unknown }).proposal;
  const source = (proposal && typeof proposal === 'object' ? proposal : decision) as {
    action?: unknown;
    rationale?: unknown;
  };
  const action = typeof source.action === 'string' ? source.action : undefined;
  if (action === undefined) return undefined;
  const rationale = typeof source.rationale === 'string' ? source.rationale.slice(0, 200) : undefined;
  return rationale ? `${action} — ${rationale}` : action;
}

/** What she said, out of the cycle's stored output. Guarded for the same reason. */
function describeAnswer(outputJson: string | undefined): string | undefined {
  if (outputJson === undefined || outputJson.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputJson);
  } catch {
    return undefined;
  }
  if (typeof parsed === 'string') return parsed.slice(0, 400) || undefined;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const text = (parsed as { text?: unknown }).text;
  return typeof text === 'string' && text.length > 0 ? text.slice(0, 400) : undefined;
}

// ── The real `known` lookup ────────────────────────────────────────────────

/** The slice of `MemoryRetrieval` the lookup below needs. */
export interface ScopedMemoryReader {
  retrieve(request: {
    callerId: string;
    callerKind: IdentityKind;
    query: string;
    domains: MemoryDomain[];
    limit: number;
    recencyWeight: number;
    importanceWeight: number;
    similarityWeight: number;
    excludeSoftDeleted: boolean;
  }): Promise<{
    items: ReadonlyArray<{
      domain: MemoryDomain;
      summary?: string | undefined;
      subject?: string | undefined;
      predicate?: string | undefined;
      object?: string | undefined;
      key?: string | undefined;
      value?: string | undefined;
      pattern?: string | undefined;
      name?: string | undefined;
      relation?: string | undefined;
    }>;
  }>;
}

/**
 * Builds the lookup that tells the model what she already knows.
 *
 * It goes through `MemoryRetrieval` rather than the repository so the scoping
 * policy applies: the lines handed to the prompt are the ones this caller is
 * allowed to be reminded of, not everything stored under their id.
 *
 * `similarityWeight` is zero because there is no query to be similar to — the
 * question is "what do you hold about this person", not "what bears on this
 * sentence". Importance and recency order the answer instead.
 */
export function knownMemoryLookupFrom(
  reader: ScopedMemoryReader,
  resolveKind?: CallerKindLookup,
): KnownMemoryLookup {
  return async (identityId: string): Promise<readonly string[]> => {
    const result = await reader.retrieve({
      callerId: identityId,
      callerKind: resolveKind?.(identityId) ?? UNKNOWN_CALLER_KIND,
      query: '',
      domains: ['episodic', 'semantic', 'preference', 'habit', 'relationship', 'learned_pattern'],
      limit: 20,
      recencyWeight: 0.3,
      importanceWeight: 0.7,
      similarityWeight: 0,
      excludeSoftDeleted: true,
    });

    return result.items.map((item) => {
      const parts = [
        item.summary,
        [item.subject, item.predicate, item.object].filter(Boolean).join(' ') || undefined,
        item.key !== undefined ? `${item.key} = ${item.value ?? '?'}` : undefined,
        item.pattern,
        [item.name, item.relation].filter(Boolean).join(' — ') || undefined,
      ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
      return `[${item.domain}] ${parts.join(' · ')}`;
    });
  };
}

