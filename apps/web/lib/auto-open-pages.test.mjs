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

// 2026-09-14 拆分后，采购页的 useEffect 随功能分散到 orders / inbounds 两个子页，守卫跟着覆盖它们；
// e5be1b5 又把订单详情抽成 procurement/orders/[id] 二级页，新页同样纳入依赖数组检查。
const pages = ["app/warehouse/page.tsx", "app/warehouse/raw-material-storage/page.tsx", "app/procurement/page.tsx", "app/procurement/orders/page.tsx", "app/procurement/orders/[id]/page.tsx", "app/procurement/inbounds/page.tsx", "app/production/page.tsx", "components/qc/incoming-inspections-panel.tsx", "components/qc/qc-inbound-panel.tsx"];

const autoOpenCases = [
  // 自动打开原料入库单：依赖里出现 dialog 就会「关掉又被打开」。
  { file: "app/warehouse/raw-material-storage/page.tsx", marker: "shouldAutoOpenDraft(", forbidden: ["dialog"] },
  // 质检模块的深链自动开单（采购页「登记质检」按到货批次跳过来）：同理只允许依赖到货批次。
  // 用「已处理过的 receipt_id」挡住重复打开，用户手动关掉后不会在下次刷新时再弹一次。
  { file: "components/qc/incoming-inspections-panel.tsx", marker: "allReceiptOptions.find((item) => item.id === receiptId)", forbidden: ["dialog"] }
  // 领料/补料的深链已改为直接落到全屏编辑页（/production/material-issues/new?movement_id=…），
  // 仓库页不再有自动弹出的草稿侧栏，因此这里不再需要对应的依赖守卫。
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

test("领料/补料深链不再依赖自动弹窗：全屏编辑页按 movement_id 直接加载草稿", () => {
  const warehouse = readFileSync(join(webRoot, "app", "warehouse", "page.tsx"), "utf8");
  // 旧的自动弹出 effect 必须彻底消失，否则同一个深链会被两套机制打开两次。
  assert.equal(warehouse.includes("autoOpenedOrderRef.current"), false, "仓库页不应再保留领料草稿的自动弹出 effect");
  const editor = readFileSync(join(webRoot, "components", "production", "material-slip-editor.tsx"), "utf8");
  assert.match(editor, /searchParams\.get\("movement_id"\)/, "编辑页要读取 movement_id");
  assert.match(editor, /apiGet<Movement>\(`\/production\/material-movements\/\$\{movementId\}`\)/, "编辑页要按 movement_id 拉取草稿");
});

test("每个 useEffect 都写明了依赖数组", () => {
  for (const file of pages) {
    const missing = effectBlocks(readFileSync(join(webRoot, file), "utf8")).filter((block) => !block.deps).length;
    assert.equal(missing, 0, `${file} 有 ${missing} 个 useEffect 缺少依赖数组`);
  }
});

test("采购入库页对财务应付台账的读取必须容错，单个接口失败不得让整页空白", () => {
  // 2026-09-14 拆分后：读取应付台账的位置随「原料入库」功能搬到 inbounds 子页。
  const source = readFileSync(join(webRoot, "app", "procurement", "inbounds", "page.tsx"), "utf8");
  assert.match(source, /apiGet<PayableEntry\[\]>\("\/finance\/payable-entries"\)\.catch\(/, "应付台账是辅助数据，必须 catch 后给空数组，避免权限差异导致采购页整页加载失败");
});
