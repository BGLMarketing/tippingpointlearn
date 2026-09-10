-- ============================================================
-- Backfill: move legacy 'under_review' applications into the new
-- granular pipeline
-- ============================================================
-- Every application still sitting at the old single 'under_review'
-- status predates the two-stage (now three-stage) review pipeline.
-- There's no way to know from the data alone whether a given one was
-- actually at the client-service or compliance stage of review, so
-- this moves all of them to the FIRST stage — under_review_client_service
-- — which is the safe default: worst case, an application that was
-- actually further along just needs one extra "Approve" click to
-- catch back up, rather than a status claiming compliance already
-- reviewed something it may not have.
--
-- 'submitted', 'opened', and 'rejected' are untouched — they map
-- cleanly onto the new pipeline already (start and both terminal
-- states are unchanged concepts).
--
-- Safe to re-run — the WHERE clause means it only ever touches rows
-- still at the old status; once moved, running this again is a no-op.

update account_opening_applications
set status = 'under_review_client_service'
where status = 'under_review';

-- Optional but recommended: log this bulk move in the audit trail,
-- same as every other status change, so it's visible in each
-- application's status history rather than appearing to have
-- happened with no record.
insert into application_status_history (application_id, status, changed_by, reason)
select id, 'under_review_client_service', 'system (backfill)', 'Migrated from legacy under_review status'
from account_opening_applications
where status = 'under_review_client_service'
  and id not in (
    select application_id from application_status_history
    where status = 'under_review_client_service'
  );
