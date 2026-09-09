-- An action row that can tell a refusal from a failure.
--
-- `action_result` held `verified` and `error` and nothing else about the outcome, so
-- two rows that mean opposite things were written identically: a call that was
-- refused before it was ever dispatched, and a call that was dispatched and threw
-- partway. In memory those are `attempted: false` and `attempted: true` — the
-- distinction the honesty contract turns on, because the first means nothing was
-- touched and the second means the world may be half-changed. On the way to disk it
-- was dropped, and the row that outlives every subscriber was the one place that
-- could not say which had happened.
--
-- `discrepancies_json` is the same defect one stage over. Stage 5 computes *why* a
-- postcondition could not be confirmed, stage 6 passed that list into the domain
-- event, and the row recorded only `verified = 0`. So the reason survived exactly as
-- long as something was listening on the bus, and afterwards a row said an action
-- was unverified with no record of what it was that failed to line up. NULL when
-- there were none, rather than an empty array, so that "nothing was wrong" and
-- "nobody looked" stay different.
--
-- `attempted` is nullable and every existing row keeps NULL. A default of 1 would
-- assert that rows written before this migration were dispatched, and some of them
-- were not — `stagePersist` runs for a refusal too. There is no way to recover which
-- from the row, and inventing the more alarming answer for all of them would be the
-- same class of defect as the one being fixed here. NULL means the row predates the
-- distinction and cannot say. Every row written from now on says 0 or 1.

ALTER TABLE action_result ADD COLUMN attempted INTEGER;
ALTER TABLE action_result ADD COLUMN discrepancies_json TEXT;
