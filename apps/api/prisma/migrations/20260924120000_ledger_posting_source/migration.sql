-- Ledger posting headers: every balanced posting gets one LedgerPosting row
-- keyed by its business source. The unique (shopId, sourceType, sourceId)
-- index makes posting idempotent at the database level (a second posting of
-- the same GRN, return, adjustment, sale or repayment is rejected), and
-- LedgerTransaction.postingId links each entry to its header.
-- Rows written before this migration keep postingId = NULL.

-- AlterTable
ALTER TABLE `LedgerTransaction` ADD COLUMN `postingId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `LedgerPosting` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(40) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LedgerPosting_shopId_sourceType_sourceId_key`(`shopId`, `sourceType`, `sourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `LedgerTransaction_postingId_idx` ON `LedgerTransaction`(`postingId`);

-- AddForeignKey
ALTER TABLE `LedgerTransaction` ADD CONSTRAINT `LedgerTransaction_postingId_fkey` FOREIGN KEY (`postingId`) REFERENCES `LedgerPosting`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

