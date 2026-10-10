-- Roadmap 9.20: data onboarding for real shops.
--
-- One import pipeline carries the three files a shop brings on day one:
-- products, opening stock and customers with their opening udhar. ImportJob
-- says which (`kind`), whether the run only validates and plans (`dryRun`:
-- the per-row report is written, nothing else; `ImportJobRow.changes` says
-- what each row would change), who started it
-- (`createdById`: the worker acts as that user, so products carry their
-- creator and udhar rows their recorder), and how many rows were already in
-- the shop exactly as the file says (`unchangedCount`: a re-run of the same
-- file is all unchanged).
--
-- OPENING_BALANCE_EQUITY is the contra of every opening balance: opening
-- stock (DR INVENTORY) and opening udhar (DR ACCOUNTS_RECEIVABLE) post
-- against it, so a shop's day-one books balance without passing the
-- balances through revenue or the stock-adjustment expense account.
-- Appending a value to the end of an ENUM is a metadata change on MySQL 8
-- and MariaDB; the ledger immutability triggers do not fire on ALTER TABLE.
-- No database clock is used (roadmap 8.2).

-- AlterTable
ALTER TABLE `LedgerAccountBalance` MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT', 'OPENING_BALANCE_EQUITY') NOT NULL;

-- AlterTable
ALTER TABLE `LedgerTransaction` MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT', 'OPENING_BALANCE_EQUITY') NOT NULL;

-- AlterTable
ALTER TABLE `ImportJob` ADD COLUMN `createdById` VARCHAR(191) NULL,
    ADD COLUMN `dryRun` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `kind` ENUM('PRODUCTS', 'CUSTOMERS', 'OPENING_STOCK') NOT NULL DEFAULT 'PRODUCTS',
    ADD COLUMN `unchangedCount` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ImportJobRow` ADD COLUMN `changes` JSON NULL;

-- CreateIndex
CREATE INDEX `ImportJob_shopId_createdAt_idx` ON `ImportJob`(`shopId`, `createdAt`);

-- CreateIndex
CREATE INDEX `ImportJob_createdById_idx` ON `ImportJob`(`createdById`);

-- AddForeignKey
ALTER TABLE `ImportJob` ADD CONSTRAINT `ImportJob_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
