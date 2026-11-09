-- 会计科目类目（2026-11-07）：类目从「科目行上的一个字符串」升级为一等实体，可增删改查。
--
-- 需求来源：用户 2026-11-07「针对财务模块的会计科目，现在要允许用户自行对会计科目的类目
-- 进行增删改查，现在是否有前后端支持？如果没有，加上去」。
-- 设计见 docs/design/accounting-subject-category-crud-2026-11-07.md。
--
-- 本迁移做三件事：
--   1) 建表 accounting_subject_categories（name 唯一 + sort_order 索引）；
--   2) 有用户时种入 5 个内置类目（会计制度五类，排序 10..50，顺序与
--      `src/modules/finance/accounting-subject-catalog.ts` 的 ACCOUNTING_SUBJECT_CATEGORIES 逐字一致）；
--   3) 把 accounting_subjects 里已经出现、但不在 5 类里的历史取值回填成自建类目
--      （典型来源：「未分类」），sort_order 从 60 起、按名称每行 +10 —— 迁移后
--      「每个科目取值都能在类目表里找到」，否则筛选下拉会漏掉这些科目。
--
-- 空库（无 users）时第 2、3 步整段跳过，交给 `prisma/seed.ts`（先建 5 个内置类目再种科目）——
-- 与币种字典、会计科目等既有迁移同一约定。建表是普通 DDL，空库也要执行。
--
-- ⚠️ `accounting_subjects.category` 继续保留字符串、不改成外键：三大报表
-- （finance-three-statements.ts）与凭证（voucher.service.ts）按类目名匹配科目，
-- 那是会计制度口径、不随用户配置漂移；类目改名由服务层在同一事务里级联 UPDATE 科目行。

CREATE TABLE "accounting_subject_categories" (
  "id" UUID NOT NULL,
  "name" VARCHAR(30) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_system" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  CONSTRAINT "accounting_subject_categories_pkey" PRIMARY KEY ("id")
);

-- 类目名就是业务键（全表唯一）：新增/改名靠它判重，seed 也靠它做幂等 upsert。
CREATE UNIQUE INDEX "accounting_subject_categories_name_key" ON "accounting_subject_categories"("name");
-- 列表默认按权重读（内置 10..50、自建接在后面），没有索引时每次都要全表排序。
CREATE INDEX "accounting_subject_categories_sort_order_idx" ON "accounting_subject_categories"("sort_order");

DO $$
DECLARE
  actor_id uuid;
  -- 5 个内置类目：名字与顺序必须与 accounting-subject-catalog.ts 的 ACCOUNTING_SUBJECT_CATEGORIES 逐字一致
  -- （迁移守卫测试比对这个数组与常量文件）。排序用 10/20/30/40/50，留出插空位。
  system_names text[] := ARRAY['资产类', '负债类', '成本类', '所有者权益类', '损益类'];
  system_sort integer[] := ARRAY[10, 20, 30, 40, 50];
BEGIN
  -- 审计列 created_by/updated_by 是 UUID NOT NULL，且类目行需要有「谁建的」：
  -- 取最早创建的用户（与 20260917 会计科目迁移同一写法）；没有用户 = 空库，交给 seed。
  SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;
  IF actor_id IS NULL THEN
    RETURN;
  END IF;

  -- 5 个内置类目（is_system = true，不可改名/删除：三大报表与凭证按这五个名字匹配科目）。
  -- ON CONFLICT DO NOTHING：重复执行（如人工补跑）时幂等。
  INSERT INTO "accounting_subject_categories" ("id", "name", "sort_order", "is_system", "updated_at", "created_by", "updated_by")
  SELECT gen_random_uuid(), system.name, system.sort_order, true, CURRENT_TIMESTAMP, actor_id, actor_id
  FROM unnest(system_names, system_sort) AS system(name, sort_order)
  ON CONFLICT ("name") DO NOTHING;

  -- 回填历史类目：科目表里出现过、但不在 5 类里的取值（典型是「未分类」）也要成为类目行，
  -- 否则这些科目在筛选/编辑下拉里选不出来（设计文档 §4.5）。sort_order 从 60 起、按名称每行 +10。
  INSERT INTO "accounting_subject_categories" ("id", "name", "sort_order", "is_system", "updated_at", "created_by", "updated_by")
  SELECT
    gen_random_uuid(),
    legacy.category,
    60 + (row_number() OVER (ORDER BY legacy.category) - 1) * 10,
    false,
    CURRENT_TIMESTAMP,
    actor_id,
    actor_id
  FROM (SELECT DISTINCT "category" FROM "accounting_subjects") AS legacy(category)
  WHERE NOT EXISTS (
    SELECT 1 FROM "accounting_subject_categories" existing WHERE existing."name" = legacy.category
  )
  ON CONFLICT ("name") DO NOTHING;
END $$;
