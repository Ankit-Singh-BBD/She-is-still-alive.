/**
 * ResponseFrame — what the responder may truthfully say (01-VISION).
 *
 * Built by the coordinator/runtime *before* the Faculty drafts wording, so the
 * model writes from facts rather than guesses. Every field has an honest empty:
 * world fields may be unknown, peopleContext may be [], verifiedOutcomeIds may
 * be [], uncertainties may name what is missing. A missing signal never blocks a
 * greeting — it is just absent from the frame.
 *
 * Acceptance vs completion (the gate B08 s2 exists to enforce):
 *   acceptedJobIds  — durably stored, not yet proven done. May be acknowledged
 *                     ("bana rahi hoon"), never "ho gaya".
 *   verifiedOutcomeIds — stage 8 re-read authoritative state and found it
 *                     changed. Only these may be called completed.
 */

import type { WorldSnapshot } from '@server/world/model.js';

export type ProvenanceKind = 'verified' | 'observed' | 'inferred';

export interface FramedFact {
  text: string;
  provenance: ProvenanceKind;
  source?: string | undefined;
}

export interface ResponseFrame {
  turnId: string;
  facts: FramedFact[];
  world: WorldSnapshot | null;
  peopleContext: string[];
  acceptedJobIds: string[];
  verifiedOutcomeIds: string[];
  activeWork: Array<{ id: string; status: string; summary?: string | undefined }>;
  uncertainties: string[];
  stylePreferences: { addressWord?: string | undefined; language?: string | undefined };
  viewIntent?: { showWork?: boolean | undefined; workId?: string | undefined } | undefined;
}

/**
 * Completion language is only allowed when at least one verified outcome is
 * present. Both English and Hinglish light-verb completions count (mirrors
 * stages/9.ts CLAIM patterns but exposed here so pre-TTS validation has one
 * authority, not a copy).
 */
const CLAIM_EN = /\b(done|completed|complete|succeeded|success|successful|finished|all set|taken care of|already|sent|saved|scheduled|deleted)\b/i;
const CLAIM_HI = /(?:ho\s*ga(?:ya|yi|ye)|hogaya|kar\s*d(?:iya|iye|i)|laga\s*d(?:iya|i)|bhej\s*d(?:iya|i)|daal\s*d(?:iya|i)|chalu\s*kar\s*d|band\s*kar\s*d|set\s*kar\s*d)|हो\s*गय[ाीे]|कर\s*द(?:िया|ी)|लगा\s*द(?:िया|ी)|भेज\s*द(?:िया|ी)|डाल\s*द(?:िया|ी)/i;

export function claimsCompletion(text: string): boolean {
  return CLAIM_EN.test(text) || CLAIM_HI.test(text);
}

export function isCompletionAllowed(frame: ResponseFrame, text: string): boolean {
  if (!claimsCompletion(text)) return true;
  return frame.verifiedOutcomeIds.length > 0;
}

export function groundingViolation(frame: ResponseFrame, text: string): string | null {
  if (isCompletionAllowed(frame, text)) return null;
  if (frame.acceptedJobIds.length > 0 || frame.activeWork.length > 0) {
    return 'accepted but not verified — acknowledge as in-progress, do not claim completion';
  }
  return 'no verified outcome — do not claim completion';
}

export function buildFrame(input: {
  turnId: string;
  facts?: FramedFact[] | undefined;
  world?: WorldSnapshot | null | undefined;
  peopleContext?: string[] | undefined;
  acceptedJobIds?: string[] | undefined;
  verifiedOutcomeIds?: string[] | undefined;
  activeWork?: ResponseFrame['activeWork'] | undefined;
  uncertainties?: string[] | undefined;
  stylePreferences?: ResponseFrame['stylePreferences'] | undefined;
  viewIntent?: ResponseFrame['viewIntent'] | undefined;
}): ResponseFrame {
  return {
    turnId: input.turnId,
    facts: input.facts ?? [],
    world: input.world ?? null,
    peopleContext: input.peopleContext ? input.peopleContext.slice(0, 6) : [],
    acceptedJobIds: input.acceptedJobIds ?? [],
    verifiedOutcomeIds: input.verifiedOutcomeIds ?? [],
    activeWork: input.activeWork ?? [],
    uncertainties: input.uncertainties ?? [],
    stylePreferences: input.stylePreferences ?? {},
    ...(input.viewIntent ? { viewIntent: input.viewIntent } : {}),
  };
}
