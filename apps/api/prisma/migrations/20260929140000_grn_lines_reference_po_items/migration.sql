-- Roadmap 4.2: a goods-receipt line fulfils one purchase-order line. The
-- ordered quantity and the price of a receipt line come from that line, and
-- the sum of accepted quantities across receipts is capped at the ordered
-- quantity. Existing lines keep NULL (they were created before the link).
ALTER TABLE `GoodsReceiptLine` ADD COLUMN `purchaseOrderItemId` VARCHAR(191) NULL;
CREATE INDEX `GoodsReceiptLine_purchaseOrderItemId_idx` ON `GoodsReceiptLine`(`purchaseOrderItemId`);
ALTER TABLE `GoodsReceiptLine` ADD CONSTRAINT `GoodsReceiptLine_purchaseOrderItemId_fkey` FOREIGN KEY (`purchaseOrderItemId`) REFERENCES `PurchaseOrderItem`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
