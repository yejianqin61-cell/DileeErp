// S11 前后端路由契约差集测试（静态，无需数据库与 API）。
//
// 目的：回答"前端是否存在调用不存在后端端点的调用点"（docs/test/00-recon-api-contract.md U8 未验证项），
// 并在以后任何一侧改动路径时立刻报红。
//
// 比对规则（为什么不是严格全等）：
//   前端大量使用模板字符串拼 query 或路径段，例如 `/alerts${query}`、`/reports/${tab}${query}`、
//   `/production/material-movements/${id}/${type === ... ? "/post" : "/post-return"}`。
//   逐字符扫描后：出现在「段首」的 `${...}` 视为路径参数；出现在「段内」的视为 query 拼接并截断。
//   最终按**静态段前缀**比对：前端调用的静态段必须是某条后端路由静态段的前缀。
//   这既能抓住"调了不存在的端点"，又不会被 query 拼接误报。
//
// 反空虚守卫：解析器一旦失效（例如源码结构变化导致一条都没匹配到），下面的最小值断言会立刻报错，
// 而不是"0 条不匹配所以通过"。
const assert = require("node:assert/strict");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const test = require("node:test");

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const API_SRC = join(repoRoot, "apps", "api", "src");
const WEB_SRC = join(repoRoot, "apps", "web");

/** 跳过构建产物与依赖目录，避免把 dist/.next 里的副本算进来。 */
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);

function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** 后端：把每个 @Controller 前缀与 @Get/@Post/... 路径拼成 /api/v1/... 路由表。 */
function collectBackendRoutes() {
  const files = walk(API_SRC, (path) => path.endsWith(".controller.ts"));
  const routes = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const classPrefix = /@Controller\(\s*["'`]([^"'`]*)["'`]?\s*\)/.exec(source)?.[1] ?? "";
    const routePattern = /@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
    let match;
    while ((match = routePattern.exec(source))) {
      const full = `/api/v1/${[classPrefix, match[2] ?? ""].filter(Boolean).join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "");
      routes.push({ full, method: match[1].toUpperCase(), source: relative(repoRoot, file) });
    }
  }
  return routes;
}

/** 前端：提取 api-client 与原生 fetch 的调用路径。 */
function collectFrontendCalls() {
  const files = walk(WEB_SRC, (path) => (path.endsWith(".ts") || path.endsWith(".tsx")) && !path.includes(".test."));
  const patterns = [
    { kind: "api-client", regex: /\bapi(?:Get|Request|Post|Patch|Delete)\s*(?:<[^>]*>)?\s*\(\s*[`"']([^`"']+)[`"']/g },
    { kind: "fetch", regex: /fetch\(\s*[`"']([^`"']+)[`"']/g },
  ];
  const calls = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { kind, regex } of patterns) {
      let match;
      while ((match = regex.exec(source))) calls.push({ kind, raw: match[1], source: relative(repoRoot, file) });
    }
  }
  return calls;
}

/**
 * 规范化：${...} 在段首 → :param；在段内 → 判定为 query 拼接并截断。
 * 同时去掉字面 query string。
 */
function normalizePath(raw) {
  const text = raw.replace(/\?[^`"']*$/, "");
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "$" && text[index + 1] === "{") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "{") depth += 1;
        else if (text[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      if (out.slice(-1) !== "/") return out.replace(/\/$/, "");
      out += ":param";
      index = cursor - 1;
      continue;
    }
    out += char;
  }
  return out.replace(/\/$/, "");
}

/** 取 /api/v1 之后的静态段（遇到第一个动态段即停）。 */
function staticSegments(full) {
  const segments = full.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const staticOnes = [];
  for (const segment of segments) {
    if (segment.startsWith(":") || segment === ":param") break;
    staticOnes.push(segment);
  }
  return staticOnes;
}

const backendRoutes = collectBackendRoutes();
const backendSegments = backendRoutes.map((route) => staticSegments(route.full));
const frontendCalls = collectFrontendCalls().map((call) => ({
  ...call,
  normalized: normalizePath(call.raw.startsWith("/api/v1") ? call.raw : `/api/v1${call.raw}`),
}));

const matchesBackend = (call) => {
  const wanted = staticSegments(call.normalized);
  if (!wanted.length) return true; // 泛化代理（api-client 自身）不参与判定
  return backendSegments.some((segments) => wanted.every((segment, index) => segments[index] === segment));
};

test("S11 route contract: every frontend call targets an existing backend route prefix", () => {
  // 反空虚：解析器必须真的读到东西，否则本测试会"0 条不匹配"地假通过
  assert.ok(backendRoutes.length >= 300, `后端路由解析异常：仅得到 ${backendRoutes.length} 条，预期 300+（源码结构可能已变化）`);
  assert.ok(frontendCalls.length >= 150, `前端调用点解析异常：仅得到 ${frontendCalls.length} 条，预期 150+`);

  const unmatched = frontendCalls.filter((call) => !matchesBackend(call));
  const unique = [...new Map(unmatched.map((call) => [call.normalized, call])).values()];
  assert.deepEqual(
    unique.map((call) => `${call.normalized}  <- ${call.source}`),
    [],
    "存在前端调用但后端没有对应路由前缀的端点（可能是路径改名、控制器被移除或前端拼错）",
  );
});

test("S11 route contract: the matcher actually rejects a bogus path", () => {
  // 反向自检：确保上面的判定不是恒真
  assert.equal(matchesBackend({ normalized: "/api/v1/customers" }), true);
  assert.equal(matchesBackend({ normalized: "/api/v1/customers/:param" }), true);
  assert.equal(matchesBackend({ normalized: "/api/v1/no-such-module/no-such-route" }), false);
  assert.equal(matchesBackend({ normalized: "/api/v1/transactional" }), false);
});

test("S11 route contract: normalizer handles the query-string builder patterns", () => {
  assert.equal(normalizePath("/api/v1/alerts${query}"), "/api/v1/alerts");
  assert.equal(normalizePath("/api/v1/hr/payroll-ledgers${suffix}"), "/api/v1/hr/payroll-ledgers");
  assert.equal(normalizePath("/api/v1/reports/${tab}${query}"), "/api/v1/reports/:param");
  assert.equal(normalizePath("/api/v1/customers/${id}"), "/api/v1/customers/:param");
  assert.equal(normalizePath("/api/v1/customers?page=1&page_size=20"), "/api/v1/customers");
  assert.equal(normalizePath("/api/v1${path}"), "/api/v1");
});

test("S11 route contract: reports the informational orphan/duplicate inventory", () => {
  const uniquePatterns = new Set(backendRoutes.map((route) => route.full));
  const duplicatePaths = backendRoutes.length - uniquePatterns.size;
  // 同一路径被多个控制器声明是允许的（例如 GET 与 POST 同址），仅作信息记录
  assert.ok(duplicatePaths >= 0);
  console.log(`[S11] backend routes=${backendRoutes.length} unique=${uniquePatterns.size} frontend call sites=${frontendCalls.length} unique=${new Set(frontendCalls.map((call) => call.normalized)).size}`);
});
