#!/usr/bin/env node
// 对比两份财务基线：换 join 前后各抓一次，跑这个看差在哪。
//
// 用法：node scripts/snapshot/compare-finance-baseline.mjs before after
// 退出码：0 = 无差异；1 = 有差异（CI/脚本可直接用）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [beforeLabel = "before", afterLabel = "after"] = process.argv.slice(2);
const load = (label) => JSON.parse(readFileSync(join(root, "docs", "test", "baselines", `finance-${label}.json`), "utf8"));

const before = load(beforeLabel);
const after = load(afterLabel);
const diffs = [];

function walk(left, right, path) {
  if (typeof left !== typeof right) { diffs.push(`${path}：类型不同`); return; }
  if (left && typeof left === "object") {
    const keys = new Set([...Object.keys(left), ...(right && typeof right === "object" ? Object.keys(right) : [])]);
    for (const key of keys) walk(left[key], right && right[key], `${path}.${key}`);
    return;
  }
  if (left !== right) diffs.push(`${path}：${JSON.stringify(left)} → ${JSON.stringify(right)}`);
}

for (const path of new Set([...Object.keys(before.endpoints), ...Object.keys(after.endpoints)])) {
  walk(before.endpoints[path], after.endpoints[path], path);
}

console.log(`对比 ${beforeLabel} ↔ ${afterLabel}：${Object.keys(before.endpoints).length} 个接口，差异 ${diffs.length} 处`);
for (const diff of diffs.slice(0, 40)) console.log(`  ${diff}`);
if (diffs.length > 40) console.log(`  …还有 ${diffs.length - 40} 处`);
process.exit(diffs.length === 0 ? 0 : 1);
