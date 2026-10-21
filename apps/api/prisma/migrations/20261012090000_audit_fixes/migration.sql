-- Release-readiness audit fixes (2026-10-12).
--
-- * LedgerAccount gains INPUT_GST (GST paid on purchases, debited when a vendor
--   bill is posted) and EXPENSES (shop running costs). Appending to an ENUM is an
--   in-place change on MySQL 8 and MariaDB. No release with the old client has
--   reached production (the rc tags were never deployed), so the enum values ship
--   with their writers (prisma/MIGRATIONS.md, "Rolling back a release").
-- * Expense.shiftId / SupplierPayment.shiftId link a cash payout to the open
--   shift whose drawer paid it; Shift.cashPayouts carries the total so the
--   expected cash and the reconciliation's shift check agree.
-- * StockCountItem.countedAt: movements between the snapshot and the count
--   belong to the expected quantity.
-- * Indexes the nightly reconciliation and the retention sweep read.
-- AlterTable
ALTER TABLE `Expense` ADD COLUMN `shiftId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `LedgerAccountBalance` MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT', 'OPENING_BALANCE_EQUITY', 'INPUT_GST', 'EXPENSES') NOT NULL;

-- AlterTable
ALTER TABLE `LedgerTransaction` MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT', 'OPENING_BALANCE_EQUITY', 'INPUT_GST', 'EXPENSES') NOT NULL;

-- AlterTable
ALTER TABLE `Shift` ADD COLUMN `cashPayouts` DECIMAL(10, 2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `StockCountItem` ADD COLUMN `countedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `SupplierPayment` ADD COLUMN `shiftId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Expense_shiftId_idx` ON `Expense`(`shiftId`);

-- CreateIndex
CREATE INDEX `LedgerPosting_shopId_createdAt_idx` ON `LedgerPosting`(`shopId`, `createdAt`);

-- CreateIndex
CREATE INDEX `LedgerTransaction_shopId_account_createdAt_idx` ON `LedgerTransaction`(`shopId`, `account`, `createdAt`);

-- CreateIndex
CREATE INDEX `PasswordResetToken_expiresAt_idx` ON `PasswordResetToken`(`expiresAt`);

-- CreateIndex
CREATE INDEX `SupplierPayment_shiftId_idx` ON `SupplierPayment`(`shiftId`);

-- AddForeignKey
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `Shift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Expense` ADD CONSTRAINT `Expense_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `Shift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

