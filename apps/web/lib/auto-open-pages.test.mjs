// 弹窗自动打开的页面级守卫。
//
// lib/auto-open.test.mjs 只覆盖纯函数：把 `dialog` / `issueDraft` 重新加回 effect 依赖，
// 纯函数测试依然全绿 —— 而“关闭后立刻被重新打开”的缺陷正是由依赖数组引起的。
// 这里直接对页面源码断言相关 effect 的依赖数组，保住本次修复的核心行为。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

/** 解析文件中所有 useEffect 的「函数体 + 依赖数组」。 */
function effectBlocks(source) {
  const blocks = [];
  const marker = "useEffect(() => {";
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    const open = source.indexOf("{", at);
    let depth = 0;
    let end = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") { depth -= 1; if (depth === 0) { end = index; break; } }
    }
    if (end < 0) continue;
    const match = /\}\s*,\s*\[([^\]]*)\]/.exec(source.slice(end, end + 200));
    blocks.push({
      body: source.slice(open, end),
      deps: match ? match[1].split(",").map((entry) => entry.trim()).filter(Boolean) : null
    });
  }
  return blocks;
}

const pages = ["app/warehouse/page.tsx", "app/warehouse/raw-material-storage/page.tsx", "app/procurement/page.tsx", "app/production/page.tsx"];

const autoOpenCases = [
  // 自动打开原料入库单：依赖里出现 dialog 就会「关掉又被打开」。
  { file: "app/warehouse/raw-material-storage/page.tsx", marker: "shouldAutoOpenDraft(", forbidden: ["dialog"] },
  // 自动打开原料出库单：依赖里出现 issueDraft 同理。
  { file: "app/warehouse/page.tsx", marker: "autoOpenedOrderRef.current", forbidden: ["issueDraft"] }
];

test("自动打开弹窗的 effect 不得把弹窗自身状态放进依赖（否则关闭后会立刻重开）", () => {
  for (const item of autoOpenCases) {
    const source = readFileSync(join(webRoot, item.file), "utf8");
    const block = effectBlocks(source).find((candidate) => candidate.body.includes(item.marker));
    assert.ok(block, `${item.file} 未找到包含 ${item.marker} 的 useEffect`);
    assert.ok(block.deps, `${item.file} 自动打开 effect 缺少依赖数组`);
    for (const forbidden of item.forbidden) {
      assert.equal(block.deps.includes(forbidden), false, `${item.file} 的自动打开 effect 依赖里不能含 ${forbidden}，否则关闭后会被立刻重新打开`);
    }
  }
});

test("每个 useEffect 都写明了依赖数组", () => {
  for (const file of pages) {
    const missing = effectBlocks(readFileSync(join(webRoot, file), "utf8")).filter((block) => !block.deps).length;
    assert.equal(missing, 0, `${file} 有 ${missing} 个 useEffect 缺少依赖数组`);
  }
});

test("采购页对财务应付台账的读取必须容错，单个接口失败不得让整页空白", () => {
  const source = readFileSync(join(webRoot, "app/procurement/page.tsx"), "utf8");
  assert.match(source, /apiGet<PayableEntry\[\]>\("\/finance\/payable-entries"\)\.catch\(/, "应付台账是辅助数据，必须 catch 后给空数组，避免权限差异导致采购页整页加载失败");
});
