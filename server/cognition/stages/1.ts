/**
 * Stage 1: PERCEIVE
 * Application responsibility: Receive input (text, audio, system event, proactive trigger),
 * normalize timestamps, validate structure.
 */

import type { RawStimulus } from '../types.js';

export function perceive(stimulus: RawStimulus): RawStimulus {
  if (!stimulus.source) {
    throw new Error('PERCEIVE: Stimulus source is required');
  }
  if (!stimulus.identityId) {
    throw new Error('PERCEIVE: Stimulus identityId is required');
  }

  return {
    source: stimulus.source,
    payload: stimulus.payload ?? {},
    receivedAt: stimulus.receivedAt || Date.now(),
    identityId: stimulus.identityId,
    conversationId: stimulus.conversationId,
    sessionId: stimulus.sessionId,
  };
}
