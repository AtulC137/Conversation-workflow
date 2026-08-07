-- AlterTable
ALTER TABLE `workflows` ADD COLUMN `script` TEXT NULL;
UPDATE `workflows` SET `script` = '' WHERE `script` IS NULL;
ALTER TABLE `workflows` MODIFY COLUMN `script` TEXT NOT NULL;
