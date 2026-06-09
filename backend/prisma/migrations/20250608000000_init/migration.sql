-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `refresh_token_hash` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    INDEX `auth_sessions_user_id_expires_at_idx`(`user_id`, `expires_at`),
    INDEX `auth_sessions_refresh_token_hash_idx`(`refresh_token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflows` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `name` VARCHAR(200) NOT NULL DEFAULT 'Untitled workflow',
    `context` TEXT NOT NULL,
    `tools` JSON NOT NULL,
    `nodes` JSON NOT NULL,
    `edges` JSON NOT NULL,
    `status` ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `workflows_user_id_updated_at_idx`(`user_id`, `updated_at` DESC),
    INDEX `workflows_user_id_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_versions` (
    `id` CHAR(36) NOT NULL,
    `workflow_id` CHAR(36) NOT NULL,
    `version_number` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `published_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `workflow_versions_workflow_id_version_number_key`(`workflow_id`, `version_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voice_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `workflow_id` CHAR(36) NULL,
    `workflow_version_id` CHAR(36) NULL,
    `context` TEXT NOT NULL,
    `example` TEXT NOT NULL,
    `end_points` JSON NOT NULL,
    `greeting` VARCHAR(500) NULL,
    `graph` JSON NOT NULL,
    `status` ENUM('active', 'completed', 'expired', 'failed') NOT NULL DEFAULT 'active',
    `started_at` DATETIME(3) NULL,
    `ended_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `voice_sessions_user_id_created_at_idx`(`user_id`, `created_at` DESC),
    INDEX `voice_sessions_workflow_id_idx`(`workflow_id`),
    INDEX `voice_sessions_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `call_turns` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` CHAR(36) NOT NULL,
    `turn_index` INTEGER NOT NULL,
    `speaker` ENUM('caller', 'assistant', 'system') NOT NULL,
    `node_id` VARCHAR(64) NULL,
    `content` TEXT NOT NULL,
    `is_complete` BOOLEAN NOT NULL DEFAULT true,
    `completion_status` ENUM('complete', 'interrupted', 'skipped', 'cancelled') NOT NULL DEFAULT 'complete',
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `call_turns_session_id_turn_index_idx`(`session_id`, `turn_index`),
    INDEX `call_turns_session_id_created_at_idx`(`session_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `session_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` CHAR(36) NOT NULL,
    `event_type` VARCHAR(50) NOT NULL,
    `node_id` VARCHAR(64) NULL,
    `payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `session_events_session_id_created_at_idx`(`session_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflows` ADD CONSTRAINT `workflows_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_versions` ADD CONSTRAINT `workflow_versions_workflow_id_fkey` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workflow_versions` ADD CONSTRAINT `workflow_versions_published_by_fkey` FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `voice_sessions` ADD CONSTRAINT `voice_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `voice_sessions` ADD CONSTRAINT `voice_sessions_workflow_id_fkey` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `voice_sessions` ADD CONSTRAINT `voice_sessions_workflow_version_id_fkey` FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `call_turns` ADD CONSTRAINT `call_turns_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `voice_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `session_events` ADD CONSTRAINT `session_events_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `voice_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
