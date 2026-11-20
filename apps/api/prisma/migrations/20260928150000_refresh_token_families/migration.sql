-- Roadmap 2.6: refresh tokens form session families. Existing rows become
-- one-token families (familyId = id) whose absolute lifetime is the token's
-- own expiry. Plain SQL that runs identically on MySQL 8 and MariaDB.
ALTER TABLE `RefreshToken` ADD COLUMN `familyId` VARCHAR(191) NULL;
ALTER TABLE `RefreshToken` ADD COLUMN `absoluteExpiresAt` DATETIME(3) NULL;
ALTER TABLE `RefreshToken` ADD COLUMN `rotatedAt` DATETIME(3) NULL;
UPDATE `RefreshToken` SET `familyId` = `id`, `absoluteExpiresAt` = `expiresAt`;
ALTER TABLE `RefreshToken` MODIFY `familyId` VARCHAR(191) NOT NULL;
ALTER TABLE `RefreshToken` MODIFY `absoluteExpiresAt` DATETIME(3) NOT NULL;
CREATE INDEX `RefreshToken_familyId_idx` ON `RefreshToken`(`familyId`);
