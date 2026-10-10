-- Roadmap 4.7: one claim semantic for every outbox relay. A relay claims rows
-- (status CLAIMED, claimedAt) in a READ COMMITTED transaction, commits, and
-- enqueues afterwards; the worker sets DONE / FAILED; a reaper returns stale
-- claims to PENDING with an exponential backoff recorded in nextAttemptAt.
ALTER TABLE `OutboxEvent` ADD COLUMN `claimedAt` DATETIME(3) NULL;
ALTER TABLE `OutboxEvent` ADD COLUMN `nextAttemptAt` DATETIME(3) NULL;
