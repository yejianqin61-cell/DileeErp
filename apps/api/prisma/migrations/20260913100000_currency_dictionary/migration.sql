-- 币种字典：把「币种」从写死的 CNY/USD 升级为可配置字典（PRD/SRS：币种为可配置字典）。
--
-- 三步都是幂等的：
--   1. 建立 dictionary_types.key = 'currency'；
--   2. 写入内置常用币种；
--   3. 把业务表里已经出现过、但不在内置清单里的币种补成「历史值」字典项，
--      保证既有单据仍能通过币种校验（宪法：已被业务数据引用的类目必须保留历史快照）。
--
-- 没有用户（全新空库）时直接返回，由 prisma/seed.ts 负责初始化。
DO $$
DECLARE
  actor_id uuid;
  type_id uuid;
  target_table text;
BEGIN
  SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;
  IF actor_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "dictionary_types" ("id", "key", "name", "updated_at", "created_by", "updated_by")
  VALUES (gen_random_uuid(), 'currency', '币种', CURRENT_TIMESTAMP, actor_id, actor_id)
  ON CONFLICT ("key") DO NOTHING;

  SELECT "id" INTO type_id FROM "dictionary_types" WHERE "key" = 'currency' AND "deleted_at" IS NULL;
  IF type_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "dictionary_items" ("id", "type_id", "key", "label", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
  SELECT gen_random_uuid(), type_id, item.key, item.label, item.sort_order, true, CURRENT_TIMESTAMP, actor_id, actor_id
  FROM (VALUES
    ('CNY', '人民币', 10),
    ('USD', '美元', 20),
    ('EUR', '欧元', 30),
    ('HKD', '港币', 40),
    ('JPY', '日元', 50),
    ('GBP', '英镑', 60),
    ('TWD', '新台币', 70),
    ('SGD', '新加坡元', 80),
    ('AUD', '澳元', 90),
    ('CAD', '加元', 100),
    ('KRW', '韩元', 110),
    ('THB', '泰铢', 120),
    ('MYR', '马来西亚林吉特', 130),
    ('VND', '越南盾', 140),
    ('INR', '印度卢比', 150)
  ) AS item(key, label, sort_order)
  ON CONFLICT ("type_id", "key") DO NOTHING;

  -- 历史值兜底：扫描所有带 currency 列的业务表，补齐字典里没有的编码。
  -- 宪法要求「已被业务数据引用的类目必须保留历史快照」，否则既有单据会被币种校验挡在门外。
  FOR target_table IN
    SELECT c.table_name
    FROM information_schema.columns AS c
    JOIN information_schema.tables AS t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'currency'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'INSERT INTO "dictionary_items" ("id", "type_id", "key", "label", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
       SELECT gen_random_uuid(), %L, source.code, source.code || ''（历史值）'', 900, true, CURRENT_TIMESTAMP, %L, %L
       FROM (SELECT DISTINCT btrim("currency") AS code FROM %I WHERE "currency" IS NOT NULL AND btrim("currency") <> '''') AS source
       ON CONFLICT ("type_id", "key") DO NOTHING',
      type_id, actor_id, actor_id, target_table
    );
  END LOOP;
END $$;
