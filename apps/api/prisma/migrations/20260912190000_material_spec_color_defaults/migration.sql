-- 物料组合唯一索引要求 specification_model / color 不能是 NULL（PostgreSQL 唯一索引里 NULL 互不相等），
-- 上一条迁移已把历史 NULL 归一成空串，这里补上列默认值：
-- 任何省略这两列写入数据的路径（脚本/导入）拿到的都是空串，不会再悄悄绕开唯一约束。
ALTER TABLE "materials" ALTER COLUMN "specification_model" SET DEFAULT '';
ALTER TABLE "materials" ALTER COLUMN "color" SET DEFAULT '';
