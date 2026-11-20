-- Roadmap 4.9: the nightly analytics job writes one recommendation per
-- (shop, product, business day, type) and upserts on that key instead of
-- appending a new row every night; the KPI snapshot carries the demand rate
-- the recommendation quantities are derived from.

ALTER TABLE `InventoryKpi` ADD COLUMN `avgDailyUnits` DECIMAL(10, 3) NOT NULL DEFAULT 0;

-- Existing rows: the business day is approximated by the UTC date of the
-- insert; duplicates of one key keep the newest row.
ALTER TABLE `InventoryRecommendation` ADD COLUMN `forDate` DATE NULL;
UPDATE `InventoryRecommendation` SET `forDate` = DATE(`createdAt`) WHERE `forDate` IS NULL;
DELETE `older` FROM `InventoryRecommendation` AS `older`
  INNER JOIN `InventoryRecommendation` AS `newer`
    ON `newer`.`shopId` = `older`.`shopId`
   AND `newer`.`productId` = `older`.`productId`
   AND `newer`.`forDate` = `older`.`forDate`
   AND `newer`.`type` = `older`.`type`
   AND (`newer`.`createdAt` > `older`.`createdAt` OR (`newer`.`createdAt` = `older`.`createdAt` AND `newer`.`id` > `older`.`id`));
ALTER TABLE `InventoryRecommendation` MODIFY `forDate` DATE NOT NULL;

CREATE UNIQUE INDEX `InventoryRecommendation_shopId_productId_forDate_type_key` ON `InventoryRecommendation`(`shopId`, `productId`, `forDate`, `type`);
CREATE INDEX `InventoryRecommendation_shopId_forDate_idx` ON `InventoryRecommendation`(`shopId`, `forDate`);
