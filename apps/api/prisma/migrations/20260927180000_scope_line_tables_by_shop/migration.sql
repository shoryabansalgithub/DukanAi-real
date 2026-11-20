-- Roadmap 1.6: the procurement line tables carry their owning shop, so
-- line-level lookups (three-way matching, return validation) and the
-- BatchStock unique key are tenant-scoped. Each column is added nullable,
-- backfilled from the parent document, then made NOT NULL. Plain SQL that
-- runs identically on MySQL 8 and MariaDB.

-- PurchaseOrderItem <- PurchaseOrder
ALTER TABLE `PurchaseOrderItem` ADD COLUMN `shopId` VARCHAR(191) NULL;
UPDATE `PurchaseOrderItem` `l` JOIN `PurchaseOrder` `p` ON `p`.`id` = `l`.`purchaseOrderId` SET `l`.`shopId` = `p`.`shopId`;
ALTER TABLE `PurchaseOrderItem` MODIFY `shopId` VARCHAR(191) NOT NULL;
CREATE INDEX `PurchaseOrderItem_shopId_idx` ON `PurchaseOrderItem`(`shopId`);

-- GoodsReceiptLine <- GoodsReceipt
ALTER TABLE `GoodsReceiptLine` ADD COLUMN `shopId` VARCHAR(191) NULL;
UPDATE `GoodsReceiptLine` `l` JOIN `GoodsReceipt` `p` ON `p`.`id` = `l`.`goodsReceiptId` SET `l`.`shopId` = `p`.`shopId`;
ALTER TABLE `GoodsReceiptLine` MODIFY `shopId` VARCHAR(191) NOT NULL;
CREATE INDEX `GoodsReceiptLine_shopId_idx` ON `GoodsReceiptLine`(`shopId`);

-- VendorBillLine <- VendorBill
ALTER TABLE `VendorBillLine` ADD COLUMN `shopId` VARCHAR(191) NULL;
UPDATE `VendorBillLine` `l` JOIN `VendorBill` `p` ON `p`.`id` = `l`.`vendorBillId` SET `l`.`shopId` = `p`.`shopId`;
ALTER TABLE `VendorBillLine` MODIFY `shopId` VARCHAR(191) NOT NULL;
CREATE INDEX `VendorBillLine_shopId_idx` ON `VendorBillLine`(`shopId`);

-- PurchaseReturnLine <- PurchaseReturn
ALTER TABLE `PurchaseReturnLine` ADD COLUMN `shopId` VARCHAR(191) NULL;
UPDATE `PurchaseReturnLine` `l` JOIN `PurchaseReturn` `p` ON `p`.`id` = `l`.`purchaseReturnId` SET `l`.`shopId` = `p`.`shopId`;
ALTER TABLE `PurchaseReturnLine` MODIFY `shopId` VARCHAR(191) NOT NULL;
CREATE INDEX `PurchaseReturnLine_shopId_idx` ON `PurchaseReturnLine`(`shopId`);

-- SupplierCreditLine <- SupplierCreditNote
ALTER TABLE `SupplierCreditLine` ADD COLUMN `shopId` VARCHAR(191) NULL;
UPDATE `SupplierCreditLine` `l` JOIN `SupplierCreditNote` `p` ON `p`.`id` = `l`.`supplierCreditId` SET `l`.`shopId` = `p`.`shopId`;
ALTER TABLE `SupplierCreditLine` MODIFY `shopId` VARCHAR(191) NOT NULL;
CREATE INDEX `SupplierCreditLine_shopId_idx` ON `SupplierCreditLine`(`shopId`);

-- BatchStock: the unique key is per shop. The batchId foreign key needs an index
-- whose first column is batchId, so a plain index is created before the old
-- unique key (which used to serve that role) is dropped.
CREATE INDEX `BatchStock_batchId_idx` ON `BatchStock`(`batchId`);
DROP INDEX `BatchStock_batchId_inventoryItemId_key` ON `BatchStock`;
CREATE UNIQUE INDEX `BatchStock_shopId_batchId_inventoryItemId_key` ON `BatchStock`(`shopId`, `batchId`, `inventoryItemId`);
