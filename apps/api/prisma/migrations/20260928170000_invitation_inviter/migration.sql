-- Roadmap 2.8: record who issued an invitation. Historical rows keep NULL.
ALTER TABLE `Invitation` ADD COLUMN `inviterId` VARCHAR(191) NULL;
CREATE INDEX `Invitation_inviterId_idx` ON `Invitation`(`inviterId`);
