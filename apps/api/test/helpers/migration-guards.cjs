// 迁移守卫的公共工具：把 prisma/migrations 下所有 migration.sql 按顺序拼起来，
// 推演「最终状态下活着的唯一约束」集合。
//
// 为什么需要：单元测试用的是内存替身，看不到数据库层的唯一索引，
// 历史上就漏掉过「库级唯一约束与业务口径不一致」的 bug（内存里能并存、真实库直接 409）。
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");

function migrationSql() {
  return readdirSync(migrationsRoot)
    .filter((name) => statSync(join(migrationsRoot, name)).isDirectory())
    .sort()
    .map((name) => readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"))
    .join("\n");
}

const normalize = (value) => value.replace(/"/g, "").trim();

/** 从列清单里取出列名集合（去掉 WHERE/排序等噪音）。 */
function columnsOf(clause) {
  return clause
    .split(",")
    // 必须先 trim 再按空白切分：否则逗号后的前导空白会让 split(/\s+/)[0] 变成空串。
    .map((item) => normalize(item.replace(/\(.*?\)/g, "")).split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * 推演每张表上「活着的唯一约束」：CREATE UNIQUE INDEX / ALTER TABLE ADD CONSTRAINT ... UNIQUE 记为创建，
 * DROP INDEX / DROP CONSTRAINT 记为删除。返回 [{ table, name, columns }]。
 */
function liveUniqueGuards(sql) {
  const live = new Map();
  const statements = sql.split(";");
  for (const statement of statements) {
    const createIndex = /CREATE UNIQUE INDEX(?: IF NOT EXISTS)?\s+"?([\w.]+)"?\s+ON\s+"?([\w.]+)"?\s*\(([^)]*)\)/i.exec(statement);
    if (createIndex) {
      const name = normalize(createIndex[1]);
      live.set(`${normalize(createIndex[2])}::${name}`, { table: normalize(createIndex[2]), name, columns: columnsOf(createIndex[3]) });
      continue;
    }
    const addConstraint = /ALTER TABLE\s+"?([\w.]+)"?\s+ADD CONSTRAINT\s+"?([\w.]+)"?\s+UNIQUE\s*\(([^)]*)\)/i.exec(statement);
    if (addConstraint) {
      const name = normalize(addConstraint[2]);
      live.set(`${normalize(addConstraint[1])}::${name}`, { table: normalize(addConstraint[1]), name, columns: columnsOf(addConstraint[3]) });
      continue;
    }
    const dropIndex = /DROP INDEX(?: IF EXISTS)?\s+"?([\w.]+)"?/i.exec(statement);
    if (dropIndex) {
      const name = normalize(dropIndex[1]);
      for (const [key, guard] of live) if (guard.name === name) live.delete(key);
      continue;
    }
    const dropConstraint = /ALTER TABLE\s+"?([\w.]+)"?\s+DROP CONSTRAINT(?: IF EXISTS)?\s+"?([\w.]+)"?/i.exec(statement);
    if (dropConstraint) live.delete(`${normalize(dropConstraint[1])}::${normalize(dropConstraint[2])}`);
  }
  return [...live.values()];
}

const covers = (columns, expected) => expected.every((column) => columns.includes(column));

module.exports = { migrationSql, liveUniqueGuards, columnsOf, covers, migrationsRoot };
