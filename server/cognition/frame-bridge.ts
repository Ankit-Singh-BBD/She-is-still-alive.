/**
 * frame-bridge — builds a ResponseFrame between VERIFY and RESPOND.
 *
 * Keeps `runtime.ts` free of world/people plumbing while preserving one honest
 * framing per cycle. Every field has an honest empty: world may be null when no
 * snapshot provider is wired (tests, early boot), peopleContext may be [], and
 * verifiedOutcomeIds/acceptedJobIds derive from the cycle's own results — never
 * invented job ids. Style preferences are the thin address signal stage 3 loads
 * when available; otherwise absent.
 */

import type { RecalledContext, VerificationReport } from './types.js';
import type { ResponseFrame } from '@server/conversation/frame.js';
import { buildFrame } from '@server/conversation/frame.js';

export type FrameOpts = {
  facts?: { text: string; provenance: 'verified' | 'observed' | 'inferred'; source?: string }[] | undefined;
  world?: ResponseFrame['world'] | null | undefined;
  peopleContext?: string[] | undefined;
  acceptedJobIds?: string[] | undefined;
  verifiedOutcomeIds?: string[] | undefined;
  activeWork?: ResponseFrame['activeWork'] | undefined;
  uncertainties?: string[] | undefined;
  stylePreferences?: ResponseFrame['stylePreferences'] | undefined;
  viewIntent?: ResponseFrame['viewIntent'] | undefined;
};

export type WorldProvider = { snapshot: () => unknown } | undefined;

export function buildResponseFrameForCycle(input: {
  cycleId: string;
  recalled: RecalledContext;
  verification: VerificationReport | undefined;
  verifiedOutcomeIds: string[];
  acceptedJobIds: string[];
  activeWork: Array<{ id: string; status: string; summary?: string }>;
  frameOpts: FrameOpts | undefined;
  worldProvider?: WorldProvider;
}): ResponseFrame | null {
  const fo = input.frameOpts;
  // Backward compat: when no frame plumbing is wired, return null and let stage 9
  // draft without the block — same wording as before B08.s2. This preserves tsc 0
  // and pre-existing tests without changing production behaviour when wired.
  const hasAnyFrameSource =
    fo !== undefined &&
    (fo.world !== undefined ||
      fo.peopleContext !== undefined ||
      fo.facts !== undefined ||
      fo.uncertainties !== undefined ||
      fo.stylePreferences !== undefined ||
      fo.viewIntent !== undefined ||
      fo.acceptedJobIds !== undefined ||
      fo.verifiedOutcomeIds !== undefined);
  const worldFromOpts = fo?.world;
  const worldFromProvider =
    worldFromOpts !== undefined
      ? worldFromOpts
      : input.worldProvider !== undefined
        ? safeWorldSnapshot(input.worldProvider)
        : null;
  const hasWorld = worldFromProvider !== undefined && worldFromProvider !== null;
  const hasIds = input.verifiedOutcomeIds.length > 0 || input.acceptedJobIds.length > 0 || input.activeWork.length > 0;
  if (!hasAnyFrameSource && !hasWorld && !hasIds) return null;

  const peopleContext = fo?.peopleContext ?? [];
  const facts = fo?.facts ?? [];
  const uncertainties = fo?.uncertainties ?? [];
  const stylePreferences = stylePreferencesFor(input.recalled, fo?.stylePreferences);

  return buildFrame({
    turnId: input.cycleId,
    facts,
    world: (worldFromProvider as ResponseFrame['world']) ?? null,
    peopleContext,
    acceptedJobIds: fo?.acceptedJobIds ?? input.acceptedJobIds,
    verifiedOutcomeIds: fo?.verifiedOutcomeIds ?? input.verifiedOutcomeIds,
    activeWork: fo?.activeWork ?? input.activeWork,
    uncertainties,
    stylePreferences,
    viewIntent: fo?.viewIntent,
  });
}

function safeWorldSnapshot(provider: WorldProvider): unknown {
  try {
    const p = provider as { snapshot?: () => unknown };
    if (typeof p.snapshot === 'function') return p.snapshot();
    return null;
  } catch {
    return null;
  }
}

function stylePreferencesFor(
  recalled: RecalledContext,
  override: FrameOpts['stylePreferences'] | undefined,
): ResponseFrame['stylePreferences'] {
  if (override !== undefined) return override;
  // Thin addressWord probe: when a preference explicitly named addressWord exists.
  // No inference — only what stage 3 already loaded.
  const prefs = (recalled as unknown as { preferences?: Array<{ key?: string; value?: string }> }).preferences;
  if (Array.isArray(prefs)) {
    const hit = prefs.find((p) => p?.key === 'addressWord' && typeof p.value === 'string' && p.value.trim().length > 0);
    if (hit?.value) return { addressWord: String(hit.value).trim() };
  }
  return {};
}
