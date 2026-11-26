import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheAccessLevel, clearCachedSession, readCachedSession, writeCachedSession } from "./agent-cache.ts";
import { openAgentCacheStore } from "./agent-cache-idb.ts";

function memoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { data.delete(key); },
    async clear() { data.clear(); },
  };
}

const run = (id, patch = {}) => ({
  run_id: id,
  state: "completed",
  question: `问题 ${id}`,
  answer: `答案 ${id}`,
  sources: [],
  latest_seq: 3,
  error_code: null,
  access_level: "operational",
  created_at: "2026-11-26T01:00:00.000Z",
  ...patch,
});

test("写两条完成轮次，同一用户原样读回", async () => {
  const store = memoryStore();
  await writeCachedSession(store, "a", "s-1", [run("r-1"), run("r-2")]);
  assert.deepEqual(await readCachedSession(store, "a", "operational"), { session_id: "s-1", runs: [run("r-1"), run("r-2")] });
});

test("别的用户读不到", async () => {
  const store = memoryStore();
  await writeCachedSession(store, "a", "s-1", [run("r-1")]);
  assert.equal(await readCachedSession(store, "b", "operational"), null);
});

test("只落 operational 的终态轮次；一条不剩就删键", async () => {
  const store = memoryStore();
  const excluded = [run("r-2", { state: "responding" }), run("r-3", { access_level: "full" }), run("r-4", { access_level: "x" })];
  await writeCachedSession(store, "a", "s-1", [run("r-1"), ...excluded]);
  assert.deepEqual((await readCachedSession(store, "a", "full")).runs, [run("r-1")]);
  await writeCachedSession(store, "a", "s-1", excluded);
  assert.equal(store.data.size, 0);
});

test("读取处按当前档位过滤", async () => {
  const store = memoryStore();
  store.data.set("session:a", { v: 1, session_id: "s-1", runs: [run("r-1"), run("r-2", { access_level: "full" })] });
  assert.deepEqual((await readCachedSession(store, "a", "operational")).runs.map((item) => item.run_id), ["r-1"]);
  assert.deepEqual((await readCachedSession(store, "a", "full")).runs.map((item) => item.run_id), ["r-1", "r-2"]);
  store.data.set("session:a", { v: 1, session_id: "s-1", runs: [run("r-2", { access_level: "full" })] });
  assert.equal(await readCachedSession(store, "a", "operational"), null);
});

test("形状不对返回 null 并删键", async () => {
  const { run_id: _omitted, ...withoutId } = run("r-1");
  const broken = ["乱码", { v: 2, session_id: "s-1", runs: [run("r-1")] }, { v: 1, session_id: "s-1", runs: [withoutId] }, { v: 1, session_id: "s-1", runs: [run("r-1", { sources: null })] }];
  for (const value of broken) {
    const store = memoryStore();
    store.data.set("session:a", value);
    assert.equal(await readCachedSession(store, "a", "operational"), null, JSON.stringify(value));
    assert.equal(store.data.size, 0, JSON.stringify(value));
  }
});

test("存储全抛错时三个函数都不外抛", async () => {
  const fail = async () => { throw new Error("存储不可用"); };
  const store = { get: fail, set: fail, delete: fail, clear: fail };
  await writeCachedSession(store, "a", "s-1", [run("r-1")]);
  await writeCachedSession(store, "a", "s-1", []);
  await clearCachedSession(store, "a");
  assert.equal(await readCachedSession(store, "a", "operational"), null);
});

test("无 indexedDB 时没有存储；角色到档位", () => {
  assert.equal(openAgentCacheStore(), null);
  assert.equal(cacheAccessLevel(["caiwu"]), "full");
  assert.equal(cacheAccessLevel(["qita", "laoban"]), "full");
  assert.equal(cacheAccessLevel(["administrator"]), "operational");
  assert.equal(cacheAccessLevel([]), "operational");
});
