#!/usr/bin/env node
// 一次 run 的回放入口：把事件表里「模型实际传了什么」打出来。
//
// 为什么需要它：工具入参只存在于 `tool_args` 事件（R-5），没有它就只能靠猜
// ——「口径进不去」和「参数传错了」在界面上长得一模一样。
//
// 只读：两条 SELECT，不写库、不改 run 状态。连接串优先 AGENT_READ_DATABASE_URL。
// 用法：
//   node scripts/agent-run-replay.mjs                  # 列最近 5 个 run
//   node scripts/agent-run-replay.mjs <run_id>         # 还原一次 run 的工具轨迹
import { pathToFileURL } from "node:url";

const PLACEHOLDER = "?";
const NO_ARGS_NOTE = "（该 run 没有入参记录：可能是 tool_args 事件落地之前的 run）";

function formatArgs(args) {
  if (!args || typeof args !== "object") return `(${PLACEHOLDER})`;
  const keys = Object.keys(args);
  if (keys.length === 0) return `(${PLACEHOLDER})`;
  return keys.map((key) => `${key}=${String(args[key])}`).join(" ");
}

/** 纯函数：事件行 → 可读文本行。不连库，便于单测。 */
export function summarizeRunEvents(events) {
  const lines = [];
  for (const event of events ?? []) {
    const seq = event?.seq ?? PLACEHOLDER;
    const type = event?.type ?? PLACEHOLDER;
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    if (type === "tool_args") {
      lines.push(`#${seq} tool_args ${payload.operation ?? PLACEHOLDER} ${formatArgs(payload.args)}`);
    } else if (type === "tool_status") {
      const code = payload.code ? ` code=${payload.code}` : "";
      lines.push(`#${seq} tool_status ${payload.operation ?? PLACEHOLDER} ${payload.status ?? PLACEHOLDER}${code}`);
    } else if (type === "error") {
      lines.push(`#${seq} error ${payload.code ?? PLACEHOLDER} ${payload.message ?? ""}`.trimEnd());
    } else {
      lines.push(`#${seq} ${type}`);
    }
  }
  if (!lines.some((line) => line.includes("tool_args"))) lines.unshift(NO_ARGS_NOTE);
  return lines;
}

async function main() {
  const databaseUrl = process.env.AGENT_READ_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("缺少连接串：需要 AGENT_READ_DATABASE_URL 或 DATABASE_URL");
    process.exit(2);
  }
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const runId = process.argv[2];
  try {
    if (!runId) {
      const runs = await prisma.agentRun.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, state: true, errorCode: true, createdAt: true },
      });
      for (const run of runs) console.log(`${run.id}  ${run.state}  ${run.errorCode ?? "-"}  ${run.createdAt.toISOString()}`);
      if (runs.length === 0) console.log("（还没有任何 run）");
      return;
    }
    const events = await prisma.agentRunEvent.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true, payload: true },
    });
    for (const line of summarizeRunEvents(events)) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
