// 页面数据绑定对齐检查。
//
// 背景：采购页曾出现 `const [po, qc, ib, payable, ms, us, ...] = await Promise.all([...10 个请求])`
// —— 绑定名少于请求数，导致其后每个字段整体错位：`units` 收到物料（新建物料时“默认单位”显示物料名称），
// `salesOrders` 收到 BOM 行（BOM 板块看不到销售单），`/sales-orders` 响应被直接丢弃，
// 进而使生产单候选（要求已确认且已有 BOM 的销售单）永远为空。
// 这类错位不会触发类型错误（都是数组），只能靠本检查捕获。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

// 用等长掩码替换字符串内容（保留引号与字符偏移），避免路径或文案里的括号、逗号干扰结构解析。
const maskStrings = (text) => text.replace(/(`|"|')((?:\\.|(?!\1)[^\\])*)\1/g, (match, quote, body) => quote + " ".repeat(body.length) + quote);

/** 按顶层逗号切分数组体，得到每个元素（三元、.catch() 链均算一个元素）。 */
function splitTopLevel(body) {
  const elements = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) { elements.push(body.slice(start, index)); start = index + 1; }
  }
  const tail = body.slice(start);
  if (tail.trim()) elements.push(tail);
  return elements.filter((element) => element.trim());
}

// 读取第一个字符串字面量路径（可用时），用于报告可读性。
const firstPath = (element) => {
  const match = /apiGet\s*[<(][\s\S]*?\(\s*"([^"]*)"/.exec(element) ?? /apiGet\s*[<(][\s\S]*?\(\s*`([^`]*)`/.exec(element);
  return match ? match[1] : "<动态路径>";
};

function extractCalls(source) {
  const masked = maskStrings(source);
  const calls = [];
  const marker = "Promise.all([";
  for (let at = masked.indexOf(marker); at >= 0; at = masked.indexOf(marker, at + 1)) {
    const open = at + marker.length - 1;
    let depth = 0;
    let end = -1;
    for (let index = open; index < masked.length; index += 1) {
      const char = masked[index];
      if (char === "(" || char === "[") depth += 1;
      else if (char === ")" || char === "]") {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    if (end < 0) continue;
    const before = masked.slice(Math.max(0, at - 400), at);
    const binding = /const\s*\[([^\]]*)\]\s*=\s*await\s+$/.exec(before);
    const elements = splitTopLevel(source.slice(open + 1, end));
    calls.push({
      index: at,
      names: binding ? binding[1].split(",").map((name) => name.trim()).filter(Boolean) : [],
      elements: elements.map(firstPath)
    });
  }
  return calls;
}

const files = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "components"))];

test("每个 Promise.all 数据加载的绑定名与请求数一致", () => {
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const call of extractCalls(source)) {
      if (!call.names.length) continue;
      if (call.names.length !== call.elements.length) {
        failures.push(`${relative(webRoot, file)}: 绑定 ${call.names.length} 个名字 [${call.names.join(", ")}]，但有 ${call.elements.length} 个请求 [${call.elements.join(", ")}]`);
      }
    }
  }
  assert.deepEqual(failures, [], `数据绑定与请求错位：\n${failures.join("\n")}`);
});

// 主要数据加载点的接口顺序表。位置型解构一旦插入/换序，这里立刻变红，
// 迫使改动者重新核对“谁的数据写进了哪个状态”。
// 注意（本检查的边界）：顺序表只能发现“请求序列变了”，无法发现“请求序列没变但 setter 写串了”；
// 后者由下面针对采购页的 setter↔接口语义测试覆盖。
const LOAD_ORDER = {
  // 2026-09-14 拆分后，原采购页一次性加载的 9 个接口拆成两个子页各自的位置型解构：
  // orders = 采购单与主数据；inbounds = 原料入库、应付来源与应付台账。
  //
  // 2026-09-27：采购单页**瘦身**之后只剩一个接口（`/purchase-orders`，不再是位置型解构），
  // 所以从这张表里移除 —— 一个接口没有"错位"可言。它原来的四种主数据加载随草稿工作区
  // 一起搬到了采购计划页（下一行），绑定表也跟着搬。
  "app/procurement/plans/page.tsx": ["/purchase-plans", "/purchase-plans/candidates", "/materials", "/units"],
  "app/procurement/inbounds/page.tsx": ["/raw-material-inbounds", "/payable-sources", "/finance/payable-entries"],
  // 来料质检已迁到质检模块的独立面板：到货批次 → 质检记录 → 原料入库 → 入库通知，
  // 位置型解构错位在采购页不再可见，所以绑定表跟着搬到这个文件。
  "components/qc/incoming-inspections-panel.tsx": ["/purchase-orders", "/incoming-inspections", "/raw-material-inbounds", "/raw-material-inbound-notices"],
  // 生产页新增 /materials：BOM 表现在采购与生产共用同一套编辑工作区，生产侧需要物料池做明细下拉。
  "app/production/page.tsx": ["/sales-orders?status=confirmed", "/production/locations", "/production/operations", "/production/orders", "/units", "/materials"],
  // 仓库枢纽页已改为纯导航页（只单发一次 /raw-material-inbound-notices，没有位置型解构），
  // 原来的多接口加载分别落在 production/material-issues 与 warehouse/raw-material-storage 上，见上下两行。
  "app/warehouse/raw-material-storage/page.tsx": ["/materials", "/units", "/incoming-inspections", "/raw-material-inbounds"],
  // 2026-09-30：销售页拆成三个二级页之后，原来这一行（三个接口的位置型解构）不存在了 ——
  // 客户池与销售单各自一页、各发一个请求（单请求没有"错位"可言），成品总览另有一页。
  // 与上面采购单页瘦身时同样的处理：从这张表里移除，而不是留一行指向一个不存在的解构。
  "app/production/material-issues/page.tsx": ["/production/material-movements", "/production/orders"]
};

test("主要数据加载页的接口顺序与绑定表一致（防止插入/换序导致整体错位）", () => {
  const failures = [];
  for (const [relativePath, expected] of Object.entries(LOAD_ORDER)) {
    const source = readFileSync(join(webRoot, relativePath), "utf8");
    const call = extractCalls(source).sort((left, right) => right.elements.length - left.elements.length)[0];
    if (!call || !call.names.length) { failures.push(`${relativePath}: 未找到带绑定的 Promise.all 数据加载`); continue; }
    const actual = call.elements;
    if (actual.length !== expected.length || actual.some((endpoint, index) => !endpoint.startsWith(expected[index]))) {
      failures.push(`${relativePath}: 接口顺序已变化\n  期望 [${expected.join(", ")}]\n  实际 [${actual.join(", ")}]`);
    }
  }
  assert.deepEqual(failures, [], `数据加载顺序漂移：\n${failures.join("\n")}`);
});

// 采购字段语义表：每个 setter 必须绑定到它真正对应的接口。
// 位置型解构一旦错位（即使请求数不变），这里立刻变红。
// 2026-09-14 拆分后按子页分表：orders 管采购单与主数据，inbounds 管入库与应付。
// 2026-09-27：orders 只剩一个接口（不再是位置型解构），主数据那四条落到采购计划页。
const PROCUREMENT_BINDINGS = {
  "app/procurement/plans/page.tsx": {
    setRows: "/purchase-plans",
    setCandidates: "/purchase-plans/candidates",
    setMaterials: "/materials",
    setUnits: "/units"
  },
  "app/procurement/inbounds/page.tsx": {
    setInbounds: "/raw-material-inbounds",
    setPayables: "/payable-sources",
    setPayableEntries: "/finance/payable-entries"
  }
};

test("采购子页每个状态 setter 绑定到对应接口（单位取 /units、销售单取 /sales-orders）", () => {
  for (const [relativePath, bindings] of Object.entries(PROCUREMENT_BINDINGS)) {
    const source = readFileSync(join(webRoot, relativePath), "utf8");
    const call = extractCalls(source).sort((left, right) => right.elements.length - left.elements.length)[0];
    assert.ok(call && call.names.length, `${relativePath} 未找到带绑定的 Promise.all 数据加载`);
    assert.equal(call.names.length, call.elements.length, `${relativePath} 绑定名与请求数不一致`);

    const masked = maskStrings(source);
    const resolved = call.names.map((name, index) => {
      // `\\(?` 允许 `setRows((plans.data ?? []).map(...))` 这种写法：2026-09-27 采购计划页
      // 要在写进状态前补一个字段别名（`updated_by_name`），所以状态 setter 的第一个参数不是
      // 光秃秃的 `xxx.data`。断言的本意是"这个响应**被用到了**"，不是"它必须以哪种括号形态出现"。
      const setter = new RegExp(`(set[A-Za-z0-9_]+)\\(\\s*\\(?\\s*${name}\\.data`).exec(masked);
      return { name, setter: setter ? setter[1] : null, endpoint: call.elements[index] };
    });

    const missing = resolved.filter((row) => !row.setter);
    assert.deepEqual(missing.map((row) => row.name), [], `${relativePath}: 以下响应没有写入任何状态，页面拿不到数据：${missing.map((row) => row.name).join(", ")}`);

    // 与上面那张表同一条匹配规则：**按前缀**比。
    // 2026-09-27 收紧过一次又放开：采购计划页的第一个请求带查询串
    // （`/purchase-plans${suffix}` —— 筛选条件拼出来的），要求逐字相等就只能把 `${suffix}`
    // 抄进绑定表，那样的断言盯的是"字符串长什么样"而不是"哪个 setter 拿了哪个接口"。
    // 两张表用同一条规则，也免得以后有人只改一张。
    const mismatched = resolved.filter((row) => typeof bindings[row.setter] !== "string" || !row.endpoint.startsWith(bindings[row.setter]));
    assert.deepEqual(
      mismatched.map((row) => `${row.name} → ${row.setter} 却绑定 ${row.endpoint}（应为 ${bindings[row.setter] ?? "未知 setter"}）`),
      [],
      `${relativePath} 状态与接口错位`
    );

    const covered = new Set(resolved.map((row) => row.setter));
    const uncovered = Object.keys(bindings).filter((setter) => !covered.has(setter));
    assert.deepEqual(uncovered, [], `${relativePath} 缺少必须加载的数据：${uncovered.join(", ")}`);
  }
});
