import assert from "node:assert/strict";
import test from "node:test";
import { verifyAgentDatabasePrivileges } from "./verify-agent-database-privileges.mjs";

function client({ denied = [] } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql) {
      calls.push(["read", sql]);
      if (denied.some((table) => sql.includes(`\"${table}\"`))) throw new Error("permission denied for table");
      return [{ ok: 1 }];
    },
    async $executeRawUnsafe(sql) {
      calls.push(["write", sql]);
      if (denied.some((table) => sql.includes(`\"${table}\"`))) throw new Error("permission denied for table");
      return 0;
    },
  };
}

test("权限证明只做零行写探针，并验证两组账号各自的允许与拒绝边界", async () => {
  const read = client({ denied: ["sales_orders"] });
  read.$queryRawUnsafe = async (sql) => { read.calls.push(["read", sql]); return [{ ok: 1 }]; };
  const state = client({ denied: ["sales_orders"] });

  const result = await verifyAgentDatabasePrivileges({ readClient: read, stateClient: state });

  assert.deepEqual(result, ["read business", "deny business write", "read agent state", "write agent state", "deny business read"]);
  assert.ok(read.calls.some(([kind, sql]) => kind === "write" && /WHERE FALSE/.test(sql)), "只读证明必须是零行写探针");
  assert.ok(state.calls.some(([kind, sql]) => kind === "write" && /WHERE FALSE/.test(sql)), "状态写证明必须是零行写探针");
  for (const [, sql] of [...read.calls, ...state.calls]) assert.doesNotMatch(sql, /INSERT|DELETE|DROP|ALTER/i);
});
