-- CreateTable
CREATE TABLE `organizations` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `slug` VARCHAR(80) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organization_members` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `role` ENUM('admin', 'sub_admin', 'employee') NOT NULL DEFAULT 'employee',
    `permissions` JSON NOT NULL,
    `status` ENUM('active', 'invited', 'disabled') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `organization_members_user_id_idx`(`user_id`),
    UNIQUE INDEX `organization_members_organization_id_user_id_key`(`organization_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `workflows` ADD COLUMN `organization_id` CHAR(36) NULL;

-- Backfill: one organization per existing user (admin role, all permissions)
INSERT INTO `organizations` (`id`, `name`, `slug`, `created_at`, `updated_at`)
SELECT
    u.`id` AS `id`,
    CONCAT(u.`name`, '''s Organization') AS `name`,
    CONCAT(
        LOWER(REGEXP_REPLACE(SUBSTRING_INDEX(u.`email`, '@', 1), '[^a-zA-Z0-9]+', '-')),
        '-',
        LEFT(REPLACE(u.`id`, '-', ''), 8)
    ) AS `slug`,
    NOW(3),
    NOW(3)
FROM `users` u
WHERE NOT EXISTS (
    SELECT 1 FROM `organization_members` om WHERE om.`user_id` = u.`id`
);

INSERT INTO `organization_members` (`id`, `organization_id`, `user_id`, `role`, `permissions`, `status`, `created_at`, `updated_at`)
SELECT
    UUID(),
    u.`id`,
    u.`id`,
    'admin',
    JSON_OBJECT(
        'dashboard.access', true,
        'users.view', true,
        'users.invite', true,
        'users.manage', true,
        'workflows.view_own', true,
        'workflows.view_all', true,
        'workflows.create', true,
        'workflows.edit_own', true,
        'workflows.edit_all', true,
        'workflows.delete', true,
        'workflows.publish', true,
        'workflows.test', true,
        'sessions.view_own', true,
        'sessions.view_all', true
    ),
    'active',
    NOW(3),
    NOW(3)
FROM `users` u
WHERE NOT EXISTS (
    SELECT 1 FROM `organization_members` om WHERE om.`user_id` = u.`id`
);

UPDATE `workflows` w
INNER JOIN `organization_members` om ON om.`user_id` = w.`user_id`
SET w.`organization_id` = om.`organization_id`
WHERE w.`organization_id` IS NULL;

-- Make organization_id required
ALTER TABLE `workflows` MODIFY `organization_id` CHAR(36) NOT NULL;

-- CreateIndex
CREATE INDEX `workflows_organization_id_updated_at_idx` ON `workflows`(`organization_id`, `updated_at` DESC);
CREATE INDEX `workflows_organization_id_status_idx` ON `workflows`(`organization_id`, `status`);

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workflows` ADD CONSTRAINT `workflows_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
