-- 物料唯一性口径调整：由「名称唯一」改为「名称 + 规格型号 + 颜色」组合唯一。
--
-- 背景：客户反馈「新建物料时只要名字一样就不能保存」，但同名不同规格/颜色的物料
-- （例如同一款伞布的不同克重或颜色）本来就需要并存。
--
-- NULL 归一：PostgreSQL 唯一索引里 NULL 互不相等，若允许 specification_model / color 为 NULL，
-- 同名 + 两个 NULL 的记录仍可重复插入，索引等于没生效。因此先把 NULL 写成空串，
-- 服务端（procurement-master-data.service.ts）之后也只写空串，不再写 NULL。

-- 1) 迁移前先检查历史数据是否已存在重复组合：有的话直接报出数量，避免留下半成品状态。
DO $$
DECLARE duplicate_groups integer;
BEGIN
  SELECT count(*) INTO duplicate_groups FROM (
    SELECT name, COALESCE(specification_model, ''), COALESCE(color, '')
    FROM materials
    WHERE deleted_at IS NULL
    GROUP BY 1, 2, 3
    HAVING count(*) > 1
  ) AS duplicated;
  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION '存在 % 组「名称+规格型号+颜色」完全相同的物料，请先改名或合并后再执行本迁移', duplicate_groups;
  END IF;
END $$;

-- 2) NULL → 空串，让组合唯一索引真正生效。
UPDATE materials SET specification_model = '' WHERE specification_model IS NULL;
UPDATE materials SET color = '' WHERE color IS NULL;

-- 3) 去掉只按名称的唯一约束，换成组合唯一。
DROP INDEX IF EXISTS "materials_name_key";
CREATE UNIQUE INDEX "materials_name_specification_model_color_key" ON "materials"("name", "specification_model", "color");
