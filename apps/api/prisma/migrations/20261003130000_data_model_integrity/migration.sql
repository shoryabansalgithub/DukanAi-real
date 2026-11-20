-- Roadmap 8.1: data model integrity.
--
-- 1. Column widths and types: stock quantities on Product, ProductVariant,
--    InventoryLog and InventoryDriftLog become DECIMAL(12,3), the width
--    InventoryItem.onHand already has; Notification.message and
--    OutboxEvent.error become TEXT. Widening never loses data.
-- 2. Currency defaults: every `currency` column defaults to INR (the app
--    bills GST in rupees and has no exchange logic); rows that only carried
--    the old 'USD' default, or NULL on PurchaseOrder, are backfilled.
-- 3. Asset tags: Prisma's implicit `_AssetTags` table (no primary key, no
--    shop column) becomes the explicit MediaAssetTag model. Its rows are
--    copied before the old table is dropped; A = MediaAsset.id, B = MediaTag.id.
-- 4. Shop foreign keys on the 65 tenant tables that had a shopId column
--    without one (ON DELETE RESTRICT, like most existing Shop relations).
--    Adding a key fails on a row whose shopId names no Shop; the app never
--    hard-deletes a Shop, so none is expected. Before deploying to a database
--    of unknown history, list them with, per table:
--      SELECT COUNT(*) FROM <table> t LEFT JOIN Shop s ON s.id = t.shopId WHERE s.id IS NULL;
--    and resolve them (prisma/MIGRATIONS.md, "A migration recorded as failed").
--    The 72 relations that relied on Prisma's default ON DELETE now say so
--    in schema.prisma; the generated constraints are unchanged.

-- AlterTable
ALTER TABLE `EnterpriseInvoice` MODIFY `currency` VARCHAR(191) NOT NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE `InventoryDriftLog` MODIFY `redisValue` DECIMAL(12, 3) NOT NULL,
    MODIFY `databaseValue` DECIMAL(12, 3) NOT NULL,
    MODIFY `difference` DECIMAL(12, 3) NOT NULL;

-- AlterTable
ALTER TABLE `InventoryLog` MODIFY `quantityBefore` DECIMAL(12, 3) NOT NULL,
    MODIFY `quantityChange` DECIMAL(12, 3) NOT NULL,
    MODIFY `quantityAfter` DECIMAL(12, 3) NOT NULL;

-- AlterTable
ALTER TABLE `Notification` MODIFY `message` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `OutboxEvent` MODIFY `error` TEXT NULL;

-- AlterTable
ALTER TABLE `PaymentTransaction` MODIFY `currency` VARCHAR(191) NOT NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE `PriceList` MODIFY `currency` VARCHAR(191) NOT NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE `Product` MODIFY `currentStock` DECIMAL(12, 3) NOT NULL DEFAULT 0,
    MODIFY `totalUnitsSold` DECIMAL(12, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ProductVariant` MODIFY `currentStock` DECIMAL(12, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `PurchaseOrder` MODIFY `currency` VARCHAR(191) NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE `SalesOrder` MODIFY `currency` VARCHAR(191) NOT NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE `SupplierCreditNote` MODIFY `currency` VARCHAR(191) NOT NULL DEFAULT 'INR';

-- AlterTable
ALTER TABLE `VendorBill` MODIFY `currency` VARCHAR(191) NOT NULL DEFAULT 'INR';

-- Backfill: rows written under the old 'USD' default (no exchange logic ever read it).
UPDATE `VendorBill` SET `currency` = 'INR' WHERE `currency` = 'USD';
UPDATE `SupplierCreditNote` SET `currency` = 'INR' WHERE `currency` = 'USD';
UPDATE `SalesOrder` SET `currency` = 'INR' WHERE `currency` = 'USD';
UPDATE `PriceList` SET `currency` = 'INR' WHERE `currency` = 'USD';
UPDATE `EnterpriseInvoice` SET `currency` = 'INR' WHERE `currency` = 'USD';
UPDATE `PaymentTransaction` SET `currency` = 'INR' WHERE `currency` = 'USD';
UPDATE `PurchaseOrder` SET `currency` = 'INR' WHERE `currency` IS NULL OR `currency` = 'USD';

-- CreateTable
CREATE TABLE `MediaAssetTag` (
    `assetId` VARCHAR(191) NOT NULL,
    `tagId` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MediaAssetTag_tagId_idx`(`tagId`),
    INDEX `MediaAssetTag_shopId_idx`(`shopId`),
    PRIMARY KEY (`assetId`, `tagId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MediaAssetTag` ADD CONSTRAINT `MediaAssetTag_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `MediaAsset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MediaAssetTag` ADD CONSTRAINT `MediaAssetTag_tagId_fkey` FOREIGN KEY (`tagId`) REFERENCES `MediaTag`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MediaAssetTag` ADD CONSTRAINT `MediaAssetTag_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carry the existing asset <-> tag links over (A = MediaAsset.id, B = MediaTag.id).
INSERT INTO `MediaAssetTag` (`assetId`, `tagId`, `shopId`, `createdAt`)
SELECT t.`A`, t.`B`, a.`shopId`, NOW(3)
FROM `_AssetTags` t
JOIN `MediaAsset` a ON a.`id` = t.`A`;

-- DropForeignKey
ALTER TABLE `_AssetTags` DROP FOREIGN KEY `_AssetTags_A_fkey`;

-- DropForeignKey
ALTER TABLE `_AssetTags` DROP FOREIGN KEY `_AssetTags_B_fkey`;

-- DropTable
DROP TABLE `_AssetTags`;

-- AddForeignKey
ALTER TABLE `CustomerGroup` ADD CONSTRAINT `CustomerGroup_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCategory` ADD CONSTRAINT `CustomerCategory_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerTag` ADD CONSTRAINT `CustomerTag_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderItem` ADD CONSTRAINT `PurchaseOrderItem_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderTimeline` ADD CONSTRAINT `PurchaseOrderTimeline_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderAudit` ADD CONSTRAINT `PurchaseOrderAudit_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderAttachment` ADD CONSTRAINT `PurchaseOrderAttachment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderRevision` ADD CONSTRAINT `PurchaseOrderRevision_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderApproval` ADD CONSTRAINT `PurchaseOrderApproval_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderComment` ADD CONSTRAINT `PurchaseOrderComment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchasePricingSnapshot` ADD CONSTRAINT `PurchasePricingSnapshot_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceipt` ADD CONSTRAINT `GoodsReceipt_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptLine` ADD CONSTRAINT `GoodsReceiptLine_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptAttachment` ADD CONSTRAINT `GoodsReceiptAttachment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptAudit` ADD CONSTRAINT `GoodsReceiptAudit_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptStatusHistory` ADD CONSTRAINT `GoodsReceiptStatusHistory_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptInspection` ADD CONSTRAINT `GoodsReceiptInspection_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptVersion` ADD CONSTRAINT `GoodsReceiptVersion_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptComment` ADD CONSTRAINT `GoodsReceiptComment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptApproval` ADD CONSTRAINT `GoodsReceiptApproval_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBill` ADD CONSTRAINT `VendorBill_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillLine` ADD CONSTRAINT `VendorBillLine_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillAttachment` ADD CONSTRAINT `VendorBillAttachment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillApproval` ADD CONSTRAINT `VendorBillApproval_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillAudit` ADD CONSTRAINT `VendorBillAudit_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillComment` ADD CONSTRAINT `VendorBillComment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillVersion` ADD CONSTRAINT `VendorBillVersion_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorBillStatusHistory` ADD CONSTRAINT `VendorBillStatusHistory_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturn` ADD CONSTRAINT `PurchaseReturn_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnLine` ADD CONSTRAINT `PurchaseReturnLine_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnAttachment` ADD CONSTRAINT `PurchaseReturnAttachment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnApproval` ADD CONSTRAINT `PurchaseReturnApproval_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnAudit` ADD CONSTRAINT `PurchaseReturnAudit_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnComment` ADD CONSTRAINT `PurchaseReturnComment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnStatusHistory` ADD CONSTRAINT `PurchaseReturnStatusHistory_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReturnShipment` ADD CONSTRAINT `PurchaseReturnShipment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseReplacement` ADD CONSTRAINT `PurchaseReplacement_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditNote` ADD CONSTRAINT `SupplierCreditNote_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditLine` ADD CONSTRAINT `SupplierCreditLine_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditAllocation` ADD CONSTRAINT `SupplierCreditAllocation_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditAttachment` ADD CONSTRAINT `SupplierCreditAttachment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditApproval` ADD CONSTRAINT `SupplierCreditApproval_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditAudit` ADD CONSTRAINT `SupplierCreditAudit_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditComment` ADD CONSTRAINT `SupplierCreditComment_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditVersion` ADD CONSTRAINT `SupplierCreditVersion_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierCreditStatusHistory` ADD CONSTRAINT `SupplierCreditStatusHistory_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowDefinition` ADD CONSTRAINT `WorkflowDefinition_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowInstance` ADD CONSTRAINT `WorkflowInstance_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowTask` ADD CONSTRAINT `WorkflowTask_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowDelegation` ADD CONSTRAINT `WorkflowDelegation_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowTimeline` ADD CONSTRAINT `WorkflowTimeline_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseAnalyticsSnapshot` ADD CONSTRAINT `PurchaseAnalyticsSnapshot_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VendorPerformanceSnapshot` ADD CONSTRAINT `VendorPerformanceSnapshot_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseTrendSnapshot` ADD CONSTRAINT `PurchaseTrendSnapshot_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseCategorySpendSnapshot` ADD CONSTRAINT `PurchaseCategorySpendSnapshot_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseAnalyticsJob` ADD CONSTRAINT `PurchaseAnalyticsJob_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LedgerPosting` ADD CONSTRAINT `LedgerPosting_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductRevision` ADD CONSTRAINT `ProductRevision_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEventAudit` ADD CONSTRAINT `PurchaseEventAudit_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEventReplay` ADD CONSTRAINT `PurchaseEventReplay_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEventDelivery` ADD CONSTRAINT `PurchaseEventDelivery_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseDeadLetter` ADD CONSTRAINT `PurchaseDeadLetter_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseWebhookDelivery` ADD CONSTRAINT `PurchaseWebhookDelivery_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseConsumerState` ADD CONSTRAINT `PurchaseConsumerState_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEventStatistics` ADD CONSTRAINT `PurchaseEventStatistics_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
