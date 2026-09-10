/**
 * B08.s2 — ResponseFrame grounding + pre-TTS gate.
 *
 * Two invariants, each with the "exhibit the defect" shape:
 *  - frame.ts is the authority for "may we say ho gaya?": only when
 *    verifiedOutcomeIds non-empty.
 *  - stages/9.ts pre-TTS gate (grounding_frame) suppresses an LLM draft
 *    claiming completion over an accepted-but-unverified outcome, in both
 *    English and Hinglish — no TTS of unverified "ho gaya".
 */

import { describe, it, expect } from 'vitest';
import { buildFrame, claimsCompletion, groundingViolation, isCompletionAllowed } from '@server/conversation/frame.js';
import { respond } from '@server/cognition/stages/9.js';
import type { RecalledContext, AuthorizedDecision, ActionResult } from '@server/cognition/types.js';

function frameWithIds(opts: {
  verifiedOutcomeIds?: string[];
  acceptedJobIds?: string[];
  activeWork?: { id: string; status: string }[];
}): ReturnType<typeof buildFrame> {
  return buildFrame({ turnId: 't1', ...opts });
}

function recalledContext(): RecalledContext {
  // Use the same shape p09 tests use (IdentifiedStimulus has callerPermissions etc.)
  const identified = {
    source: 'text' as const,
    payload: { text: 'Kal 7 baje yaad dilana' },
    receivedAt: Date.now(),
    identityId: 'owner-1',
    conversationId: 'conv-1',
    identityKind: 'owner' as const,
    callerPermissions: { mayReadMemories: true, mayReadConversations: true, mayTriggerActions: true, mayEnrollNewKnowledge: true, mayBeHeardInVoice: true, mayInterruptWork: true, mayViewHealth: true, mayManageIdentity: true } as unknown as { mayBeHeardInVoice: boolean },
    inputType: 'user_message' as const,
  };
  return {
    stimulus: identified,
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    recentTurns: [],
    retrievedAt: Date.now(),
  } as unknown as RecalledContext;
}

function decision(): AuthorizedDecision {
  return {
    proposal: { action: 'respond', rationale: 'ok' },
    authorized: true,
    clearance: { kind: 'not_required' },
  };
}

describe('ResponseFrame grounding (frame.ts authority)', () => {
  it('claimsCompletion covers English and Hinglish', () => {
    expect(claimsCompletion('Done!')).toBe(true);
    expect(claimsCompletion('Ho gaya!')).toBe(true);
    expect(claimsCompletion('kar diya')).toBe(true);
    expect(claimsCompletion('लगा दिया')).toBe(true);
    expect(claimsCompletion('hello — just thinking')).toBe(false);
  });

  it('no verified outcome → no completion allowed, violation explains why', () => {
    const f = frameWithIds({ verifiedOutcomeIds: [], acceptedJobIds: ['reminder.schedule'] });
    expect(isCompletionAllowed(f, 'Done — scheduled')).toBe(false);
    expect(groundingViolation(f, 'Done')).toContain('accepted but not verified');
    const f2 = frameWithIds({ verifiedOutcomeIds: [] });
    expect(groundingViolation(f2, 'Done')).toContain('no verified outcome');
  });

  it('verified outcome → completion allowed', () => {
    const f = frameWithIds({ verifiedOutcomeIds: ['reminder.schedule'] });
    expect(isCompletionAllowed(f, 'Done')).toBe(true);
    expect(groundingViolation(f, 'Done')).toBeNull();
  });

  it('non-completion phrasing is always allowed even without verified outcomes', () => {
    const f = frameWithIds({ verifiedOutcomeIds: [] });
    expect(isCompletionAllowed(f, 'I am looking into that.')).toBe(true);
    expect(groundingViolation(f, 'I am looking into that.')).toBeNull();
  });
});

describe('stages/9 pre-TTS grounding gate (B08.s2 defect → fix)', () => {
  it('suppresses Hinglish completion "ho gaya" over accepted-but-unverified outcome', async () => {
    const frame = frameWithIds({
      verifiedOutcomeIds: [],
      acceptedJobIds: ['reminder.schedule'],
      activeWork: [{ id: 'j1', status: 'running' }],
    });
    const llm = { draftResponse: async () => ({ text: 'Ho gaya — laga diya!' }) };
    const results: ActionResult[] = [{ toolId: 'reminder.schedule', attempted: true, success: true, verified: false }];
    const verification = { postconditionsMet: false, discrepancies: ['not verified'], results, recheckedAt: Date.now() };
    const res = await respond(recalledContext(), decision(), results, verification, { llm, frame } as never);
    expect(res.text.toLowerCase()).not.toMatch(/ho gaya|kar diya|laga diya|done|completed/);
    expect(res.disclosuresApplied).toContain('grounding_frame');
  });

  it('suppresses English "Done — scheduled" over ungrounded frame', async () => {
    const frame = frameWithIds({ verifiedOutcomeIds: [], acceptedJobIds: ['reminder.schedule'] });
    const llm = { draftResponse: async () => ({ text: 'Done — scheduled!' }) };
    const results: ActionResult[] = [{ toolId: 'reminder.schedule', attempted: true, success: true, verified: false }];
    const verification = { postconditionsMet: false, discrepancies: ['not verified'], results, recheckedAt: Date.now() };
    const res = await respond(recalledContext(), decision(), results, verification, { llm, frame } as never);
    expect(res.text).not.toMatch(/Done/i);
    expect(res.disclosuresApplied).toContain('grounding_frame');
  });

  it('when frame carries verified outcome, completion language passes the grounding gate', async () => {
    const frame = frameWithIds({ verifiedOutcomeIds: ['reminder.schedule'] });
    const llm = { draftResponse: async () => ({ text: 'Done — scheduled.' }) };
    const results: ActionResult[] = [{ toolId: 'reminder.schedule', attempted: true, success: true, verified: true }];
    const verification = { postconditionsMet: true, discrepancies: [], results, recheckedAt: Date.now() };
    const res = await respond(recalledContext(), decision(), results, verification, { llm, frame } as never);
    // grounding gate must not replace it; text may still be generalized if other policy fires,
    // but grounding_frame must not be applied.
    expect(res.disclosuresApplied).not.toContain('grounding_frame');
  });

  it('without a frame, existing unverified-claim suppression still applies', async () => {
    const llm = { draftResponse: async () => ({ text: 'Done — scheduled!' }) };
    const results: ActionResult[] = [{ toolId: 'reminder.schedule', attempted: true, success: true, verified: false }];
    const verification = { postconditionsMet: false, discrepancies: ['not verified'], results, recheckedAt: Date.now() };
    const res = await respond(recalledContext(), decision(), results, verification, { llm } as never);
    expect(res.text).not.toMatch(/Done/i);
    // grounding_frame absent; unverified_claim_suppression may apply depending on path
    expect(res.disclosuresApplied).not.toContain('grounding_frame');
  });
});
