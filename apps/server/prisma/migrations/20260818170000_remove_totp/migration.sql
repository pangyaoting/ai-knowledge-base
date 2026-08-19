-- 用户反馈：TOTP 验证器太麻烦 → 改用邮箱验证码体系，移除 2FA 字段
ALTER TABLE "users" DROP COLUMN IF EXISTS "totp_secret";
ALTER TABLE "users" DROP COLUMN IF EXISTS "totp_enabled";
ALTER TABLE "users" DROP COLUMN IF EXISTS "recovery_codes";
