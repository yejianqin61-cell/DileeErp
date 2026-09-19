-- 权限规范（2026-09-19）：表面权限四角色 + 「实际权限＝全部模块」
--
-- 用户拍板的模型（表面权限 / 实际权限分离）：
--   * **表面权限**：只在前端生效，决定"菜单给他看什么、哪个页面进得去"。
--   * **实际权限**：所有角色一律等同于管理员——后端不因为这个角色拦人。
--   * 角色：老板 / 财务（最高，看全部页面）、人事（只看人事页面）、其他（除财务、人事外的页面）。
--
-- 为什么用数据实现"实际权限等同管理员"，而不是改守卫：
--   本迁移给四个角色**各授予全部 6 个模块**。于是即便将来有人把 administrator 直通删掉，
--   这四个角色的后端访问依然是全通的；将来真要收紧，只需删 role_permissions 里的行，
--   守卫代码一行都不用改（这正是用户选的口径）。
--   配套的另一半在代码里：ModulePermissionGuard 把"已授予全部模块"的角色与 administrator
--   同等看待，否则 @RequireAdministrator() 那几个接口会把新角色挡在门外。
--
-- 本迁移**只写数据、不改任何 DDL**：roles / role_permissions 两张表早已存在
-- （20260819123000_platform_foundation），所以它不会引入任何 schema 漂移。
--
-- 幂等：两处都是 ON CONFLICT DO NOTHING，重复执行不会产生第二份角色或第二份授权。
--
-- created_by / updated_by 这两列是 NOT NULL 的 UUID（**没有外键**）。这里取"库里最早的
-- 活跃用户"作为记账人；空库（新环境跑迁移时还没有任何用户）则退化为全零 UUID，只求不违反
-- NOT NULL —— 本迁移的记账人不参与任何业务语义。

INSERT INTO "roles" ("id", "key", "name", "created_at", "updated_at", "created_by", "updated_by")
SELECT gen_random_uuid(), seed."key", seed."name", now(), now(), actor."id", actor."id"
FROM (
  VALUES
    ('laoban', '老板'),
    ('caiwu', '财务'),
    ('renshi', '人事'),
    ('qita', '其他')
) AS seed("key", "name")
CROSS JOIN (
  SELECT COALESCE(
    (SELECT "id" FROM "users" WHERE "deleted_at" IS NULL ORDER BY "created_at" LIMIT 1),
    '00000000-0000-0000-0000-000000000000'::uuid
  ) AS "id"
) AS actor
ON CONFLICT ("key") DO NOTHING;

-- 六个模块全授：这就是"实际权限等同管理员"的落地方式。
INSERT INTO "role_permissions" ("role_key", "module_key", "created_at", "updated_at", "created_by", "updated_by")
SELECT seed."role_key", module."module_key", now(), now(), actor."id", actor."id"
FROM (
  VALUES ('laoban'), ('caiwu'), ('renshi'), ('qita')
) AS seed("role_key")
CROSS JOIN (
  VALUES ('sales'), ('procurement'), ('production'), ('warehouse'), ('finance'), ('hr')
) AS module("module_key")
CROSS JOIN (
  SELECT COALESCE(
    (SELECT "id" FROM "users" WHERE "deleted_at" IS NULL ORDER BY "created_at" LIMIT 1),
    '00000000-0000-0000-0000-000000000000'::uuid
  ) AS "id"
) AS actor
ON CONFLICT ("role_key", "module_key") DO NOTHING;
