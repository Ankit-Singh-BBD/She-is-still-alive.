/**
 * Turning a refusal into something worth reading.
 *
 * Every failure the server can produce already carries a sentence written for a
 * person — `server/http/` builds those from counters and field names, never from a
 * credential — so the work here is not writing copy, it is deciding *tone*. A
 * refusal ("that passphrase is wrong") is the interface working correctly and
 * should read calmly. Trouble ("she cannot be reached") is the interface failing
 * and should say so plainly rather than blaming the person.
 *
 * The distinction matters because the alternative is one grey "Error:" prefix on
 * both, which trains a reader to ignore the line that eventually matters.
 */

import { ApiFailure } from '../lib/api.js';

export interface Notice {
  /** `refusal`: the request was understood and declined. `trouble`: it did not land. */
  kind: 'refusal' | 'trouble';
  message: string;
  /** Field-level detail from a rejected body. Rendered under the message. */
  issues: readonly string[];
  /** Present on a rate limit or a lockout: how long the door stays shut. */
  retryAfterMs: number | undefined;
}

/**
 * `trouble` is the smaller set on purpose.
 *
 * Only two codes mean the interface itself is in trouble: `offline` (the request
 * never completed) and `unexpected` (the server hit something it could not name).
 * Everything else — wrong passphrase, locked out, too many turns, realtime
 * switched off — is the system doing its job, and dressing those as errors would
 * make her look broken every time she was merely careful.
 */
export function noticeFrom(error: unknown): Notice {
  if (error instanceof ApiFailure) {
    return {
      kind: error.code === 'offline' || error.code === 'unexpected' ? 'trouble' : 'refusal',
      message: error.message,
      issues: error.issues,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    kind: 'trouble',
    message: error instanceof Error ? error.message : 'Something went wrong on this side.',
    issues: [],
    retryAfterMs: undefined,
  };
}

/** "in 4 seconds" / "in 3 minutes", for a lockout worth waiting out. */
export function waitHint(retryAfterMs: number | undefined): string | undefined {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return undefined;
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 90) return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
