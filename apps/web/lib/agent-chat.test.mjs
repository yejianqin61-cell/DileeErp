// 「迪礼顾问」对话视图模型（lib/agent-chat.ts）的单元测试（node:test，与 lib 下其它纯函数一致）。
//
// 重点：后端两路数据（历史 run 快照 / 当前活动 run 的 reducer 状态）折叠成同一个 AgentTurn，
// 以及「活动 run 还没拿到 run_id 时也要先把用户问题画出来」这条路径。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PHASE_LABELS,
  SUGGESTED_QUESTIONS,
  canRetryTurn,
  createClientMessageId,
  isTerminalRunState,
  isTurnSettled,
  mergeTurns,
  sessionTitleFromRuns,
  turnFromActiveState,
  turnFromSnapshotRun,
  turnStatusFromPhase,
  turnStatusFromRunState,
} from "./agent-chat.ts";
import { initialBusinessQueryState, reduce } from "./business-query-state.ts";

const snapshotRun = (overrides = {}) => ({
  run_id: "r-1",
  state: "completed",
  question: "最近有哪些销售订单？",
  answer: "有 3 张。",
  sources: [{ business_type: "sales_order", business_no: "SO-001" }],
  latest_seq: 9,
  error_code: null,
  access_level: "operational",
  created_at: "2026-10-26T12:00:00.000Z",
  ...overrides,
});

test("run.state / 阶段 → 界面状态：终态三种，其余都算进行中", () => {
  assert.equal(turnStatusFromRunState("completed"), "done");
  assert.equal(turnStatusFromRunState("cancelled"), "cancelled");
  assert.equal(turnStatusFromRunState("failed"), "error");
  assert.equal(turnStatusFromRunState("responding"), "streaming");
  assert.equal(turnStatusFromRunState("unknown-future-state"), "streaming");
  assert.equal(turnStatusFromPhase("submitting"), "streaming");
  assert.equal(turnStatusFromPhase("disconnected"), "streaming");
  assert.equal(turnStatusFromPhase("done"), "done");
  assert.equal(isTerminalRunState("completed"), true);
  assert.equal(isTerminalRunState("responding"), false);
});

test("历史快照轮：答案、来源、失败原因都能还原；快照不含执行步骤", () => {
  const done = turnFromSnapshotRun(snapshotRun());
  assert.equal(done.status, "done");
  assert.equal(done.answer, "有 3 张。");
  assert.deepEqual(done.sources.map((source) => source.business_no), ["SO-001"]);
  assert.deepEqual(done.toolSteps, []);
  assert.equal(done.error, null);

  const failed = turnFromSnapshotRun(snapshotRun({ state: "failed", answer: "", error_code: "AGENT_RUN_TIMEOUT" }));
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.error, { code: "AGENT_RUN_TIMEOUT", message: "本次查询未完成" });
});

test("活动 run：submitting 阶段还没有 run_id，也要用 pending 占位把问题显示出来", () => {
  const submitting = reduce(initialBusinessQueryState, { type: "SUBMIT", question: "订单进度如何？", sessionId: "s-1" });
  const turn = turnFromActiveState(submitting);
  assert.ok(turn);
  assert.equal(turn.runId, "pending");
  assert.equal(turn.question, "订单进度如何？");
  assert.equal(turn.status, "streaming");

  const created = reduce(submitting, { type: "RUN_CREATED", runId: "r-9" });
  assert.equal(turnFromActiveState(created)?.runId, "r-9");

  assert.equal(turnFromActiveState(initialBusinessQueryState), null, "没提问过时不产生空消息");
});

test("mergeTurns：历史在前、活动在后；同 runId 用活动状态覆盖（不出现两条）", () => {
  const older = turnFromSnapshotRun(snapshotRun({ run_id: "r-1" }));
  const newer = turnFromSnapshotRun(snapshotRun({ run_id: "r-2", question: "第二个问题" }));
  const active = { ...newer, answer: "更新后的答案", status: "streaming" };

  const merged = mergeTurns([older], newer);
  assert.deepEqual(merged.map((turn) => turn.runId), ["r-1", "r-2"]);

  const replaced = mergeTurns([older, newer], active);
  assert.equal(replaced.length, 2);
  assert.equal(replaced.at(-1).answer, "更新后的答案");
  const untouched = [older];
  assert.equal(mergeTurns(untouched, null), untouched, "没有活动轮时原样返回，避免无意义的新数组");
});

test("可重试/已结束判定：失败与取消可重试，进行中不可重试", () => {
  assert.equal(canRetryTurn(turnFromSnapshotRun(snapshotRun({ state: "failed" }))), true);
  assert.equal(canRetryTurn(turnFromSnapshotRun(snapshotRun({ state: "cancelled" }))), true);
  assert.equal(canRetryTurn(turnFromSnapshotRun(snapshotRun({ state: "completed" }))), false);
  assert.equal(isTurnSettled(turnFromSnapshotRun(snapshotRun({ state: "completed" }))), true);
  assert.equal(isTurnSettled(null), true);
  assert.equal(isTurnSettled({ ...turnFromSnapshotRun(snapshotRun()), status: "streaming" }), false);
});

test("会话标题取首个非空问题并截断；空会话给出可读兜底", () => {
  assert.equal(sessionTitleFromRuns([]), "空会话");
  assert.equal(sessionTitleFromRuns([snapshotRun({ question: "   " })]), "空会话");
  assert.equal(sessionTitleFromRuns([snapshotRun({ question: "  最近有哪些\n销售订单？ " })]), "最近有哪些 销售订单？");

  const long = "帮我把这个月所有销售订单、生产任务、采购到货和库存不足的物料一起汇总一下";
  const title = sessionTitleFromRuns([snapshotRun({ question: long })]);
  assert.equal(title.endsWith("…"), true);
  assert.ok(title.length <= 29);
});

test("阶段文案与推荐问题：E2E 依赖逐字文案，不能随手改", () => {
  assert.equal(PHASE_LABELS.done, "已完成");
  assert.equal(PHASE_LABELS.cancelled, "已取消");
  assert.equal(PHASE_LABELS.disconnected, "连接中断，正在恢复…");
  assert.deepEqual([...SUGGESTED_QUESTIONS], [
    "最近有哪些销售订单？",
    "哪些生产任务即将延期？",
    "目前有哪些物料库存不足？",
    "帮我汇总本月采购情况。",
  ]);
});

test("client_message_id：始终是 v4 UUID（http 内网没有 randomUUID 时也要能生成）", () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(createClientMessageId(), uuidV4);

  // 模拟内网 http：安全上下文里才有的 randomUUID 不可用。
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis.crypto, "randomUUID");
  const original = hadOwn ? Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID") : undefined;
  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    const fallback = createClientMessageId();
    assert.match(fallback, uuidV4);
    assert.notEqual(fallback, createClientMessageId(), "两次生成的幂等键不能相同");
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
    else delete globalThis.crypto.randomUUID;
  }
});
