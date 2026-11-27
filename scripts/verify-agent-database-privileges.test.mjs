import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { verifyAgentDatabasePrivileges } from "./verify-agent-database-privileges.mjs";

// 假 client：读权限与写权限必须分开建模。
// 真实边界的核心正是「能读不能写」，用一个 denied 列表同时管两种动作会把这个区别抹掉。
function client({ readDenied = [], writeDenied = [] } = {}) {
  const calls = [];
  const hit = (patterns, sql) => patterns.some((table) => sql.includes(`"${table}"`));
  return {
    calls,
    async $queryRawUnsafe(sql) {
      calls.push(["read", sql]);
      if (hit(readDenied, sql)) throw new Error("permission denied for table");
      return [{ ok: 1 }];
    },
    async $executeRawUnsafe(sql) {
      calls.push(["write", sql]);
      if (hit(writeDenied, sql)) throw new Error("permission denied for table");
      return 0;
    },
  };
}

// 真实边界（2026-11-28 生产实测）：
//  - agent_read：可读业务表，不可写业务表，读不到 agent_* 状态表（含缺口表）；
//  - agent_state：可读写 agent_* 状态表，读业务表被拒。
const GAP_TABLES = ["agent_gap_candidates", "agent_gap_reports"];
const agentRead = ({ gapReadable = false } = {}) =>
  client({ readDenied: gapReadable ? [] : GAP_TABLES, writeDenied: ["sales_orders"] });
const agentState = ({ gapDenied = false } = {}) =>
  client({ readDenied: ["sales_orders", ...(gapDenied ? GAP_TABLES : [])], writeDenied: gapDenied ? GAP_TABLES : [] });

test("权限证明只做零行写探针，并验证两组账号各自的允许与拒绝边界", async () => {
  const read = agentRead();
  const state = agentState();

  const result = await verifyAgentDatabasePrivileges({ readClient: read, stateClient: state });

  assert.ok(result.includes("read business"));
  assert.ok(result.includes("deny business write"));
  assert.ok(result.includes("read agent state"));
  assert.ok(result.includes("write agent state"));
  assert.ok(result.includes("deny business read"));
  assert.ok(read.calls.some(([kind, sql]) => kind === "write" && /WHERE FALSE/.test(sql)), "只读证明必须是零行写探针");
  assert.ok(state.calls.some(([kind, sql]) => kind === "write" && /WHERE FALSE/.test(sql)), "状态写证明必须是零行写探针");
  for (const [, sql] of [...read.calls, ...state.calls]) assert.doesNotMatch(sql, /INSERT|DELETE|DROP|ALTER/i);
});

test("权限证明覆盖缺口候选两张表：读、零行写、且业务只读账号不得读到", async () => {
  // 背景：这两张表建成后忘了给 agent_state 授权，写入被 .catch(warn) 吞掉，
  // 线上候选永远 0 条，而这份证明因为不探它们而一路绿。漏测而绿比测出红更危险。
  const read = agentRead();
  const state = agentState();

  const result = await verifyAgentDatabasePrivileges({ readClient: read, stateClient: state });

  for (const table of GAP_TABLES) {
    assert.ok(result.includes(`read ${table}`), `必须探 ${table} 的 SELECT`);
    assert.ok(result.includes(`write ${table}`), `必须探 ${table} 的 UPDATE`);
    assert.ok(result.includes(`deny ${table} to business read`), `业务只读账号必须被拒绝读 ${table}`);
  }
  const stateSql = state.calls.map(([, sql]) => sql).join("\n");
  assert.match(stateSql, /UPDATE "agent_gap_candidates" SET "updated_at" = "updated_at" WHERE FALSE/, "缺口表写探针必须是零行写");
});

test("缺口表被拒时证明必须变红，不得静默通过", async () => {
  const read = agentRead();
  // 模拟事故现场：agent_state 对两张缺口表没有权限。
  const state = agentState({ gapDenied: true });

  await assert.rejects(
    () => verifyAgentDatabasePrivileges({ readClient: read, stateClient: state }),
    /permission denied/,
    "agent_state 读不到缺口表时必须抛错",
  );
});

test("业务只读账号意外获得缺口表读权限时也必须变红", async () => {
  // 反向越权：缺口是 Agent 状态，业务只读账号没有理由读它。
  const read = agentRead({ gapReadable: true });
  const state = agentState();

  await assert.rejects(
    () => verifyAgentDatabasePrivileges({ readClient: read, stateClient: state }),
    /database permission was unexpectedly granted/,
    "业务只读账号能读缺口表时必须抛错",
  );
});

test("授权脚本存在、幂等，且与证明脚本的表清单一致", () => {
  const script = readFileSync(new URL("./grant-agent-state-tables.sh", import.meta.url), "utf8");
  const verifier = readFileSync(new URL("./verify-agent-database-privileges.mjs", import.meta.url), "utf8");

  for (const table of GAP_TABLES) {
    assert.ok(script.includes(table), `授权脚本必须包含 ${table}`);
    assert.ok(verifier.includes(table), `权限证明必须包含 ${table}`);
  }
  assert.match(script, /GRANT SELECT, INSERT, UPDATE/, "授权语句必须显式列出三项权限");
  assert.match(script, /SET ROLE/, "授权后必须以目标角色实测一次读");
  assert.doesNotMatch(script, /GRANT ALL|SUPERUSER|CREATEROLE/, "不得授予超出读写的权限");
  assert.match(script, /information_schema\.tables/, "表不存在时必须先失败，而不是静默跳过");
});

test("授权脚本是可执行的 bash，且行尾为 LF", () => {
  const bytes = readFileSync(new URL("./grant-agent-state-tables.sh", import.meta.url));
  assert.equal(bytes[0], 0x23, "必须以 # 开头（shebang）");
  assert.ok(!bytes.includes(0x0d), "必须是 LF 行尾（CRLF 会让远端 bash 报错）");
});