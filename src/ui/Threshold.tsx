/**
 * The door. One column, one field, one button.
 *
 * ## Two forms, one shape
 *
 * `hello.ownerEnrolled` decides whether this enrols the owner or lets them back in.
 * They are the same layout on purpose: the first visit should not feel like a
 * different product from every visit after it. What changes is the headline and how
 * many fields there are.
 *
 * When `hello` is somehow missing the login form is shown, not the enrolment one.
 * Enrolment is a once-per-instance operation and `POST /api/bootstrap` answers
 * `already_bootstrapped` to a second attempt — offering the wrong one is a confusing
 * refusal, and offering it *first* would be worse.
 *
 * ## The recovery code is offered in both directions
 *
 * `POST /api/bootstrap` takes an optional recovery code and hashes it beside the
 * passphrase; `POST /api/session` accepts either one. Without a field for it here,
 * the only way back in after a forgotten passphrase would be `curl` — so it is
 * offered at enrolment as one optional line, and at the door as a quiet toggle.
 *
 * ## What she is starting without
 *
 * `absentAtBoot` is what `start()` found missing — no reasoning key, no owner, a
 * disabled flag. It is on the door because it changes what she can actually do, and
 * it is inside a closed `<details>` because a list of absences is not a greeting.
 */

import { useState, type FormEvent, type ReactElement } from 'react';

import type { SessionState } from '../state/useSession.js';
import { Notice } from './Notice.js';

export interface ThresholdProps {
  session: SessionState;
}

export function Threshold({ session }: ThresholdProps): ReactElement {
  const enrolled = session.hello?.ownerEnrolled ?? true;

  const [displayName, setDisplayName] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [usingRecovery, setUsingRecovery] = useState(false);

  const secret = usingRecovery ? recoveryCode : passphrase;
  const ready = enrolled
    ? secret.trim().length > 0
    : displayName.trim().length > 0 && passphrase.length >= 8;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (session.busy || !ready) return;

    if (enrolled) {
      const ok = await session.enter(
        usingRecovery ? { recoveryCode: recoveryCode.trim() } : { passphrase },
      );
      // Only cleared on success. A wrong passphrase that erases itself makes a
      // typo indistinguishable from a wrong secret, and you retype it either way.
      if (ok) {
        setPassphrase('');
        setRecoveryCode('');
      }
      return;
    }

    await session.enrol({
      displayName: displayName.trim(),
      // `exactOptionalPropertyTypes`: an omitted name is an absent key, never
      // `undefined` in a present one — and the route's schema is `.strict()`.
      ...(preferredName.trim().length > 0 ? { preferredName: preferredName.trim() } : {}),
      passphrase,
      ...(recoveryCode.trim().length > 0 ? { recoveryCode: recoveryCode.trim() } : {}),
    });
  }

  const absent = session.hello?.absentAtBoot ?? [];

  return (
    <div className="threshold">
      <div className="threshold-column">
        <span className="threshold-name">Madhurita</span>

        <div>
          <h1 className="threshold-line">
            {enrolled ? 'She is awake.' : 'She has not met anyone yet.'}
          </h1>
          <p className="threshold-under">
            {enrolled
              ? 'Let her know it is you.'
              : 'Tell her who you are, and choose the words that let you back in. She keeps a hash of them and never the words themselves.'}
          </p>
        </div>

        <form className="threshold-form" onSubmit={(event) => void onSubmit(event)}>
          {!enrolled ? (
            <>
              <input
                className="line"
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
                autoComplete="name"
                maxLength={120}
                aria-label="Your name"
                disabled={session.busy}
              />
              <input
                className="line"
                type="text"
                value={preferredName}
                onChange={(event) => setPreferredName(event.target.value)}
                placeholder="What she should call you (optional)"
                autoComplete="nickname"
                maxLength={120}
                aria-label="What she should call you"
                disabled={session.busy}
              />
            </>
          ) : null}

          {enrolled && usingRecovery ? (
            <input
              className="line"
              type="password"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              placeholder="Recovery code"
              autoComplete="one-time-code"
              maxLength={512}
              aria-label="Recovery code"
              disabled={session.busy}
            />
          ) : (
            <input
              className="line"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={enrolled ? 'Passphrase' : 'A passphrase, at least eight characters'}
              autoComplete={enrolled ? 'current-password' : 'new-password'}
              minLength={enrolled ? undefined : 8}
              maxLength={512}
              aria-label="Passphrase"
              disabled={session.busy}
            />
          )}

          {!enrolled ? (
            <input
              className="line"
              type="text"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              placeholder="A recovery code, in case you forget (optional)"
              autoComplete="off"
              maxLength={512}
              aria-label="Recovery code"
              disabled={session.busy}
            />
          ) : null}

          <button className="pill" type="submit" disabled={session.busy || !ready}>
            {session.busy ? 'One moment' : enrolled ? 'Enter' : 'Let her meet you'}
          </button>
        </form>

        <div className="threshold-foot">
          <Notice notice={session.notice} />

          {enrolled ? (
            <button
              className="plain bar-quiet"
              type="button"
              onClick={() => {
                setUsingRecovery((using) => !using);
                session.clearNotice();
              }}
            >
              {usingRecovery ? 'Use the passphrase' : 'Use a recovery code'}
            </button>
          ) : null}

          {absent.length > 0 ? (
            <details className="absent">
              <summary>What she is starting without</summary>
              <ul className="absent-list">
                {absent.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
