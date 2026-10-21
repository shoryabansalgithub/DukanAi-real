-- Roadmap 8.3: one open shift per cashier, enforced by the database.
--
-- `openToken` is 'OPEN' while a shift is open and NULL once it is closed. MySQL
-- has no partial index and does not compare NULLs in a unique key, so the key
-- (shopId, openedById, openToken) admits any number of closed shifts and
-- exactly one open one per cashier; the service maps the violation to 409
-- SHIFT_ALREADY_OPEN. Before the key is created, a cashier who already holds
-- several open shifts (the application-level check could race) keeps the most
-- recently opened one; the older ones are closed with a note, closed at the
-- UTC instant of this migration (UTC_TIMESTAMP, never NOW: Prisma stores and
-- reads DateTime columns as UTC, roadmap 8.2). closedById stays NULL: no
-- person closed them.
ALTER TABLE `Shift` ADD COLUMN `openToken` VARCHAR(191) NULL;

UPDATE `Shift` s
JOIN (
  SELECT `shopId`, `openedById`, MAX(`openedAt`) AS `latestOpenedAt`
  FROM `Shift`
  WHERE `status` = 'OPEN' AND `isDeleted` = 0
  GROUP BY `shopId`, `openedById`
) k ON k.`shopId` = s.`shopId` AND k.`openedById` = s.`openedById`
SET s.`status` = 'CLOSED',
    s.`closedAt` = UTC_TIMESTAMP(3),
    s.`notes` = CONCAT(COALESCE(s.`notes`, ''), CASE WHEN s.`notes` IS NULL OR s.`notes` = '' THEN '' ELSE ' | ' END, 'Closed by migration 20261004090000: a newer shift of the same cashier was open'),
    s.`updatedAt` = UTC_TIMESTAMP(3)
WHERE s.`status` = 'OPEN' AND s.`isDeleted` = 0 AND s.`openedAt` < k.`latestOpenedAt`;

UPDATE `Shift` SET `openToken` = 'OPEN' WHERE `status` = 'OPEN' AND `isDeleted` = 0;

CREATE UNIQUE INDEX `Shift_shopId_openedById_openToken_key` ON `Shift`(`shopId`, `openedById`, `openToken`);
