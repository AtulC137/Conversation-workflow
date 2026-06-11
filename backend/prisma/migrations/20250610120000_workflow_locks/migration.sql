-- CreateTable
CREATE TABLE `workflow_locks` (
    `workflow_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `locked_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `workflow_locks_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`workflow_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `workflow_locks` ADD CONSTRAINT `workflow_locks_workflow_id_fkey` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workflow_locks` ADD CONSTRAINT `workflow_locks_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
