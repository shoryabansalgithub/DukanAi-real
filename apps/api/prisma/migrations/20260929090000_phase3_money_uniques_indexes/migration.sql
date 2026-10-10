-- Roadmap phase 3 (3.2, 3.3, 3.10, 3.13). Plain SQL that runs identically on
-- MySQL 8 and MariaDB 10.4+. Every step is safe on a populated database.
--
-- 3.10  Soft-delete unique keys used to include the nullable `deletedAt`
--       (ProductVariant: the boolean `isDeleted`). MySQL treats NULLs as
--       distinct in a unique index, so those keys never blocked a duplicate
--       live row. Each table gets a NOT NULL `deletedToken`: '' while the row
--       is live, the row's own id once soft-deleted (set by the Prisma
--       soft-delete extension). The new keys are created BEFORE the old ones
--       are dropped, so the shopId foreign keys keep a supporting index and no
--       constraint has to be dropped. Live rows that already violate a key are
--       exempted by giving every duplicate but the oldest its own id as token;
--       they stay live and are listed by `SELECT ... WHERE deletedToken <> ''
--       AND isDeleted = 0` for the operator to merge.
-- 3.2   LedgerTransaction.amount -> DECIMAL(14,2), balanceAfter -> (18,2);
--       Customer.totalPurchases / totalPaid -> (14,2).
-- 3.3   InvoiceItem.returnedQuantity is recomputed from the completed
--       SALES_RETURN lines of each sale (returns made before migration
--       exec006c were never counted).
-- 3.11  Supplier.openingPayables keeps the pre-ledger balance and
--       SupplierPayment records every payment (the ledger source of its
--       DR ACCOUNTS_PAYABLE posting), so pendingPayables can be rebuilt from
--       the ledger.
-- 3.13  Indexes for the hot lookups the audit listed.

-- ---------------------------------------------------------------- 3.10 token columns
ALTER TABLE `Category` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `Product` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `Supplier` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `Customer` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `CustomerGroup` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `CustomerCategory` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `PurchaseOrder` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `GoodsReceipt` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `VendorBill` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `PurchaseReturn` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `SupplierCreditNote` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `Warehouse` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `Location` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE `ProductVariant` ADD COLUMN `deletedToken` VARCHAR(191) NOT NULL DEFAULT '';

-- Soft-deleted rows take their id as token.
UPDATE `Category` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `Product` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `Supplier` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `Customer` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `CustomerGroup` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `CustomerCategory` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `PurchaseOrder` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `GoodsReceipt` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `VendorBill` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `PurchaseReturn` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `SupplierCreditNote` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `Warehouse` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `Location` SET `deletedToken` = `id` WHERE `isDeleted` = 1 OR `deletedAt` IS NOT NULL;
UPDATE `ProductVariant` SET `deletedToken` = `id` WHERE `isDeleted` = 1;

-- Live duplicates: every row but the oldest of a key is exempted (token = id).
UPDATE `Category` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `name` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Category` WHERE `deletedToken` = '' AND `name` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `Product` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `sku` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Product` WHERE `deletedToken` = '' AND `sku` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `Supplier` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `phone` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Supplier` WHERE `deletedToken` = '' AND `phone` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `Customer` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `phone` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Customer` WHERE `deletedToken` = '' AND `phone` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `CustomerGroup` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `name` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `CustomerGroup` WHERE `deletedToken` = '' AND `name` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `CustomerCategory` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `name` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `CustomerCategory` WHERE `deletedToken` = '' AND `name` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `PurchaseOrder` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `orderNumber` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `PurchaseOrder` WHERE `deletedToken` = '' AND `orderNumber` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `GoodsReceipt` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `grnNumber` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `GoodsReceipt` WHERE `deletedToken` = '' AND `grnNumber` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `VendorBill` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `billNumber` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `VendorBill` WHERE `deletedToken` = '' AND `billNumber` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `PurchaseReturn` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `returnNumber` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `PurchaseReturn` WHERE `deletedToken` = '' AND `returnNumber` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `SupplierCreditNote` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `creditNumber` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `SupplierCreditNote` WHERE `deletedToken` = '' AND `creditNumber` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `Warehouse` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `code` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Warehouse` WHERE `deletedToken` = '' AND `code` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `Location` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `warehouseId`, `code` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Location` WHERE `deletedToken` = '' AND `warehouseId` IS NOT NULL AND `code` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `ProductVariant` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `sku` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `ProductVariant` WHERE `deletedToken` = '' AND `sku` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `Product` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `barcode` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `Product` WHERE `deletedToken` = '' AND `barcode` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;
UPDATE `ProductVariant` `t` JOIN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `shopId`, `barcode` ORDER BY `createdAt`, `id`) AS `rn`
    FROM `ProductVariant` WHERE `deletedToken` = '' AND `barcode` IS NOT NULL
  ) `ranked` WHERE `rn` > 1
) `dup` ON `dup`.`id` = `t`.`id`
SET `t`.`deletedToken` = `t`.`id`;

-- ---------------------------------------------------------------- 3.2 money columns
ALTER TABLE `LedgerTransaction` MODIFY `amount` DECIMAL(14, 2) NOT NULL, MODIFY `balanceAfter` DECIMAL(18, 2) NOT NULL;
ALTER TABLE `Customer` MODIFY `totalPurchases` DECIMAL(14, 2) NOT NULL DEFAULT 0, MODIFY `totalPaid` DECIMAL(14, 2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- 3.3 returnedQuantity backfill
-- A return line carries no link to the sale line; within one sale a product
-- appears on one line only (the engine rejects duplicates), so catalogue lines
-- match on productId. Custom lines match on name and price. The result is
-- capped at the sold quantity, so at worst a line becomes non-returnable,
-- never returnable twice.
UPDATE `InvoiceItem` `s`
JOIN `Invoice` `sale` ON `sale`.`id` = `s`.`invoiceId` AND `sale`.`type` = 'SALE'
JOIN (
  SELECT `r`.`originalId` AS `saleId`, `ri`.`productId` AS `productId`, SUM(`ri`.`quantity`) AS `returned`
  FROM `Invoice` `r` JOIN `InvoiceItem` `ri` ON `ri`.`invoiceId` = `r`.`id`
  WHERE `r`.`type` = 'SALES_RETURN' AND `r`.`status` = 'COMPLETED' AND `r`.`isDeleted` = 0
    AND `r`.`originalId` IS NOT NULL AND `ri`.`productId` IS NOT NULL
  GROUP BY `r`.`originalId`, `ri`.`productId`
) `agg` ON `agg`.`saleId` = `sale`.`id` AND `agg`.`productId` = `s`.`productId`
SET `s`.`returnedQuantity` = LEAST(`s`.`quantity`, `agg`.`returned`);

UPDATE `InvoiceItem` `s`
JOIN `Invoice` `sale` ON `sale`.`id` = `s`.`invoiceId` AND `sale`.`type` = 'SALE'
JOIN (
  SELECT `r`.`originalId` AS `saleId`, `ri`.`productName` AS `productName`, `ri`.`sellingPrice` AS `sellingPrice`, SUM(`ri`.`quantity`) AS `returned`
  FROM `Invoice` `r` JOIN `InvoiceItem` `ri` ON `ri`.`invoiceId` = `r`.`id`
  WHERE `r`.`type` = 'SALES_RETURN' AND `r`.`status` = 'COMPLETED' AND `r`.`isDeleted` = 0
    AND `r`.`originalId` IS NOT NULL AND `ri`.`productId` IS NULL
  GROUP BY `r`.`originalId`, `ri`.`productName`, `ri`.`sellingPrice`
) `agg` ON `agg`.`saleId` = `sale`.`id` AND `s`.`productId` IS NULL
  AND `agg`.`productName` = `s`.`productName` AND `agg`.`sellingPrice` = `s`.`sellingPrice`
SET `s`.`returnedQuantity` = LEAST(`s`.`quantity`, `agg`.`returned`);

-- ---------------------------------------------------------------- 3.10 enforceable unique keys
CREATE UNIQUE INDEX `Category_shopId_name_deletedToken_key` ON `Category`(`shopId`, `name`, `deletedToken`);
CREATE UNIQUE INDEX `Product_shopId_sku_deletedToken_key` ON `Product`(`shopId`, `sku`, `deletedToken`);
CREATE UNIQUE INDEX `Supplier_shopId_phone_deletedToken_key` ON `Supplier`(`shopId`, `phone`, `deletedToken`);
CREATE UNIQUE INDEX `Customer_shopId_phone_deletedToken_key` ON `Customer`(`shopId`, `phone`, `deletedToken`);
CREATE UNIQUE INDEX `CustomerGroup_shopId_name_deletedToken_key` ON `CustomerGroup`(`shopId`, `name`, `deletedToken`);
CREATE UNIQUE INDEX `CustomerCategory_shopId_name_deletedToken_key` ON `CustomerCategory`(`shopId`, `name`, `deletedToken`);
CREATE UNIQUE INDEX `PurchaseOrder_shopId_orderNumber_deletedToken_key` ON `PurchaseOrder`(`shopId`, `orderNumber`, `deletedToken`);
CREATE UNIQUE INDEX `GoodsReceipt_shopId_grnNumber_deletedToken_key` ON `GoodsReceipt`(`shopId`, `grnNumber`, `deletedToken`);
CREATE UNIQUE INDEX `VendorBill_shopId_billNumber_deletedToken_key` ON `VendorBill`(`shopId`, `billNumber`, `deletedToken`);
CREATE UNIQUE INDEX `PurchaseReturn_shopId_returnNumber_deletedToken_key` ON `PurchaseReturn`(`shopId`, `returnNumber`, `deletedToken`);
CREATE UNIQUE INDEX `SupplierCreditNote_shopId_creditNumber_deletedToken_key` ON `SupplierCreditNote`(`shopId`, `creditNumber`, `deletedToken`);
CREATE UNIQUE INDEX `Warehouse_shopId_code_deletedToken_key` ON `Warehouse`(`shopId`, `code`, `deletedToken`);
CREATE UNIQUE INDEX `Location_shopId_warehouseId_code_deletedToken_key` ON `Location`(`shopId`, `warehouseId`, `code`, `deletedToken`);
CREATE UNIQUE INDEX `ProductVariant_shopId_sku_deletedToken_key` ON `ProductVariant`(`shopId`, `sku`, `deletedToken`);
CREATE UNIQUE INDEX `Product_shopId_barcode_deletedToken_key` ON `Product`(`shopId`, `barcode`, `deletedToken`);
CREATE UNIQUE INDEX `ProductVariant_shopId_barcode_deletedToken_key` ON `ProductVariant`(`shopId`, `barcode`, `deletedToken`);

DROP INDEX `Category_shopId_name_deletedAt_key` ON `Category`;
DROP INDEX `Product_shopId_sku_deletedAt_key` ON `Product`;
DROP INDEX `Supplier_shopId_phone_deletedAt_key` ON `Supplier`;
DROP INDEX `Customer_shopId_phone_deletedAt_key` ON `Customer`;
DROP INDEX `CustomerGroup_shopId_name_deletedAt_key` ON `CustomerGroup`;
DROP INDEX `CustomerCategory_shopId_name_deletedAt_key` ON `CustomerCategory`;
DROP INDEX `PurchaseOrder_shopId_orderNumber_deletedAt_key` ON `PurchaseOrder`;
DROP INDEX `GoodsReceipt_shopId_grnNumber_deletedAt_key` ON `GoodsReceipt`;
DROP INDEX `VendorBill_shopId_billNumber_deletedAt_key` ON `VendorBill`;
DROP INDEX `PurchaseReturn_shopId_returnNumber_deletedAt_key` ON `PurchaseReturn`;
DROP INDEX `SupplierCreditNote_shopId_creditNumber_deletedAt_key` ON `SupplierCreditNote`;
DROP INDEX `Warehouse_shopId_code_deletedAt_key` ON `Warehouse`;
DROP INDEX `Location_shopId_warehouseId_code_deletedAt_key` ON `Location`;
DROP INDEX `ProductVariant_shopId_sku_isDeleted_key` ON `ProductVariant`;

-- ---------------------------------------------------------------- 3.13 indexes
CREATE INDEX `AuditLog_shopId_entity_entityId_idx` ON `AuditLog`(`shopId`, `entity`, `entityId`);
CREATE INDEX `Product_updatedAt_idx` ON `Product`(`updatedAt`);
CREATE INDEX `ProductEventLog_shopId_timestamp_idx` ON `ProductEventLog`(`shopId`, `timestamp`);
CREATE INDEX `PurchaseReturnLine_grnLineId_idx` ON `PurchaseReturnLine`(`grnLineId`);
CREATE INDEX `SearchHistory_shopId_createdAt_idx` ON `SearchHistory`(`shopId`, `createdAt`);

-- ---------------------------------------------------------------- 3.11 payables
-- Whatever a supplier is owed today predates the ledger: it becomes the opening balance.
ALTER TABLE `Supplier` ADD COLUMN `openingPayables` DECIMAL(12, 2) NOT NULL DEFAULT 0;
UPDATE `Supplier` SET `openingPayables` = `pendingPayables`;
CREATE TABLE `SupplierPayment` (
  `id` VARCHAR(191) NOT NULL,
  `shopId` VARCHAR(191) NOT NULL,
  `supplierId` VARCHAR(191) NOT NULL,
  `vendorBillId` VARCHAR(191) NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `tender` ENUM('CASH', 'UPI', 'CARD', 'BANK_TRANSFER') NOT NULL DEFAULT 'CASH',
  `reference` VARCHAR(191) NULL,
  `idempotencyKey` VARCHAR(191) NULL,
  `notes` VARCHAR(191) NULL,
  `recordedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `SupplierPayment_shopId_idempotencyKey_key`(`shopId`, `idempotencyKey`),
  INDEX `SupplierPayment_shopId_supplierId_createdAt_idx`(`shopId`, `supplierId`, `createdAt`),
  INDEX `SupplierPayment_vendorBillId_idx`(`vendorBillId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_vendorBillId_fkey` FOREIGN KEY (`vendorBillId`) REFERENCES `VendorBill`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
