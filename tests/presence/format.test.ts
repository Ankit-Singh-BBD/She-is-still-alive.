/**
 * The words. Every assertion here is about honesty rather than about wording: that a
 * "do not know" never rounds into a value, and that a degraded cycle never reads as a
 * clean one.
 */

import { describe, expect, it } from 'vitest';

import type { EnvironmentState } from '@server/realtime/types.js';

import type { ActionSummary, ChatReply } from '../../src/lib/api.js';
import {
  actionWords,
  clock,
  cycleWords,
  doingWords,
  environmentWords,
  stageWords,
} from '../../src/ui/format.js';

const PALETTE = { primary: '#111111', secondary: '#222222', accent: '#cc8866' };

function environment(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return {
    timeOfDay: 'sunset',
    weather: { condition: 'rainy', temperature: 18 },
    location: { lat: 12.9, lng: 77.6 },
    derivedPalette: PALETTE,
    ...overrides,
  };
}

/**
 * An action as the wire carries it.
 *
 * `error` is spelled `string | undefined` rather than `error?:` on both sides of the
 * wire, and `exactOptionalPropertyTypes` makes that a *required* property that may
 * hold `undefined` — so it cannot be left out here either. That is the right shape:
 * "no error" is a thing the server says, not a field it forgets.
 */
function action(overrides: Partial<ActionSummary> = {}): ActionSummary {
  return {
    toolId: 'remember',
    attempted: true,
    success: true,
    verified: false,
    error: undefined,
    ...overrides,
  };
}

function reply(overrides: Partial<ChatReply> = {}): ChatReply {
  return {
    conversationId: 'conversation',
    cycleId: 'cycle',
    status: 'completed',
    text: 'hello',
    voiceEnabled: false,
    redacted: false,
    disclosures: [],
    fellBackAt: [],
    actions: [],
    startedAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

describe('doingWords', () => {
  it('has a phrase for every one of the twelve stages', () => {
    const stages = [
      'PERCEIVE',
      'IDENTIFY',
      'RECALL',
      'UNDERSTAND',
      'REASON',
      'DECIDE',
      'ACT',
      'VERIFY',
      'RESPOND',
      'LEARN',
      'UPDATE',
      'PERSIST',
    ] as const;
    const words = stages.map((stage) => doingWords(stage));
    expect(words.every((word) => word.length > 0)).toBe(true);
    // Distinct, or the line would report the wrong stage as convincingly as the right one.
    expect(new Set(words).size).toBe(stages.length);
  });
});

describe('stageWords', () => {
  it('translates a known stage name into the same vocabulary the live line uses', () => {
    expect(stageWords('REASON')).toBe(doingWords('REASON'));
  });

  it('passes an unrecognised name through rather than guessing', () => {
    // `StageTrace.stageName` is a plain string on the server, so this is reachable.
    expect(stageWords('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('environmentWords', () => {
  it('reads the hour and the sky', () => {
    expect(environmentWords(environment())).toEqual(['last light', 'rain', '18°']);
  });

  it('says she cannot see the sky rather than naming a condition she did not observe', () => {
    const words = environmentWords(
      environment({ weather: { condition: 'unknown' }, location: undefined }),
    );
    expect(words).toContain('no view of the sky');
    expect(words).not.toContain('clear');
  });

  it('omits an absent temperature instead of drawing zero', () => {
    expect(environmentWords(environment({ weather: { condition: 'clear' } }))).toEqual([
      'last light',
      'clear',
    ]);
  });

  it('omits a non-finite temperature', () => {
    expect(
      environmentWords(environment({ weather: { condition: 'clear', temperature: Number.NaN } })),
    ).toEqual(['last light', 'clear']);
  });

  it('reports an unknown location as an absence, not as coordinates', () => {
    const words = environmentWords(environment({ location: undefined }));
    expect(words).toContain('nowhere in particular');
    expect(words.join(' ')).not.toMatch(/\d+\.\d+/);
  });
});

describe('cycleWords', () => {
  it('says nothing at all about a clean cycle', () => {
    expect(cycleWords(reply())).toBeUndefined();
    expect(cycleWords(undefined)).toBeUndefined();
  });

  it('names the stage that fell back, in words that cannot be misread as prose', () => {
    const words = cycleWords(reply({ status: 'degraded', fellBackAt: ['REASON'] }));
    expect(words).toBe(`she answered, but one stage fell back — ${doingWords('REASON')}`);
  });

  it('counts distinct stages, not traces', () => {
    const words = cycleWords(reply({ status: 'degraded', fellBackAt: ['REASON', 'REASON'] }));
    expect(words).toContain('one stage');
  });

  it('pluralises for more than one', () => {
    const words = cycleWords(reply({ status: 'degraded', fellBackAt: ['REASON', 'DECIDE'] }));
    expect(words).toContain('2 stages');
    expect(words).toContain(doingWords('DECIDE'));
  });

  it('never says "0 stages" when the verdict and the traces disagree', () => {
    const words = cycleWords(reply({ status: 'degraded', fellBackAt: [] }));
    expect(words).toBe('she answered, but not cleanly — no stage was named');
  });

  it('reports a failed cycle as failed', () => {
    expect(cycleWords(reply({ status: 'failed' }))).toBe('that cycle failed to close');
  });

  it('reports a redaction with its reason', () => {
    expect(cycleWords(reply({ redacted: true, disclosures: ['owner-only memory'] }))).toContain(
      'owner-only memory',
    );
  });

  it('still reports a redaction that arrived without a reason', () => {
    expect(cycleWords(reply({ redacted: true }))).toContain('no reason given');
  });

  it('prefers the degraded verdict over the redaction, since it is the larger fact', () => {
    const words = cycleWords(reply({ status: 'degraded', fellBackAt: ['ACT'], redacted: true }));
    expect(words).toContain('fell back');
  });
});

describe('actionWords', () => {
  it('says nothing when she did not act', () => {
    expect(actionWords(reply())).toBeUndefined();
    expect(actionWords(undefined)).toBeUndefined();
  });

  it('never counts a returned call as a proven one', () => {
    const words = actionWords(reply({ actions: [action({ success: true, verified: false })] }));
    expect(words).toBe('1 unconfirmed');
  });

  it('counts confirmed, unconfirmed, failed and not-run separately', () => {
    const words = actionWords(
      reply({
        actions: [
          action({ toolId: 'a', success: true, verified: true }),
          action({ toolId: 'b', success: true, verified: false }),
          action({ toolId: 'c', success: false, verified: false, error: 'nope' }),
          action({ toolId: 'd', attempted: false, success: false, error: 'not wired' }),
        ],
      }),
    );
    expect(words).toBe('1 confirmed, 1 unconfirmed, 1 failed, 1 not run');
  });

  it('does not call a switched-off capability a failure', () => {
    // A stage 7 refusal — no clearance, or `FLAG_ACTIONS` off — arrives with
    // `attempted: false`. Counting it as "failed" reads as a malfunction and sends
    // someone to debug a setting; "not run" is the honest half, because nothing was
    // touched.
    const words = actionWords(
      reply({ actions: [action({ attempted: false, success: false, error: 'not wired' })] }),
    );
    expect(words).toBe('1 not run');
    expect(words).not.toContain('failed');
  });

  it('does not count a failed call as proven even when it claims to be verified', () => {
    // `summarize` in `server/http/routes/conversation.ts` copies these flags across
    // independently, and the client reads them as three independent booleans, so a
    // pair this contradictory is reachable from the client's side of the wire even
    // though `ActionPipeline` never produces it.
    const words = actionWords(
      reply({ actions: [action({ attempted: true, success: false, verified: true })] }),
    );
    expect(words).not.toContain('confirmed');
    expect(words).toBe('1 failed');
  });
});

describe('clock', () => {
  it('renders a time and never a date', () => {
    const rendered = clock(Date.UTC(2026, 0, 2, 13, 45));
    expect(rendered).toMatch(/\d/);
    expect(rendered).not.toContain('2026');
  });

  it('does not throw on a nonsense timestamp', () => {
    expect(() => clock(Number.NaN)).not.toThrow();
  });
});
