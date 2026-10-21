-- EXEC-006C: POS workflow & billing integrity
-- Adds tender-level payments, locked ledger balances, partial-return tracking,
-- invoice cancellation metadata, idempotent customer repayments and shift notes.
-- Safe to run on a database created from the baseline migration or via `prisma db push`.

-- Ledger accounts: BANK (card/UPI/bank settlements) and GST_PAYABLE (tax liability)
ALTER TABLE `LedgerTransaction`
  MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE') NOT NULL;

-- Invoice: cancellation metadata, idempotency payload hash, reporting index.
ALTER TABLE `Invoice`
  ADD COLUMN `cancelledAt` DATETIME(3) NULL,
  ADD COLUMN `cancelledById` VARCHAR(191) NULL,
  ADD COLUMN `requestHash` VARCHAR(191) NULL;

CREATE INDEX `Invoice_shopId_type_status_createdAt_idx` ON `Invoice`(`shopId`, `type`, `status`, `createdAt`);

-- Partial returns need more than one return invoice per original: drop the
-- unique index on originalId when it exists (databases built with `db push`
-- have it; the baseline migration only has the non-unique index).
SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Invoice' AND INDEX_NAME = 'Invoice_originalId_key'
);
SET @sql := IF(@idx_exists > 0, 'ALTER TABLE `Invoice` DROP INDEX `Invoice_originalId_key`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- InvoiceItem: persisted line math and returned quantity tracking.
ALTER TABLE `InvoiceItem`
  ADD COLUMN `discountAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `taxableAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `cessAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `returnedQuantity` DECIMAL(10, 3) NOT NULL DEFAULT 0;

-- Tender-level payments per invoice.
CREATE TABLE `InvoicePayment` (
  `id` VARCHAR(191) NOT NULL,
  `shopId` VARCHAR(191) NOT NULL,
  `invoiceId` VARCHAR(191) NOT NULL,
  `tender` ENUM('CASH', 'UPI', 'CARD', 'BANK_TRANSFER') NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `tenderedAmount` DECIMAL(10, 2) NULL,
  `changeAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `reference` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `InvoicePayment_invoiceId_idx`(`invoiceId`),
  INDEX `InvoicePayment_shopId_tender_createdAt_idx`(`shopId`, `tender`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `InvoicePayment` ADD CONSTRAINT `InvoicePayment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `InvoicePayment` ADD CONSTRAINT `InvoicePayment_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Running balance per ledger account (row-locked during posting).
CREATE TABLE `LedgerAccountBalance` (
  `id` VARCHAR(191) NOT NULL,
  `shopId` VARCHAR(191) NOT NULL,
  `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE') NOT NULL,
  `balance` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `LedgerAccountBalance_shopId_account_key`(`shopId`, `account`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LedgerAccountBalance` ADD CONSTRAINT `LedgerAccountBalance_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Customer repayments: tender, reference and idempotency.
ALTER TABLE `UdharTransaction`
  ADD COLUMN `tender` ENUM('CASH', 'UPI', 'CARD', 'BANK_TRANSFER') NULL,
  ADD COLUMN `reference` VARCHAR(191) NULL,
  ADD COLUMN `idempotencyKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `UdharTransaction_shopId_idempotencyKey_key` ON `UdharTransaction`(`shopId`, `idempotencyKey`);

-- Shift close notes.
ALTER TABLE `Shift` ADD COLUMN `notes` VARCHAR(191) NULL;
