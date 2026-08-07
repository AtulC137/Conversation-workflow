-- DropIndex
DROP INDEX `call_turns_session_id_turn_index_idx` ON `call_turns`;

-- CreateIndex
CREATE UNIQUE INDEX `call_turns_session_id_turn_index_key` ON `call_turns`(`session_id`, `turn_index`);

-- DropIndex
DROP INDEX `auth_sessions_refresh_token_hash_idx` ON `auth_sessions`;

-- CreateIndex
CREATE UNIQUE INDEX `auth_sessions_refresh_token_hash_key` ON `auth_sessions`(`refresh_token_hash`);

-- CreateIndex
CREATE INDEX `auth_sessions_expires_at_idx` ON `auth_sessions`(`expires_at`);

-- CreateIndex
CREATE INDEX `voice_sessions_expires_at_idx` ON `voice_sessions`(`expires_at`);
