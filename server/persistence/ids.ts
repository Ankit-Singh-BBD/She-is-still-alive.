/**
 * The one place an identifier is minted.
 *
 * ## The defect this file exists to remove
 *
 * Every id in this system is a ULID, and seventeen modules each called `ulid()`
 * from the package directly. A ULID is a 48-bit millisecond timestamp followed by
 * 80 bits of randomness, and the package's default export re-rolls that randomness
 * on every call — so two ids minted inside the same millisecond sort in a **random**
 * order relative to each other. Five calls at a pinned timestamp, observed:
 *
 * ```
 * 01M1S8VNDHYKJAMBV6ZBGKGCHF
 * 01M1S8VNDHHPHHKN02JF2D86MH   ← lower than the id minted before it
 * 01M1S8VNDHSSD7C3ZAP0GHKA6M
 * 01M1S8VNDH49NX0PTWCD8ZWP0D   ← and again
 * 01M1S8VNDH2AQTQP5BHZAFE8J2
 * ```
 *
 * Three of those four adjacent pairs are out of insertion order. That would be
 * harmless if nothing sorted by id — but the codebase reads `id` as *the*
 * tie-break wherever two rows share a timestamp, and shares a timestamp often,
 * because most tables default their time columns to `datetime('now')`, which has
 * **second** granularity. Same-second rows are the normal case, not the edge case:
 *
 * - `server/security/audit.ts` — `ORDER BY seq IS NULL, seq ASC, timestamp ASC,
 *   id ASC`, twice, and one of those walks the audit hash chain. Rows replayed in
 *   the wrong order verify against the wrong predecessor.
 * - `server/conversations/repository.ts` — `ORDER BY started_at DESC, id DESC
 *   LIMIT 1` picks "her current conversation". Two conversations opened in the same
 *   second and the winner was a coin flip.
 * - `server/advanced/dream.ts` — folds duplicate recollections and keeps the
 *   earliest, tie-breaking on id. Its header promises the survivor is the row
 *   "whose provenance points at the cycle that actually learned the thing"; with a
 *   random tie-break that promise held about half the time, and nothing in the
 *   record would have said which half.
 *
 * That last one is how this was found: a test folded two identical recollections
 * and asserted which row survived, and it passed or failed depending on the run.
 *
 * ## The fix, and why it is one shared factory rather than seventeen
 *
 * `monotonicFactory()` keeps the previous timestamp and, when the clock has not
 * advanced, *increments the random field* instead of re-rolling it. Ids minted in
 * the same millisecond then differ by one and sort in the order they were minted:
 *
 * ```
 * 01M1S8VNDH1CX6NJDS5QYA0ZMV
 * 01M1S8VNDH1CX6NJDS5QYA0ZMW
 * 01M1S8VNDH1CX6NJDS5QYA0ZMX
 * ```
 *
 * The monotonic guarantee is a property of the factory's own state, so two
 * factories are two independent sequences and ids from one say nothing about ids
 * from the other. One factory per process is therefore not a tidiness preference —
 * it is the condition under which `ORDER BY id` means insertion order at all. This
 * module owns it, and `ulid` is imported nowhere else.
 *
 * ## What it deliberately does not promise
 *
 * If the clock steps backwards — NTP correcting a drift, or a test pinning a fake
 * `Date` — the factory keeps incrementing from the newest timestamp it has seen
 * rather than emitting ids that sort before ones already handed out. Ordering is
 * preserved; the timestamp embedded in the id is briefly ahead of the wall clock.
 * That is the right trade for this system: the embedded timestamp is decoded
 * nowhere (no `decodeTime` call exists), while the ordering is load-bearing in an
 * audit chain. Anything that needs to know *when* a row was written reads the row's
 * own time column, which is stored explicitly for exactly that reason.
 */

import { monotonicFactory } from 'ulid';

const nextId = monotonicFactory();

/**
 * A new identifier, sorting after every identifier this process has already minted.
 *
 * Drop-in for the package's `ulid()`: same 26-character Crockford-base32 shape,
 * same uniqueness, plus the ordering the callers already assumed.
 */
export function ulid(): string {
  return nextId();
}
