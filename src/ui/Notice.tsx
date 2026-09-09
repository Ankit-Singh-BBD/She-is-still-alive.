/**
 * The one place a refusal is shown.
 *
 * `notice.ts` has already decided the tone; this only draws it. Two things are
 * deliberate:
 *
 * 1. **It is announced.** A refusal that only appears visually is invisible to
 *    anyone using a screen reader, and the most likely refusal here — a wrong
 *    passphrase — is one you are actively waiting to hear about. `alert` for
 *    trouble, `status` for a refusal, which is the difference between interrupting
 *    and waiting for a pause.
 * 2. **The issues are a list, not a sentence.** `invalid_request` can carry several
 *    field messages, and joining them with commas produces a run-on that reads as
 *    one long complaint instead of two short fixable ones.
 */

import type { ReactElement } from 'react';

import { waitHint, type Notice as NoticeValue } from '../state/notice.js';

export interface NoticeProps {
  notice: NoticeValue | undefined;
}

export function Notice({ notice }: NoticeProps): ReactElement | null {
  if (notice === undefined) return null;
  const wait = waitHint(notice.retryAfterMs);

  return (
    <div
      className="notice"
      data-kind={notice.kind}
      role={notice.kind === 'trouble' ? 'alert' : 'status'}
      aria-live={notice.kind === 'trouble' ? 'assertive' : 'polite'}
    >
      <span>{notice.message}</span>
      {notice.issues.length > 0 ? (
        <ul className="notice-issues">
          {notice.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {wait !== undefined ? <span className="notice-wait">{wait}</span> : null}
    </div>
  );
}
