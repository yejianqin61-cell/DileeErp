import { expect, test } from "playwright/test";

const LONG_TASK_LIMIT_MS = 100;
const END_MARK = "全文结束标记。";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

function section(index) {
  return [
    `## 第 ${index} 节 订单跟进`,
    `订单 SO-${1000 + index} 当前处于生产阶段，**包装工序**尚未收尾，采购到货按 \`PO-${index}\` 跟进，仓库按批次登记入库数量与次品数量。`.repeat(2),
    "",
    "- 裁剪已完成，按单据数量核对\n- 车缝进行中，日报按员工汇总\n- 包装未开始，等待成品检验",
    "",
    "| 货号 | 数量 | 已入库 | 状态 |\n| --- | ---: | ---: | --- |\n" + Array.from({ length: 6 }, (_, row) => `| A-${index}-${row} | ${row * 120} | ${row * 80} | 生产中 |`).join("\n"),
    "",
    "```js\nconst total = rows.reduce((sum, row) => sum + row.quantity, 0);\nconsole.log(total);\n```",
    "",
  ].join("\n");
}

function longAnswer() {
  const parts = ["$$\nS = \\sum_{i=1}^{n} q_i p_i\n$$\n", "```mermaid\ngraph LR\n  A[下单] --> B[采购]\n  B --> C[生产]\n  C --> D[入库]\n```\n"];
  for (let index = 1; parts.join("\n").length < 10_000; index += 1) parts.push(section(index));
  parts.push(END_MARK);
  return parts.join("\n");
}

function installFakeApi(answer) {
  const realFetch = window.fetch.bind(window);
  const json = (data, status = 200) => new Response(JSON.stringify({ data, meta: {} }), { status, headers: { "content-type": "application/json" } });
  window.__longTasks = [];
  window.__stream = { start: null, end: null, lengths: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });

  const events = () => new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let seq = 0;
      const send = (type, data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ seq: (seq += 1), type, data })}\n\n`));
      const pause = () => new Promise((resolve) => setTimeout(resolve, 16));
      window.__stream.start = performance.now();
      for (let offset = 0; offset < answer.length; offset += 20) {
        send("answer_delta", { text: answer.slice(offset, offset + 20) });
        await pause();
        window.__stream.lengths.push(document.querySelector('[data-testid="agent-markdown"]')?.textContent.length ?? 0);
      }
      window.__stream.end = performance.now();
      send("completed", { answer, sources: [] });
      controller.close();
    },
  });

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path === url.pathname) return realFetch(input, init);
    if (path === "/auth/me") return json({ id: "u-1", username: "perf", display_name: "性能账号", role_keys: ["qita"], surface_roles: ["qita"], surface_scope: "general", surface_sections: ["business-query"], module_keys: [] });
    if (path === "/business-query/sessions") return method === "POST" ? json({ session_id: "s-1" }, 201) : json({ sessions: [] });
    if (path === "/business-query/sessions/s-1/runs") return json({ run_id: "r-1", state: "planning" }, 202);
    if (path === "/business-query/sessions/s-1") return json({ session_id: "s-1", runs: [] });
    if (path === "/business-query/runs/r-1/events") return new Response(events(), { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `未模拟的接口 ${path}`, details: [] } }), { status: 404 });
  };
}

test("agent-long-answer.streaming_stays_responsive_and_renders_rich_blocks", async ({ page }) => {
  const answer = longAnswer();
  expect(answer.length).toBeGreaterThanOrEqual(10_000);
  await page.addInitScript(installFakeApi, answer);
  await page.goto("/agent");
  await page.getByLabel("业务问题").fill("汇总全部订单进度");
  await page.getByLabel("业务问题").press("Enter");

  await expect(page.getByTestId("business-query-phase")).toHaveText("已完成", { timeout: 90_000 });

  const measured = await page.evaluate(() => {
    const { start, end, lengths } = window.__stream;
    const during = window.__longTasks.filter((task) => task.start >= start && task.start < end).map((task) => Math.round(task.duration));
    return { longest: Math.max(0, ...during), longTasks: during.length, streamMs: Math.round(end - start), bodyChanges: new Set(lengths.filter((length) => length > 0)).size };
  });
  console.log(`长答案实测：${answer.length} 字，流式 ${measured.streamMs} ms，长任务 ${measured.longTasks} 个，最长 ${measured.longest} ms，正文变化 ${measured.bodyChanges} 次`);
  expect(measured.bodyChanges).toBeGreaterThanOrEqual(3);
  if (process.env.AGENT_PERF_GATE === "1") expect(measured.longest).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);

  const body = page.getByTestId("agent-markdown");
  await expect(body.locator(".katex").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-diagram").locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(body.locator(".token").first()).toBeVisible();
  await expect(body).toContainText(END_MARK);
  await expect(page.getByTestId("agent-stream-caret")).toHaveCount(0);
});
