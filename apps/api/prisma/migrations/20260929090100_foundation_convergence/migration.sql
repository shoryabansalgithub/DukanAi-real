-- Roadmap 3.12 (audit P2-33): convergence for the exec006c and foundation
-- migrations. `20260919090000_pos_correctness_foundation` was rewritten after
-- it had been applied (its duplicate merge did not run on MySQL 8), so a
-- database may hold the original version's checksum, may have applied it in
-- part (DDL is auto-committed, the failed merge left the rest undone), or may
-- have been built with `prisma db push`. Every statement below is guarded
-- with information_schema, so this migration brings any of those databases to
-- the structure the two migrations define and is a no-op on a database that
-- already has it. Runbook: prisma/MIGRATIONS.md.

-- ------------------------------------------------ exec006c_pos_integrity
ALTER TABLE `LedgerTransaction` MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT') NOT NULL;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Invoice' AND COLUMN_NAME = 'cancelledAt');
SET @sql := IF(@n = 0, 'ALTER TABLE `Invoice` ADD COLUMN `cancelledAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Invoice' AND COLUMN_NAME = 'cancelledById');
SET @sql := IF(@n = 0, 'ALTER TABLE `Invoice` ADD COLUMN `cancelledById` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Invoice' AND COLUMN_NAME = 'requestHash');
SET @sql := IF(@n = 0, 'ALTER TABLE `Invoice` ADD COLUMN `requestHash` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Invoice' AND INDEX_NAME = 'Invoice_shopId_type_status_createdAt_idx');
SET @sql := IF(@n = 0, 'CREATE INDEX `Invoice_shopId_type_status_createdAt_idx` ON `Invoice`(`shopId`, `type`, `status`, `createdAt`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) - 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Invoice' AND INDEX_NAME = 'Invoice_originalId_key');
SET @sql := IF(@n = 0, 'ALTER TABLE `Invoice` DROP INDEX `Invoice_originalId_key`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND COLUMN_NAME = 'discountAmount');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` ADD COLUMN `discountAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND COLUMN_NAME = 'taxableAmount');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` ADD COLUMN `taxableAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND COLUMN_NAME = 'cessAmount');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` ADD COLUMN `cessAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND COLUMN_NAME = 'returnedQuantity');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` ADD COLUMN `returnedQuantity` DECIMAL(10, 3) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
CREATE TABLE IF NOT EXISTS `InvoicePayment` (
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
SET @n := (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoicePayment' AND CONSTRAINT_NAME = 'InvoicePayment_shopId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoicePayment` ADD CONSTRAINT `InvoicePayment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoicePayment' AND CONSTRAINT_NAME = 'InvoicePayment_invoiceId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoicePayment` ADD CONSTRAINT `InvoicePayment_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
CREATE TABLE IF NOT EXISTS `LedgerAccountBalance` (
  `id` VARCHAR(191) NOT NULL,
  `shopId` VARCHAR(191) NOT NULL,
  `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT') NOT NULL,
  `balance` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `LedgerAccountBalance_shopId_account_key`(`shopId`, `account`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `LedgerAccountBalance` MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT') NOT NULL;
SET @n := (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'LedgerAccountBalance' AND CONSTRAINT_NAME = 'LedgerAccountBalance_shopId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@n = 0, 'ALTER TABLE `LedgerAccountBalance` ADD CONSTRAINT `LedgerAccountBalance_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UdharTransaction' AND COLUMN_NAME = 'tender');
SET @sql := IF(@n = 0, 'ALTER TABLE `UdharTransaction` ADD COLUMN `tender` ENUM(''CASH'', ''UPI'', ''CARD'', ''BANK_TRANSFER'') NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UdharTransaction' AND COLUMN_NAME = 'reference');
SET @sql := IF(@n = 0, 'ALTER TABLE `UdharTransaction` ADD COLUMN `reference` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UdharTransaction' AND COLUMN_NAME = 'idempotencyKey');
SET @sql := IF(@n = 0, 'ALTER TABLE `UdharTransaction` ADD COLUMN `idempotencyKey` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UdharTransaction' AND INDEX_NAME = 'UdharTransaction_shopId_idempotencyKey_key');
SET @sql := IF(@n = 0, 'CREATE UNIQUE INDEX `UdharTransaction_shopId_idempotencyKey_key` ON `UdharTransaction`(`shopId`, `idempotencyKey`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Shift' AND COLUMN_NAME = 'notes');
SET @sql := IF(@n = 0, 'ALTER TABLE `Shift` ADD COLUMN `notes` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ------------------------------------------------ pos_correctness_foundation
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InventoryItem' AND COLUMN_NAME = 'variantKey');
SET @sql := IF(@n = 0, 'ALTER TABLE `InventoryItem` ADD COLUMN `variantKey` VARCHAR(191) NOT NULL DEFAULT ''-''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
UPDATE `InventoryItem` SET `variantKey` = COALESCE(`variantId`, '-') WHERE `variantKey` <> COALESCE(`variantId`, '-');
-- Duplicate (shop, product, variant, location) rows are merged into the oldest
-- live row; a no-op when the unique key below already exists. The temporary
-- table is referenced once per statement (MySQL 8 ERROR 1137).
CREATE TEMPORARY TABLE `__ii_dups` AS
  SELECT ranked.`id` AS dupId, ranked.survivorId
  FROM (
    SELECT `id`, ROW_NUMBER() OVER w AS rn, FIRST_VALUE(`id`) OVER w AS survivorId
    FROM `InventoryItem`
    WINDOW w AS (PARTITION BY `shopId`, `productId`, `variantKey`, `locationId` ORDER BY `isDeleted` ASC, `createdAt` ASC, `id` ASC)
  ) ranked
  WHERE ranked.rn > 1;
UPDATE `InventoryItem` s
  JOIN (SELECT x.survivorId,
               SUM(i.`onHand`) AS onHand, SUM(i.`reserved`) AS reserved, SUM(i.`allocated`) AS allocated,
               SUM(i.`damaged`) AS damaged, SUM(i.`lost`) AS lost, SUM(i.`inTransit`) AS inTransit
        FROM `__ii_dups` x JOIN `InventoryItem` i ON i.`id` = x.dupId
        GROUP BY x.survivorId) m
    ON m.survivorId = s.`id`
  SET s.`onHand` = s.`onHand` + m.onHand, s.`reserved` = s.`reserved` + m.reserved, s.`allocated` = s.`allocated` + m.allocated,
      s.`damaged` = s.`damaged` + m.damaged, s.`lost` = s.`lost` + m.lost, s.`inTransit` = s.`inTransit` + m.inTransit,
      s.`isDeleted` = false, s.`deletedAt` = NULL, s.`version` = s.`version` + 1;
UPDATE `AdjustmentRequest` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `BatchStock` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryAdjustment` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryAlert` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryMovement` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventorySnapshot` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryThreshold` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `ReservationAllocation` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `StockCountItem` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `StockLedgerEntry` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `StockSnapshot` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
DELETE i FROM `InventoryItem` i JOIN `__ii_dups` x ON i.`id` = x.dupId;
DROP TEMPORARY TABLE `__ii_dups`;
SET @n := (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InventoryItem' AND INDEX_NAME = 'InventoryItem_shopId_productId_variantKey_locationId_key');
SET @sql := IF(@n = 0, 'CREATE UNIQUE INDEX `InventoryItem_shopId_productId_variantKey_locationId_key` ON `InventoryItem`(`shopId`, `productId`, `variantKey`, `locationId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) - 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InventoryItem' AND INDEX_NAME = 'InventoryItem_shopId_productId_variantId_locationId_key');
SET @sql := IF(@n = 0, 'ALTER TABLE `InventoryItem` DROP INDEX `InventoryItem_shopId_productId_variantId_locationId_key`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InventoryItem' AND COLUMN_NAME = 'locationId' AND IS_NULLABLE = 'NO');
SET @sql := IF(@n = 0, 'ALTER TABLE `InventoryItem` MODIFY `locationId` VARCHAR(191) NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- productId becomes nullable (custom lines); the foreign key is dropped for the
-- change and re-added below, only on a database that still has it NOT NULL.
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND COLUMN_NAME = 'productId' AND IS_NULLABLE = 'YES');
SET @fk := (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND CONSTRAINT_NAME = 'InvoiceItem_productId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@n = 0 AND @fk = 1, 'ALTER TABLE `InvoiceItem` DROP FOREIGN KEY `InvoiceItem_productId_fkey`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` MODIFY `productId` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND COLUMN_NAME = 'isCustom');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` ADD COLUMN `isCustom` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @n := (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'InvoiceItem' AND CONSTRAINT_NAME = 'InvoiceItem_productId_fkey' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql := IF(@n = 0, 'ALTER TABLE `InvoiceItem` ADD CONSTRAINT `InvoiceItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
