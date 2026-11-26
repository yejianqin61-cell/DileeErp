import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "./gap-experiment.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "gap-cli-"));
const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const quiet = { log: () => {} };
const questionFile = (dir, reviewedBy) => {
  const path = join(dir, "questions.json");
  writeFileSync(path, JSON.stringify({
    reviewedBy,
    reviewedAt: reviewedBy ? "2026-11-25" : null,
    questions: [{ id: "gap-01", class: "gap", question: "题", expect: "gap", nearest: "get_bom", missing: "group_by", stub: "rows" }],
  }));
  return path;
};

test("干跑真题集：270 条记录与三组指标", async () => {
  const out = join(temp(), "nested");
  assert.equal(await main(["--dry", "--out", out], {}, quiet), 0);
  assert.equal(read(out, "records.json").length, 270);
  const metrics = read(out, "metrics.json");
  assert.deepEqual(Object.keys(metrics).sort(), ["A", "B", "C", "decision"]);
  assert.equal(metrics.decision, "observe_only");
});

test("题集未审：不实跑，退出码 2，不写记录", async () => {
  const dir = temp();
  const lines = [];
  const code = await main(["--out", dir], { DEEPSEEK_API_KEY: "sk-secret" }, { questionsPath: questionFile(dir, null), log: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /题集未审，不实跑/);
  assert.equal(existsSync(join(dir, "records.json")), false);
});

test("题集已审但缺密钥：退出码 2", async () => {
  const dir = temp();
  const lines = [];
  const code = await main(["--out", dir], {}, { questionsPath: questionFile(dir, "reviewer"), log: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /缺少 DEEPSEEK_API_KEY/);
});

test("--group 与 --limit 缩小批次", async () => {
  const out = temp();
  assert.equal(await main(["--dry", "--group", "C", "--limit", "4", "--out", out], {}, quiet), 0);
  const records = read(out, "records.json");
  assert.equal(records.length, 12);
  assert.ok(records.every((record) => record.group === "C"));
});

test("单次失败记 error 并继续，且不写出密钥", async () => {
  const dir = temp();
  let calls = 0;
  const runOne = async ({ group, question, rep }) => {
    calls += 1;
    if (calls === 5) throw new Error("请求超时 sk-secret");
    return { group, id: question.id, rep, gap: null };
  };
  const code = await main(["--out", dir], { DEEPSEEK_API_KEY: "sk-secret" }, { ...quiet, questionsPath: questionFile(dir, "reviewer"), runOne, model: {} });
  assert.equal(code, 0);
  const records = read(dir, "records.json");
  assert.equal(records.length, 9);
  assert.equal(records.filter((record) => record.error).length, 1);
  assert.equal(readFileSync(join(dir, "records.json"), "utf8").includes("sk-secret"), false);
});

test("参数不合法：缺 --out 或组名未知时退出码 2", async () => {
  assert.equal(await main(["--dry"], {}, quiet), 2);
  assert.equal(await main(["--dry", "--group", "D", "--out", temp()], {}, quiet), 2);
});
