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

// 采购页字段语义表：每个 setter 必须绑定到它真正对应的接口。
// 位置型解构一旦错位，这里立刻变红（setter 与接口顺序不匹配）。
const PROCUREMENT_BINDINGS = {
  setOrders: "/purchase-orders",
  setInspections: "/incoming-inspections",
  setInbounds: "/raw-material-inbounds",
  setPayables: "/payable-sources",
  setInboundNotices: "/raw-material-inbound-notices",
  setMaterials: "/materials",
  setUnits: "/units",
  setSuppliers: "/suppliers",
  setBoms: "/boms",
  setSalesOrders: "/sales-orders"
};

test("采购页每个状态 setter 绑定到对应接口（单位取 /units、销售单取 /sales-orders）", () => {
  const source = readFileSync(join(webRoot, "app", "procurement", "page.tsx"), "utf8");
  const call = extractCalls(source).find((candidate) => candidate.elements.includes("/materials"));
  assert.ok(call, "采购页未找到加载 /materials 的 Promise.all 数据加载");
  assert.equal(call.names.length, call.elements.length, "采购页绑定名与请求数不一致");

  const masked = maskStrings(source);
  const resolved = call.names.map((name, index) => {
    const setter = new RegExp(`(set[A-Za-z0-9_]+)\\(\\s*${name}\\.data`).exec(masked);
    return { name, setter: setter ? setter[1] : null, endpoint: call.elements[index] };
  });

  const missing = resolved.filter((row) => !row.setter);
  assert.deepEqual(missing.map((row) => row.name), [], `以下响应没有写入任何状态，页面拿不到数据：${missing.map((row) => row.name).join(", ")}`);

  const mismatched = resolved.filter((row) => PROCUREMENT_BINDINGS[row.setter] !== row.endpoint);
  assert.deepEqual(
    mismatched.map((row) => `${row.name} → ${row.setter} 却绑定 ${row.endpoint}（应为 ${PROCUREMENT_BINDINGS[row.setter] ?? "未知 setter"}）`),
    [],
    "采购页状态与接口错位"
  );

  const covered = new Set(resolved.map((row) => row.setter));
  const uncovered = Object.keys(PROCUREMENT_BINDINGS).filter((setter) => !covered.has(setter));
  assert.deepEqual(uncovered, [], `采购页缺少必须加载的数据：${uncovered.join(", ")}`);
});
