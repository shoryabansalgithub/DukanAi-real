-- Retention sweep (roadmap 7.8): the nightly purge deletes expired refresh tokens,
-- old SearchHistory rows and old ProductEventLog rows by these columns alone
-- (DONE outbox rows already have OutboxEvent(status, createdAt)); without the
-- indexes every batched DELETE ... LIMIT scans the table.
-- CreateIndex
CREATE INDEX `ProductEventLog_timestamp_idx` ON `ProductEventLog`(`timestamp`);
-- CreateIndex
CREATE INDEX `RefreshToken_expiresAt_idx` ON `RefreshToken`(`expiresAt`);
-- CreateIndex
CREATE INDEX `SearchHistory_createdAt_idx` ON `SearchHistory`(`createdAt`);
