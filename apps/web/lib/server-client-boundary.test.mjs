// Server / Client 边界守卫：Server Component 不得从 `"use client"` 模块导入普通值（常量、函数）。
//
// 为什么需要单独一条：跨 RSC 边界后，从客户端模块导入的**非组件导出**在服务端拿到的是
// client reference 代理，而不是原来的数组/函数。这类错误 typecheck 通过（TS 看到真类型）、
// vitest 通过（不施加 client boundary），只有 `next build` 在收集页面数据时才会炸，例如：
//
//   TypeError: f.FINANCE_SECTIONS.map is not a function
//   [Error: Failed to collect page data for /finance/[section]]
//
// 前端发布链（deploy.yml / CI / Dockerfile）走的正是 `next build`，所以这条边界必须有守卫，
// 不能只靠「记得本地跑一次构建」。
//
// 判定范围（刻意保守，避免误报）：
//   * 只看 apps/web/app 下没有 `"use client"` 的文件（Server Component / route handler）；
//   * 只看具名导入（组件通常是 default 导入或 PascalCase 具名导入，允许）；
//   * 只对**全大写常量名**（如 FINANCE_SECTIONS）报警；`import type` 与内联 `type X` 会被忽略
//     （类型在编译期擦除，不会变成代理对象）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const appDir = join(webRoot, "app");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|mts)$/.test(entry) ? [full] : [];
  });
}

const isClientModule = (file) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(readFileSync(file, "utf8"));

/** 具名导入的绑定名 + 来源模块（跳过 `import type` 与内联 `type X`）。 */
function namedImports(source) {
  const found = [];
  const pattern = /import\s+(type\s+)?(?:(\w+)\s*,\s*)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1]) continue; // import type { ... }
    const names = match[3].split(",").map((entry) => entry.trim()).filter(Boolean)
      .filter((entry) => !entry.startsWith("type "))
      .map((entry) => entry.split(/\s+as\s+/).pop().trim());
    for (const name of names) found.push({ name, from: match[4] });
  }
  return found;
}

const UPPERCASE_CONSTANT = /^[A-Z][A-Z0-9_]{2,}$/;

test("Server Component 不得从 \"use client\" 模块导入全大写常量（next build 会以代理对象报错）", () => {
  const violations = [];
  for (const file of walk(appDir)) {
    const source = readFileSync(file, "utf8");
    if (isClientModule(file)) continue;
    for (const { name, from } of namedImports(source)) {
      if (!UPPERCASE_CONSTANT.test(name)) continue;
      if (!from.startsWith(".")) continue;
      const target = resolve(dirname(file), from);
      const candidates = [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts"), join(target, "index.tsx")];
      const hit = candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
      if (!hit || !isClientModule(hit)) continue;
      violations.push(`${relative(webRoot, file).replaceAll("\\", "/")} 从客户端模块 ${relative(webRoot, hit).replaceAll("\\", "/")} 导入常量 ${name}`);
    }
  }
  assert.deepEqual(violations, [], `Server/Client 边界违规（把常量移到无 "use client" 的模块）：\n${violations.join("\n")}`);
});
