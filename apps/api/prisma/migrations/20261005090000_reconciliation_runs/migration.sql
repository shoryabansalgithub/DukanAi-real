-- Roadmap 9.5: financial reconciliation to the paisa.
--
-- ReconciliationRun keeps one row per reconciliation of a shop's business day
-- (nightly cron, POST /reconciliation/run or `npm run reconcile`): the checks
-- with their figures and every drift found, so GET /reconciliation/latest and
-- the run history read from the table and never recompute.
--
-- Two facts the shift check needs were never persisted: which drawer refunded
-- a cancellation (the sale's own shift while it is open, else the actor's)
-- and which drawer took a customer repayment. Both become nullable columns on
-- the documents themselves (Invoice.cancelledShiftId, UdharTransaction.shiftId),
-- written by the cancellation and repayment transactions from now on; rows
-- recorded before this migration keep NULL and the reconciliation reports
-- the shifts they touched as inconclusive instead of as drift.
-- No database clock is used (roadmap 8.2); nothing here needs a timestamp.

-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `cancelledShiftId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `UdharTransaction` ADD COLUMN `shiftId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `ReconciliationRun` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `businessDate` VARCHAR(10) NOT NULL,
    `timeZone` VARCHAR(64) NOT NULL,
    `trigger` ENUM('CRON', 'MANUAL', 'CLI') NOT NULL,
    `status` ENUM('CLEAN', 'DRIFT', 'FAILED') NOT NULL,
    `driftCount` INTEGER NOT NULL DEFAULT 0,
    `checks` JSON NOT NULL,
    `summary` JSON NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReconciliationRun_shopId_businessDate_startedAt_idx`(`shopId`, `businessDate`, `startedAt`),
    INDEX `ReconciliationRun_shopId_startedAt_idx`(`shopId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Invoice_cancelledShiftId_idx` ON `Invoice`(`cancelledShiftId`);

-- CreateIndex
CREATE INDEX `UdharTransaction_shiftId_idx` ON `UdharTransaction`(`shiftId`);

-- AddForeignKey
ALTER TABLE `Invoice` ADD CONSTRAINT `Invoice_cancelledShiftId_fkey` FOREIGN KEY (`cancelledShiftId`) REFERENCES `Shift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UdharTransaction` ADD CONSTRAINT `UdharTransaction_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `Shift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReconciliationRun` ADD CONSTRAINT `ReconciliationRun_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
