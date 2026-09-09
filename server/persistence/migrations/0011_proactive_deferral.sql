-- P28 honesty fix: a deferred proactive decision now has somewhere to wait and
-- a way back.
--
-- The decision tree could return 'defer' — for quiet hours, or for an
-- interruption cost above threshold — and the engine persisted that verdict,
-- published it as `proactive.suppressed`, and then dropped the candidate. There
-- was no queue, no re-evaluation, and no timestamp saying when "later" was.
-- "Defer" meant "never", which is the same lie as a cycle that reports
-- `completed` after a stage failed.
--
-- Five columns close it:
--
--   action         The verdict this row currently carries ('emit' | 'defer' |
--                  'suppress' | 'reject'). It was only ever inside `reason_json`
--                  as free text, which made it unqueryable — and the topic
--                  rate-limit query needs it. A suppressed or deferred decision
--                  was never spoken, so it must not rate-limit the next attempt
--                  at the same topic; only an emitted one may.
--
--   evaluated_at   When the current verdict was reached, as opposed to
--                  `created_at`, which stays the moment the candidate was first
--                  proposed. A candidate deferred through the night and emitted
--                  at 07:00 was *said* at 07:00, and that is the timestamp the
--                  hour-long topic rate limit has to measure from — otherwise a
--                  long deferral would arrive already outside its own window.
--
--   deferred_until When re-evaluation becomes due. NULL means this row is not
--                  waiting for anything: either it was never deferred, or its
--                  deferral has already been claimed. Clearing it *is* the
--                  claim, so two concurrent sweeps cannot both re-emit one
--                  candidate.
--
--   defer_count    How many times this candidate has been deferred. A candidate
--                  whose interruption cost never falls would otherwise defer
--                  forever, which is "never" again with extra steps. Past the
--                  configured limit the engine suppresses it and says so.
--
--   candidate_json The candidate as proposed. Re-evaluation has to run the full
--                  decision tree again — permissions may have been revoked
--                  while it waited — and the tree needs inputs this table never
--                  stored (contextCompatibility, callerKind, topic).
--
-- All nullable/defaulted: rows written before this migration keep their meaning,
-- and `action IS NULL` reads as "unknown verdict", which the rate-limit query
-- treats as not-emitted rather than guessing.

ALTER TABLE proactive_decision ADD COLUMN action TEXT;
ALTER TABLE proactive_decision ADD COLUMN evaluated_at TEXT;
ALTER TABLE proactive_decision ADD COLUMN deferred_until TEXT;
ALTER TABLE proactive_decision ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proactive_decision ADD COLUMN candidate_json TEXT;

-- The sweep asks exactly one question: which deferrals are due? Partial index so
-- it never walks the resolved rows, which are the overwhelming majority.
CREATE INDEX IF NOT EXISTS idx_proactive_decision_deferred
  ON proactive_decision(deferred_until)
  WHERE deferred_until IS NOT NULL;
