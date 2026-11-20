-- Expense receipts (release audit, 2026-10-12): the "Attach Receipt" field of
-- the expense form stores a photo or PDF under the shop's storage root
-- (`Expenses/<id>/...`); the row keeps its shop-relative path and type.
-- Additive: an older image ignores both columns.
ALTER TABLE `Expense` ADD COLUMN `receiptMimeType` VARCHAR(64) NULL,
    ADD COLUMN `receiptPath` VARCHAR(191) NULL;
