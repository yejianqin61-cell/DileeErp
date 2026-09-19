// 一次性生成器：产出会计科目迁移 SQL。
// 121 条科目与 37 条「旧收支项目 → 科目」映射都从常量文件读，绝不手抄（见 accounting-subject-catalog.ts 的注释）。
const path = require("path");
const fs = require("fs");

const catalogPath = path.join(process.cwd(), "apps", "api", "src", "modules", "finance", "accounting-subject-catalog.ts");
const source = fs.readFileSync(catalogPath, "utf8");

// 直接从 TS 源码里取两个数组字面量，避免为了跑一次生成器去装 ts-node。
function literalArray(name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  // 从 `=` 之后再找 `[`：类型注解 `readonly X[]` 里也有方括号，先找到它就会取到空数组。
  const assign = source.indexOf("=", start);
  const open = source.indexOf("[", assign);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 数组不闭合`);
}

// eslint-disable-next-line no-new-func
const subjects = new Function(`return ${literalArray("ACCOUNTING_SUBJECTS")}`)();
// eslint-disable-next-line no-new-func
const legacy = new Function(`return ${literalArray("LEGACY_CASH_FLOW_ITEM_SUBJECTS")}`)();

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

const subjectValues = subjects
  .map((s) => `      (${q(s.category)}, ${q(s.name)}, ${q(s.balanceDirection)}, ${s.sortOrder})`)
  .join(",\n");
const legacyValues = legacy.map((l) => `      (${q(l.legacyKey)}, ${q(l.category)}, ${q(l.name)})`).join(",\n");

const targets = new Set(legacy.map((l) => `${l.category}/${l.name}`));
const merged = legacy.length - targets.size;

const sql = `-- 会计科目（全站财务口径的唯一来源）：科目表 + 旧「收支项目」并入。
--
-- 需求来源：用户 2026-09-17 交付 \`example/财务/科目表(2).xls\`，口径原文
--   「那个编码的可以不管，分类就对应的是科目类别，项目就对应的是科目名称」，
-- 并选定「**彻底合并**：37 个旧项目并入 121 条科目，历史数据改指」，
-- 以及「收支项目维护和会计科目要合并成会计科目！合并成一个」。
-- 完整的 37→121 对照表见 docs/design/accounting-subject-chart-2026-09-17.md
-- 与 docs/memo/0917-收支项目并入会计科目对照表.md。
--
-- 本迁移做四件事：
--   1) 建 accounting_subjects（两级：分类 category + 项目 name；老表科目代码整列不采纳）；
--   2) 种入科目表 ${subjects.length} 条。其中 ${targets.size} 条**沿用旧收支项目字典项的 id**（当该科目只对应一个旧项目时），
--      这样 5 张表里已有的 \`item_id\` / \`cash_flow_item_id\` 大部分**一个字节都不用改**：
--      历史流水的分类归属靠主键天然延续，改的只是它现在指向哪张表、显示成什么名字；
--      余下 ${merged} 条属于「两条旧项目并到同一科目」（如 \`制造费用-货拉拉\` 与 \`制造费用-物流\` → \`货拉拉 物流费\`），
--      科目只能沿用一个 id，另一条的历史引用由下面的「改指」补齐；
--   3) 旧 \`cash_flow_item\` 字典整体停用（软删，保留成历史快照，不物理删除）；
--   4) 5 张表的外键从 dictionary_items 换到 accounting_subjects，列名 item_id/cash_flow_item_id → subject_id。
--
-- 为什么尽量「沿用旧 id」而不是全量 UPDATE 改指：改指要按 5 张表各写一遍映射，
-- 任何一处写漏就是某类流水静默换了科目。沿用 id 让数据库自己保证一致性。
-- 合并组那几行必须改指（否则外键切换直接失败），所以改指逻辑是通用的、按临时映射表跑的，不漏表。
--
-- 空库（无 users）时科目种入与字典停用整段返回，由 \`prisma/seed.ts\` 负责初始化
-- —— 与币种字典、收支项目字典当年的约定一致。建表与外键切换是普通 DDL，照常执行。

CREATE TABLE "accounting_subjects" (
  "id" UUID NOT NULL,
  "category" VARCHAR(30) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "balance_direction" VARCHAR(4),
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "accounting_subjects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "accounting_subjects_category_name_key" ON "accounting_subjects"("category", "name");
CREATE INDEX "accounting_subjects_category_sort_order_idx" ON "accounting_subjects"("category", "sort_order");

-- 旧收支项目 → 科目 的归属表。放进临时表而不是在 SQL 里抄三遍：
-- 37 行抄三遍，迟早有一遍改漏，而迁移守卫测试只盯得住常量文件、盯不住 SQL 里的重复块。
-- 不筛 deleted_at：已停用的旧字典项也可能被历史流水引用（外键不看 deleted_at），漏掉就是外键切换失败。
CREATE TEMP TABLE "_legacy_cash_flow_item_map" ("legacy_key" text PRIMARY KEY, "category" text NOT NULL, "name" text NOT NULL);
INSERT INTO "_legacy_cash_flow_item_map" ("legacy_key", "category", "name") VALUES
${legacyValues};

DO $$
DECLARE
  actor_id uuid;
  legacy_type_id uuid;
BEGIN
  SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;
  IF actor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "id" INTO legacy_type_id FROM "dictionary_types" WHERE "key" = 'cash_flow_item' AND "deleted_at" IS NULL;

  -- 科目表 ${subjects.length} 条。命中「一对一」映射的科目沿用旧字典项 id（见文件头第 2 点）；
  -- 一对多的组（n > 1）不给 id，用新 uuid，历史引用交给下面的改指逻辑。
  INSERT INTO "accounting_subjects" ("id", "category", "name", "balance_direction", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
  SELECT COALESCE(mapped.legacy_id, gen_random_uuid()), m.category, m.name, m.direction, m.sort_order, true, CURRENT_TIMESTAMP, actor_id, actor_id
  FROM (VALUES
${subjectValues}
  ) AS m(category, name, direction, sort_order)
  LEFT JOIN (
    SELECT lm.category, lm.name, (array_agg(d."id"))[1] AS legacy_id, count(*) AS n
    FROM "_legacy_cash_flow_item_map" lm
    JOIN "dictionary_items" d ON d."key" = lm.legacy_key AND d."type_id" = legacy_type_id
    GROUP BY lm.category, lm.name
  ) AS mapped ON mapped.category = m.category AND mapped.name = m.name AND mapped.n = 1
  ON CONFLICT ("category", "name") DO NOTHING;

  -- 兜底：字典里存在、但不在 37 条对照表内的自定义收支项目（财务在界面上自己加过的那种）
  -- 不能因为「没写进对照表」就把已经记过账的分类丢掉。它们以原 id、原名字并入「未分类」，
  -- 由财务在「会计科目」页上重新归类。从未自定义过时这一句不插入任何行。
  INSERT INTO "accounting_subjects" ("id", "category", "name", "balance_direction", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
  SELECT d."id", '未分类', d."label", NULL, 9000 + d."sort_order", true, CURRENT_TIMESTAMP, actor_id, actor_id
  FROM "dictionary_items" d
  WHERE d."type_id" = legacy_type_id
    AND NOT EXISTS (SELECT 1 FROM "_legacy_cash_flow_item_map" lm WHERE lm."legacy_key" = d."key")
  ON CONFLICT ("category", "name") DO NOTHING;

  -- 改指前的自检：每个旧字典项都必须有落点，否则外键切换会失败，
  -- 而外键报错只说「有行违反约束」，不会说是哪一条。
  IF legacy_type_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "dictionary_items" d
    WHERE d."type_id" = legacy_type_id
      AND NOT EXISTS (
        SELECT 1 FROM "_legacy_cash_flow_item_map" lm
        JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
        WHERE lm."legacy_key" = d."key"
      )
      AND NOT EXISTS (SELECT 1 FROM "accounting_subjects" s2 WHERE s2."id" = d."id")
  ) THEN
    RAISE EXCEPTION '收支项目字典里存在无法并入会计科目的项：既不在对照表内，也没能作为「未分类」科目落库（多半是与已有科目同名）。请先在界面上改名后重跑迁移';
  END IF;

  -- 改指：合并组里没沿用到 id 的那条旧项目，其历史引用要改指到科目 id。
  -- 五张表逐一处理（列名此刻还是旧名，重命名在下面的 DDL 里做）。
  -- 只改真正需要改的行（subject 不同），并记下 updated_at/updated_by —— 这些行确实被这次合并改动过，
  -- 谎称「最后修改人还是当初录单的人」比改掉它更糟；原因与前后值另有审计事件留底。
  UPDATE "cash_flow_entries" e
  SET "item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE e."item_id" = d."id" AND e."item_id" <> s."id";

  UPDATE "customer_payments" p
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE p."cash_flow_item_id" = d."id" AND p."cash_flow_item_id" <> s."id";

  UPDATE "supplier_payments" p
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE p."cash_flow_item_id" = d."id" AND p."cash_flow_item_id" <> s."id";

  UPDATE "receivable_reconciliations" r
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE r."cash_flow_item_id" = d."id" AND r."cash_flow_item_id" <> s."id";

  UPDATE "supplier_payable_reconciliations" r
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE r."cash_flow_item_id" = d."id" AND r."cash_flow_item_id" <> s."id";

  IF legacy_type_id IS NOT NULL THEN
    -- 落库记录：旧项目 → 科目 的对照表整体写进审计事件（操作人、时间、原因与前后值都在），
    -- 满足宪法《Reversible Business Changes》「保留原始事实、操作人、时间、原因与前后值」。
    INSERT INTO "audit_events" ("id", "action", "entity_type", "actor_id", "details")
    VALUES (
      gen_random_uuid(),
      'accounting_subject.merge_legacy_cash_flow_items',
      'accounting_subject',
      actor_id,
      jsonb_build_object(
        'reason', '用户 2026-09-17 选定：收支项目维护与会计科目合并成一个，37 个旧项目并入科目表 ${subjects.length} 条',
        'source', 'example/财务/科目表(2).xls',
        'mapping', (SELECT jsonb_agg(jsonb_build_object('legacy_key', lm.legacy_key, 'category', lm.category, 'name', lm.name) ORDER BY lm.legacy_key) FROM "_legacy_cash_flow_item_map" lm)
      )
    );

    -- 旧字典整体停用（软删）：科目已经接管口径，留着可用的旧字典只会让人在两张表之间选错。
    UPDATE "dictionary_items"
    SET "deleted_at" = CURRENT_TIMESTAMP, "deleted_by" = actor_id, "updated_by" = actor_id, "updated_at" = CURRENT_TIMESTAMP
    WHERE "type_id" = legacy_type_id AND "deleted_at" IS NULL;
  END IF;

  UPDATE "dictionary_types"
  SET "deleted_at" = CURRENT_TIMESTAMP, "deleted_by" = actor_id, "updated_by" = actor_id, "updated_at" = CURRENT_TIMESTAMP
  WHERE "key" = 'cash_flow_item' AND "deleted_at" IS NULL;
END $$;

DROP TABLE IF EXISTS "_legacy_cash_flow_item_map";

-- 外键切换：dictionary_items → accounting_subjects，列名一并改成 subject_id
-- （列名留着 item_id 会让「这是收支项目」的旧口径在代码里阴魂不散，而它现在是会计科目）。
ALTER TABLE "cash_flow_entries" RENAME COLUMN "item_id" TO "subject_id";
ALTER TABLE "cash_flow_entries" DROP CONSTRAINT "cash_flow_entries_item_id_fkey";
DROP INDEX "cash_flow_entries_item_id_direction_idx";
CREATE INDEX "cash_flow_entries_subject_id_direction_idx" ON "cash_flow_entries"("subject_id", "direction");
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_payments" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "customer_payments" DROP CONSTRAINT "customer_payments_cash_flow_item_id_fkey";
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_payments" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "supplier_payments" DROP CONSTRAINT "supplier_payments_cash_flow_item_id_fkey";
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "receivable_reconciliations" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "receivable_reconciliations" DROP CONSTRAINT "receivable_reconciliations_cash_flow_item_id_fkey";
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_payable_reconciliations" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "supplier_payable_reconciliations" DROP CONSTRAINT "supplier_payable_reconciliations_cash_flow_item_id_fkey";
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
`;

const dir = path.join(process.cwd(), "apps", "api", "prisma", "migrations", "20260917120000_accounting_subjects");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "migration.sql"), sql, "utf8");
console.log(`subjects=${subjects.length} legacy=${legacy.length} distinctTargets=${targets.size} mergedGroups=${merged} -> ${path.join(dir, "migration.sql")}`);
