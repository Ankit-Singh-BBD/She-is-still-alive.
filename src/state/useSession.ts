/**
 * Whether she knows who is here, and what to do about it.
 *
 * ## Four phases, and why `unreachable` is one of them
 *
 * `waking` → we have not yet asked. `door` → nobody is logged in. `room` → we
 * are. `unreachable` → `GET /api/hello` itself did not answer, which is the only
 * failure that makes every screen a guess: without that one boolean we cannot
 * even tell "set her up" from "let me in". Collapsing it into `door` would show a
 * login form for a server that is not running, and the person would type a
 * passphrase into nothing.
 *
 * ## A 401 from `GET /api/me` is not an error
 *
 * It is the answer for a fresh browser, so it moves us to `door` without a notice.
 * Every *other* failure from that call is surfaced, because "she is there but
 * something about my session is wrong" is worth reading.
 *
 * ## `expire` exists because sessions end mid-conversation
 *
 * A cookie can be revoked, hit its 30 days, or belong to an identity that has
 * since been made dormant. Any hook that gets an auth refusal calls `expire`, and
 * the interface returns to the door rather than sitting in a room it has been
 * evicted from, quietly failing every request.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, ApiFailure, type Hello, type PublicIdentity } from '../lib/api.js';
import { noticeFrom, type Notice } from './notice.js';

export type Phase = 'waking' | 'door' | 'room' | 'unreachable';

export interface SessionState {
  phase: Phase;
  hello: Hello | undefined;
  identity: PublicIdentity | undefined;
  /** A credential request is in flight. Disables the form without hiding it. */
  busy: boolean;
  notice: Notice | undefined;
  clearNotice: () => void;
  /** Resolves `true` when the screen may move on. */
  enrol: (input: {
    displayName: string;
    preferredName?: string;
    passphrase: string;
  }) => Promise<boolean>;
  enter: (passphrase: string) => Promise<boolean>;
  leave: () => Promise<void>;
  /** Called by other hooks when the server says this session is no longer good. */
  expire: () => void;
  /** Ask `GET /api/hello` again, for the `unreachable` screen's one button. */
  retry: () => void;
}

export function useSession(): SessionState {
  const [phase, setPhase] = useState<Phase>('waking');
  const [hello, setHello] = useState<Hello | undefined>(undefined);
  const [identity, setIdentity] = useState<PublicIdentity | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const greeting = await api.hello();
        if (!live) return;
        setHello(greeting);
      } catch (error) {
        if (!live) return;
        setNotice(noticeFrom(error));
        setPhase('unreachable');
        return;
      }
      try {
        const me = await api.me();
        if (!live) return;
        setIdentity(me.identity);
        setNotice(undefined);
        setPhase('room');
      } catch (error) {
        if (!live) return;
        // The expected answer for a browser that has never logged in.
        if (!(error instanceof ApiFailure && error.isAuth)) setNotice(noticeFrom(error));
        setPhase('door');
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  const clearNotice = useCallback(() => setNotice(undefined), []);

  const enrol = useCallback<SessionState['enrol']>(async (input) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const session = await api.bootstrap(input);
      setIdentity(session.identity);
      // `ownerEnrolled` and two lines of `absentAtBoot` are now stale. Re-read
      // rather than patching the local copy: the server is the authority on both.
      setHello(await api.hello().catch(() => undefined));
      setPhase('room');
      return true;
    } catch (error) {
      setNotice(noticeFrom(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const enter = useCallback<SessionState['enter']>(async (passphrase) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const session = await api.login({ passphrase });
      setIdentity(session.identity);
      setPhase('room');
      return true;
    } catch (error) {
      setNotice(noticeFrom(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await api.logout();
    } catch {
      // `DELETE /api/session` answers 204 even for a session that was already
      // dead, so a failure here is transport. Either way the intent was to stop
      // being logged in, and locally we are.
    } finally {
      setBusy(false);
      setIdentity(undefined);
      setNotice(undefined);
      setPhase('door');
    }
  }, []);

  const expire = useCallback(() => {
    setIdentity(undefined);
    setPhase('door');
    setNotice({
      kind: 'refusal',
      message: 'That session has ended. Let her know it is you again.',
      issues: [],
      retryAfterMs: undefined,
    });
  }, []);

  const retry = useCallback(() => {
    setPhase('waking');
    setNotice(undefined);
    setAttempt((n) => n + 1);
  }, []);

  return {
    phase,
    hello,
    identity,
    busy,
    notice,
    clearNotice,
    enrol,
    enter,
    leave,
    expire,
    retry,
  };
}
