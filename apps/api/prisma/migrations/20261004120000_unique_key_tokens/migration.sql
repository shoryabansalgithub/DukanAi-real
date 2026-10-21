-- Phase 8 exit gate: no nullable column inside a unique key.
--
-- MySQL never compares NULLs in a unique index, so a key that includes a
-- nullable column admits any number of rows whose nullable part is NULL. Two
-- keys used such a column as a real dimension of the row:
--   PurchaseCategorySpendSnapshot (shopId, categoryId, departmentId)
--   PriceListItem                 (versionId, productId, variantId)
-- Each gains a NOT NULL token column that mirrors the nullable one with '-'
-- for NULL, exactly as InventoryItem.variantKey does (migration
-- 20260919090000), and the unique key moves onto the token. The application
-- writes both columns.
--
-- Order matters on MySQL: the new unique index is created BEFORE the old one
-- is dropped, because the foreign key on the leading column (shopId /
-- versionId) needs an index at all times (error 1553 otherwise), and the new
-- index takes that role over. The snapshot writer used to store '' for "no
-- department"; those rows become NULL + '-'. Rows that already collide on the
-- new key are reduced to the most recently updated one (snapshots are
-- recomputed nightly); PriceListItem duplicates keep the oldest row, and
-- their PricingTier children go with them (ON DELETE CASCADE).
-- No database clock is used (roadmap 8.2); nothing here needs a timestamp.

-- ---------------------------------------------------------------------------
-- 1. PurchaseCategorySpendSnapshot.departmentKey
-- ---------------------------------------------------------------------------
ALTER TABLE `PurchaseCategorySpendSnapshot` ADD COLUMN `departmentKey` VARCHAR(191) NOT NULL DEFAULT '-';

UPDATE `PurchaseCategorySpendSnapshot` SET `departmentId` = NULL WHERE `departmentId` = '';
UPDATE `PurchaseCategorySpendSnapshot` SET `departmentKey` = COALESCE(`departmentId`, '-');

DELETE d FROM `PurchaseCategorySpendSnapshot` d
JOIN `PurchaseCategorySpendSnapshot` k
  ON k.`shopId` = d.`shopId`
 AND k.`categoryId` = d.`categoryId`
 AND k.`departmentKey` = d.`departmentKey`
 AND (k.`updatedAt` > d.`updatedAt` OR (k.`updatedAt` = d.`updatedAt` AND k.`id` > d.`id`));

CREATE UNIQUE INDEX `PurchaseCategorySpendSnapshot_shopId_categoryId_departmentKe_key`
  ON `PurchaseCategorySpendSnapshot`(`shopId`, `categoryId`, `departmentKey`);
DROP INDEX `PurchaseCategorySpendSnapshot_shopId_categoryId_departmentId_key` ON `PurchaseCategorySpendSnapshot`;

-- ---------------------------------------------------------------------------
-- 2. PriceListItem.variantKey
-- ---------------------------------------------------------------------------
ALTER TABLE `PriceListItem` ADD COLUMN `variantKey` VARCHAR(191) NOT NULL DEFAULT '-';

UPDATE `PriceListItem` SET `variantKey` = COALESCE(`variantId`, '-');

DELETE d FROM `PriceListItem` d
JOIN `PriceListItem` k
  ON k.`versionId` = d.`versionId`
 AND k.`productId` = d.`productId`
 AND k.`variantKey` = d.`variantKey`
 AND (k.`createdAt` < d.`createdAt` OR (k.`createdAt` = d.`createdAt` AND k.`id` < d.`id`));

CREATE UNIQUE INDEX `PriceListItem_versionId_productId_variantKey_key`
  ON `PriceListItem`(`versionId`, `productId`, `variantKey`);
DROP INDEX `PriceListItem_versionId_productId_variantId_key` ON `PriceListItem`;
