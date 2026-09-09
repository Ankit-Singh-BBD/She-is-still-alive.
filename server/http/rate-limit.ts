/**
 * A fixed-window limiter, and the honest account of what it does and does not
 * protect.
 *
 * ## What already existed
 *
 * `IdentityRepository` throttles the owner's passphrase and recovery code with
 * exponential backoff keyed by *identity* (`AUTH_MAX_ATTEMPTS = 5`, then
 * 30s doubling to 15m). That is the strong control, it is persistent, and it
 * survives a restart because it lives in the `auth_attempt` table.
 *
 * This is the weak control it needs beside it: the repository counter cannot
 * stop a caller from making ten thousand *shaped* requests a second, because
 * every one of those is a database write and a scrypt hash. Without a limiter
 * in front, the lockout mechanism is itself the denial of service.
 *
 * ## What this does not do
 *
 * It is in-memory and per-process, so it resets on restart and does not
 * coordinate across replicas. For a single-owner application that runs one
 * process on one machine that is the whole population, and a persistent table
 * would add a write to the hot path of every request to defend against an
 * attacker who can already restart the process. Saying so here is cheaper than
 * discovering it later from a comment that claimed more than the code does.
 *
 * It is also not a defence against a distributed source: the key is whatever
 * `keyOf` returns, usually an IP, and an attacker with a thousand of those gets
 * a thousand windows. The per-identity backoff in the repository is what covers
 * that case, which is exactly why both exist.
 */

/** One limiter's shape. Windows are fixed, not sliding — see `check`. */
export interface RateLimitRule {
  /** How many requests one key may make per window. */
  readonly limit: number;
  /** The window length in milliseconds. */
  readonly windowMs: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Requests left in this window, after counting the current one. */
  readonly remaining: number;
  /** Milliseconds until the window rolls over. */
  readonly retryAfterMs: number;
}

interface Window {
  count: number;
  /** Epoch ms at which this window expires. */
  resetAt: number;
}

/**
 * How often expired windows are swept out.
 *
 * Without a sweep the map grows once per distinct key forever, which for an
 * IP-keyed limiter is a slow memory leak an attacker chooses the rate of. The
 * sweep is `unref`'d so it never holds the process open by itself — a timer that
 * keeps a CLI alive after `stop()` is the bug `server/app.ts`'s weather sweep
 * had to avoid too.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Counts requests per key per window.
 *
 * Fixed windows, not sliding: a sliding window needs every timestamp retained
 * per key, and the failure mode it fixes — up to `2 × limit` requests across a
 * window boundary — is not one that matters when the limit is "20 login
 * attempts a minute" rather than a billing quota.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly rule: RateLimitRule;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(rule: RateLimitRule, now: () => number = Date.now) {
    this.rule = rule;
    this.now = now;
  }

  /**
   * Counts one request against `key` and says whether it may proceed.
   *
   * A refused request still counts. That is deliberate: not counting it would
   * let a caller who is already over the limit keep hammering for free, and the
   * point of the window is to make the next one wait.
   */
  check(key: string): RateLimitVerdict {
    const at = this.now();
    this.ensureSweeping();

    const existing = this.windows.get(key);
    const window: Window =
      existing !== undefined && existing.resetAt > at
        ? existing
        : { count: 0, resetAt: at + this.rule.windowMs };

    window.count += 1;
    this.windows.set(key, window);

    const retryAfterMs = Math.max(0, window.resetAt - at);
    if (window.count > this.rule.limit) {
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    return { allowed: true, remaining: this.rule.limit - window.count, retryAfterMs };
  }

  /**
   * Forgets a key's window.
   *
   * Called after a *successful* login, so a person who mistyped their passphrase
   * four times and then got it right is not still carrying four counts against
   * them. The repository's own `failedCount` is reset by the same success for
   * the same reason.
   */
  forget(key: string): void {
    this.windows.delete(key);
  }

  /** For the tests, and for a boot report that wants to say it is empty. */
  size(): number {
    return this.windows.size;
  }

  /** Drops every window and stops the sweep. Idempotent. */
  stop(): void {
    this.windows.clear();
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private ensureSweeping(): void {
    if (this.sweepTimer !== undefined) return;
    this.sweepTimer = setInterval(() => {
      const at = this.now();
      for (const [key, window] of this.windows) {
        if (window.resetAt <= at) this.windows.delete(key);
      }
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }
}
