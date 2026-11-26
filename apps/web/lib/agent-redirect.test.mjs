import assert from "node:assert/strict";
import { test } from "node:test";
import config from "../next.config.ts";

const RULE = { source: "/business-query/:path*", destination: "/agent", permanent: true };

test("旧顾问路径永久重定向到 /agent", async () => {
  assert.deepEqual(await config.redirects?.(), [RULE]);
});

test("重定向不碰接口代理", async () => {
  const rules = (await config.redirects?.()) ?? [];
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.equal(rule.source.startsWith("/api"), false, rule.source);
});
