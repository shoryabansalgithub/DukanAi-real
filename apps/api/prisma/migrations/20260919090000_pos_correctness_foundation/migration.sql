-- LOW-LEVEL POS CORRECTNESS ROADMAP: database guards the code used to assume.
--
-- 1. InventoryItem uniqueness. The previous key (shopId, productId, variantId,
--    locationId) never fired for the POS because variantId is NULL and MySQL
--    treats NULLs as distinct in unique indexes. `variantKey` mirrors variantId
--    with '-' for NULL and carries the real unique index. Rows that already
--    violate the key (created by the find-then-create race) are merged into one
--    survivor per key: child rows are re-pointed and every quantity column is
--    summed, then the duplicates are deleted (children first, so the RESTRICT
--    foreign keys hold).
-- 2. InventoryItem.locationId loses its 'DEFAULT' default: it is a foreign key
--    to Location.id and every writer resolves a real id.
-- 3. InvoiceItem.productId becomes nullable for custom (ad-hoc) POS lines.
-- 4. Ledger accounts ACCOUNTS_PAYABLE (goods received on credit) and
--    INVENTORY_ADJUSTMENT (manual adjustments, damage, loss, expiry).
-- Safe to run on a database created from the baseline migration or via `prisma db push`.
-- Requires MySQL 8.0+ or MariaDB 10.2+ (window functions).

-- ---------------------------------------------------------------------------
-- 1. InventoryItem.variantKey + real unique index
-- ---------------------------------------------------------------------------
ALTER TABLE `InventoryItem` ADD COLUMN `variantKey` VARCHAR(191) NOT NULL DEFAULT '-';
UPDATE `InventoryItem` SET `variantKey` = COALESCE(`variantId`, '-');

-- Survivor per key: the oldest live row (isDeleted = false first, then
-- createdAt, then id so the choice is total even when timestamps collide).
CREATE TEMPORARY TABLE `__ii_ranked` AS
  SELECT `id`, `shopId`, `productId`, `variantKey`, `locationId`,
         ROW_NUMBER() OVER (
           PARTITION BY `shopId`, `productId`, `variantKey`, `locationId`
           ORDER BY `isDeleted` ASC, `createdAt` ASC, `id` ASC
         ) AS rn
  FROM `InventoryItem`;

CREATE TEMPORARY TABLE `__ii_dups` AS
  SELECT d.`id` AS dupId, s.`id` AS survivorId
  FROM `__ii_ranked` d
  JOIN `__ii_ranked` s
    ON s.`shopId` = d.`shopId` AND s.`productId` = d.`productId`
   AND s.`variantKey` = d.`variantKey` AND s.`locationId` = d.`locationId`
   AND s.rn = 1
  WHERE d.rn > 1;

-- Fold every quantity of the duplicates into the survivor.
UPDATE `InventoryItem` s
  JOIN (SELECT x.survivorId,
               SUM(i.`onHand`) AS onHand, SUM(i.`reserved`) AS reserved, SUM(i.`allocated`) AS allocated,
               SUM(i.`damaged`) AS damaged, SUM(i.`lost`) AS lost, SUM(i.`inTransit`) AS inTransit
        FROM `__ii_dups` x JOIN `InventoryItem` i ON i.`id` = x.dupId
        GROUP BY x.survivorId) m
    ON m.survivorId = s.`id`
  SET s.`onHand` = s.`onHand` + m.onHand,
      s.`reserved` = s.`reserved` + m.reserved,
      s.`allocated` = s.`allocated` + m.allocated,
      s.`damaged` = s.`damaged` + m.damaged,
      s.`lost` = s.`lost` + m.lost,
      s.`inTransit` = s.`inTransit` + m.inTransit,
      s.`isDeleted` = false,
      s.`deletedAt` = NULL,
      s.`version` = s.`version` + 1;

-- Re-point every child table (all reference InventoryItem with ON DELETE RESTRICT).
UPDATE `AdjustmentRequest`     c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `BatchStock`            c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryAdjustment`   c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryAlert`        c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryMovement`     c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventorySnapshot`     c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `InventoryThreshold`    c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `ReservationAllocation` c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `StockCountItem`        c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `StockLedgerEntry`      c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
UPDATE `StockSnapshot`         c JOIN `__ii_dups` x ON c.`inventoryItemId` = x.dupId SET c.`inventoryItemId` = x.survivorId;
DELETE i FROM `InventoryItem` i JOIN `__ii_dups` x ON i.`id` = x.dupId;
DROP TEMPORARY TABLE `__ii_dups`;
DROP TEMPORARY TABLE `__ii_ranked`;

ALTER TABLE `InventoryItem` DROP INDEX `InventoryItem_shopId_productId_variantId_locationId_key`;
CREATE UNIQUE INDEX `InventoryItem_shopId_productId_variantKey_locationId_key` ON `InventoryItem`(`shopId`, `productId`, `variantKey`, `locationId`);

-- ---------------------------------------------------------------------------
-- 2. InventoryItem.locationId: no more 'DEFAULT' placeholder default
-- ---------------------------------------------------------------------------
ALTER TABLE `InventoryItem` MODIFY `locationId` VARCHAR(191) NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. InvoiceItem: custom lines
-- ---------------------------------------------------------------------------
ALTER TABLE `InvoiceItem` DROP FOREIGN KEY `InvoiceItem_productId_fkey`;
ALTER TABLE `InvoiceItem`
  MODIFY `productId` VARCHAR(191) NULL,
  ADD COLUMN `isCustom` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `InvoiceItem` ADD CONSTRAINT `InvoiceItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 4. Ledger accounts
-- ---------------------------------------------------------------------------
ALTER TABLE `LedgerTransaction`
  MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT') NOT NULL;
ALTER TABLE `LedgerAccountBalance`
  MODIFY `account` ENUM('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'GST_PAYABLE', 'COST_OF_GOODS', 'INVENTORY', 'UDHAR_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY_ADJUSTMENT') NOT NULL;
