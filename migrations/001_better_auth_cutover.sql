-- ============================================================
-- how-server（Nitro + better-auth）切换迁移脚本
-- 前置：已停写旧版 how-api；在 how2hao_api 库上执行
-- 幂等：可重复执行
-- ============================================================

-- 1) better-auth 标准表 ------------------------------------------------
CREATE TABLE IF NOT EXISTS `session` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `token` VARCHAR(128) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(500) NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_session_token` (`token`),
  INDEX `idx_session_user_id` (`user_id`),
  CONSTRAINT `fk_session_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `account` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `account_id` VARCHAR(191) NOT NULL,
  `provider_id` VARCHAR(64) NOT NULL,
  `user_id` INT NOT NULL,
  `access_token` VARCHAR(1024) NULL,
  `refresh_token` VARCHAR(1024) NULL,
  `id_token` VARCHAR(2048) NULL,
  `access_token_expires_at` DATETIME NULL,
  `refresh_token_expires_at` DATETIME NULL,
  `scope` VARCHAR(255) NULL,
  `password` VARCHAR(255) NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_account_provider_account` (`provider_id`, `account_id`),
  INDEX `idx_account_user_id` (`user_id`),
  CONSTRAINT `fk_account_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `verification` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `identifier` VARCHAR(255) NOT NULL,
  `value` VARCHAR(2048) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_verification_identifier` (`identifier`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 2) users 表改造 -------------------------------------------------------
-- 2a. 补 better-auth 兼容列（email 非唯一：微信/Apple 用户为空串）
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `email` VARCHAR(255) NOT NULL DEFAULT '' AFTER `avatar`,
  ADD COLUMN IF NOT EXISTS `email_verified` TINYINT(1) NOT NULL DEFAULT 0 AFTER `email`;

-- 2b. created_at / updated_at：bigint 毫秒 → datetime（better-auth 以 Date 读写）
--     通过影子列转换，保留原值精度
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `created_at_dt` DATETIME NULL,
  ADD COLUMN IF NOT EXISTS `updated_at_dt` DATETIME NULL;

UPDATE `users` SET `created_at_dt` = FROM_UNIXTIME(`created_at` / 1000)
WHERE `created_at_dt` IS NULL AND `created_at` IS NOT NULL AND `created_at` > 0;
UPDATE `users` SET `updated_at_dt` = FROM_UNIXTIME(`updated_at` / 1000)
WHERE `updated_at_dt` IS NULL AND `updated_at` IS NOT NULL AND `updated_at` > 0;
UPDATE `users` SET `created_at_dt` = NOW() WHERE `created_at_dt` IS NULL;
UPDATE `users` SET `updated_at_dt` = COALESCE(`updated_at_dt`, `created_at_dt`);

ALTER TABLE `users`
  DROP COLUMN `created_at`,
  DROP COLUMN `updated_at`,
  CHANGE COLUMN `created_at_dt` `created_at` DATETIME NOT NULL,
  CHANGE COLUMN `updated_at_dt` `updated_at` DATETIME NOT NULL,
  ADD INDEX IF NOT EXISTS `idx_users_email` (`email`);

-- 3) 数据迁移（旧 → 新，幂等） -------------------------------------------
-- 3a. user_identities → account（第三方身份）
INSERT INTO `account` (`account_id`, `provider_id`, `user_id`, `created_at`, `updated_at`)
SELECT
  i.`provider_uid`,
  i.`provider`,
  i.`user_id`,
  COALESCE(FROM_UNIXTIME(i.`created_at` / 1000), NOW()),
  COALESCE(FROM_UNIXTIME(i.`updated_at` / 1000), NOW())
FROM `user_identities` i
WHERE NOT EXISTS (
  SELECT 1 FROM `account` a
  WHERE a.`provider_id` = i.`provider` AND a.`account_id` = i.`provider_uid`
);

-- 3b. users.password_hash → account（providerId='credential'，bcrypt 哈希直接沿用）
INSERT INTO `account` (`account_id`, `provider_id`, `user_id`, `password`, `created_at`, `updated_at`)
SELECT
  CAST(u.`id` AS CHAR),
  'credential',
  u.`id`,
  u.`password_hash`,
  NOW(),
  NOW()
FROM `users` u
WHERE u.`password_hash` IS NOT NULL AND u.`password_hash` <> ''
  AND NOT EXISTS (
    SELECT 1 FROM `account` a
    WHERE a.`provider_id` = 'credential' AND a.`user_id` = u.`id`
  );

-- 3c. user_session（未撤销且未过期）→ session：保留旧 refreshToken，用户无需重新登录
INSERT INTO `session` (`user_id`, `token`, `expires_at`, `ip_address`, `user_agent`, `created_at`, `updated_at`)
SELECT
  s.`user_id`,
  s.`refresh_token`,
  FROM_UNIXTIME(s.`expires_at` / 1000),
  s.`ip`,
  s.`user_agent`,
  COALESCE(FROM_UNIXTIME(s.`created_at` / 1000), NOW()),
  COALESCE(FROM_UNIXTIME(s.`updated_at` / 1000), NOW())
FROM `user_session` s
WHERE s.`revoked_at` IS NULL
  AND s.`expires_at` > UNIX_TIMESTAMP(NOW()) * 1000
  AND NOT EXISTS (SELECT 1 FROM `session` se WHERE se.`token` = s.`refresh_token`);

-- 4) 遗留表（user_identities / user_session / users.password_hash）保留只读，观察期后再删除
