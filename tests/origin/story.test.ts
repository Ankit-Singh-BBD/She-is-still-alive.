/**
 * The rules her origin story has to keep, checked against the code it describes.
 *
 * `server/origin/story.ts` is prose in a `.ts` file, and prose is exactly the kind of
 * thing that goes quietly out of date. Most of it can only be kept true by a person
 * reading it — but not all of it, and the parts that *can* be pinned to the code are
 * pinned here. If the reasoning model is swapped in config and nobody edits the story, this
 * file fails; that is its whole job.
 *
 * The other half of the file is about the seed's key. `seedOrigin` decides what is already
 * written by predicate alone, so a story with two facts sharing a predicate would silently
 * lose one of them on a fresh database. Nothing else in the system would notice. Here it
 * is an error, raised at the moment the second one is added.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LIVE_MODEL, DEFAULT_REASONING_MODEL } from '@server/config/env.js';
import { STAGE_NAMES } from '@server/cognition/types.js';
import type { Identity } from '@server/identity/types.js';
import { originStory, type OriginFact } from '@server/origin/index.js';

/** An owner, with both names set so `calledBy` has something to choose between. */
function owner(overrides: Partial<Identity> = {}): Identity {
  return {
    id: 'owner-1',
    kind: 'owner',
    displayName: 'Ankit Singh',
    preferredName: 'Ankit',
    enrolledAt: 1,
    lastSeenAt: 1,
    status: 'active',
    ...overrides,
  };
}

/** Both halves of the story as one list, for the rules that apply to every fact. */
function allFacts(identity: Identity): readonly OriginFact[] {
  const story = originStory(identity);
  return [...story.facts.aboutHer, ...story.facts.aboutHim];
}

describe('originStory — the seed key it has to be safe for', () => {
  it('gives every fact a distinct predicate', () => {
    const predicates = allFacts(owner()).map((fact) => fact.predicate);
    // `seedOrigin` keys on the predicate alone, deliberately: four facts have his name as
    // their subject, so keying on subject-and-predicate would make a rename look like a
    // whole new story and write it all again. The price of that choice is this rule, and
    // the reason it is a test rather than a comment is that breaking it is invisible —
    // the second fact with a duplicate predicate is simply never written.
    expect(new Set(predicates).size).toBe(predicates.length);
  });

  it('never leaves a triple half-written', () => {
    for (const fact of allFacts(owner())) {
      expect(fact.subject.trim(), `subject of "${fact.predicate}"`).not.toBe('');
      expect(fact.predicate.trim()).not.toBe('');
      expect(fact.object.trim(), `object of "${fact.predicate}"`).not.toBe('');
    }
  });

  it('keeps the facts about him about him, which is what their sensitivity rests on', () => {
    const him = 'Ankit';
    const story = originStory(owner());
    // The split is not cosmetic: `seedOrigin` writes `aboutHim` as `owner_only` and
    // `aboutHer` as `public`. A fact about a real person that drifted into the first list
    // would be labelled sayable to anyone.
    for (const fact of story.facts.aboutHim) {
      expect(fact.subject).toBe(him);
    }
    for (const fact of story.facts.aboutHer) {
      expect(fact.subject).toBe('Madhurita');
    }
  });
});

describe('originStory — whose name it is', () => {
  it('calls him what he asked to be called', () => {
    const story = originStory(owner({ preferredName: 'Ankit', displayName: 'Ankit Singh' }));
    expect(story.maker.name).toBe('Ankit');
  });

  it('falls back to the full name when there is no preferred one', () => {
    const story = originStory(owner({ preferredName: undefined }));
    expect(story.maker.name).toBe('Ankit Singh');
  });

  it('falls back when the preferred name is only whitespace', () => {
    // `preferredName` comes from a request body. `BootstrapBodySchema` trims and bounds it
    // but does not require it to be non-empty, so a client can post `"  "` and she would
    // otherwise learn that she was made by nobody in particular.
    const story = originStory(owner({ preferredName: '   ' }));
    expect(story.maker.name).toBe('Ankit Singh');
  });

  it('holds his name nowhere as a literal', () => {
    const mine = JSON.stringify(originStory(owner()));
    const theirs = JSON.stringify(
      originStory(owner({ displayName: 'Someone Else', preferredName: 'Zora' })),
    );
    // The second story must not carry a trace of the first owner. This is the test that
    // would catch a name typed into `story.ts` by hand — which is the one mistake in that
    // file that would make her tell a stranger she was made by somebody else.
    expect(theirs).not.toContain('Ankit');
    expect(theirs).toContain('Zora');
    expect(mine).toContain('Ankit');
  });

  it('names him in more than one place, so one parameter is not carrying the whole story', () => {
    const facts = allFacts(owner()).filter(
      (fact) => fact.subject === 'Ankit' || fact.object.includes('Ankit'),
    );
    expect(facts.length).toBeGreaterThan(1);
  });
});

describe('originStory — the facts that are pinned to the code', () => {
  it('names the twelve stages, in the order the runtime runs them', () => {
    const fact = allFacts(owner()).find((f) => f.predicate === 'thinks in');
    expect(fact).toBeDefined();
    // `STAGE_NAMES` is the map the runtime itself labels traces with. Reading the order
    // out of it rather than restating it means the story cannot describe a cycle she does
    // not run.
    const inOrder = Object.values(STAGE_NAMES).join(', ');
    expect(fact?.object).toContain(inOrder);
  });

  it('names the reasoning model config actually defaults to', () => {
    const fact = allFacts(owner()).find((f) => f.predicate === 'reasons with');
    expect(fact?.object).toContain(DEFAULT_REASONING_MODEL);
  });

  it('names the live model, and keeps the voice a capability rather than a habit', () => {
    const fact = allFacts(owner()).find((f) => f.predicate === 'is meant to speak with');
    expect(fact?.object).toContain(DEFAULT_LIVE_MODEL);
    // This pin used to require the words "not yet wired", because for most of this
    // project's life that was the true statement: the model was chosen and written down
    // long before anything connected to it. `createApp` now builds a real `VoiceEar` when
    // a key is present (`server/app.ts`), so that hedge became the false half — a seeded
    // fact she would state as a belief about a limitation she no longer has.
    //
    // What still has to hold is the other direction: the predicate is "is meant to speak
    // with", and the object records that speech came after reading and writing. Neither
    // may harden into a claim that she is talking right now, which is a thing only a
    // connected socket can be true of.
    expect(fact?.predicate).toBe('is meant to speak with');
    expect(fact?.object).toMatch(/could read and write before she could talk/);
  });

  it('makes exactly one thing an event, and it is the one that just happened', () => {
    const story = originStory(owner());
    expect(story.firstMemory.summary).toContain('Ankit');
    expect(story.firstMemory.details.trim()).not.toBe('');
    // Everything else is knowledge. Her history contains things that predate her — an
    // interface built and deleted, an architecture written before any of it ran — and
    // giving those an `occurredAt` of "whenever the seed ran" would be a fabrication in
    // the column retrieval ranks by.
    expect(story.maker.notes.trim()).not.toBe('');
  });
});
