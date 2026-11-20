-- Release audit (2026-10-11): the retention sweep deletes WebhookDelivery rows
-- older than RETENTION_WEBHOOK_DELIVERY_DAYS in DELETE ... LIMIT batches by
-- createdAt alone; without this index every batch scans the table.
-- CreateIndex
CREATE INDEX `WebhookDelivery_createdAt_idx` ON `WebhookDelivery`(`createdAt`);
