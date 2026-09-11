// 导出文件名解析的回归测试：后端用 filename*=UTF-8'' 传中文名，解析错了会存成乱码文件名。
import test from "node:test";
import assert from "node:assert/strict";
import { filenameFromDisposition } from "./download.ts";

test("解析后端 UTF-8 文件名（中文）", () => {
  const header = `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-领料单.xlsx")}`;
  assert.equal(filenameFromDisposition(header, "fallback.xlsx"), "迪礼ERP-领料单.xlsx");
});

test("兼容普通 filename 与带引号形式", () => {
  assert.equal(filenameFromDisposition('attachment; filename="issue.xlsx"', "fallback.xlsx"), "issue.xlsx");
  assert.equal(filenameFromDisposition("attachment; filename=issue.xlsx", "fallback.xlsx"), "issue.xlsx");
});

test("缺失或损坏时退回默认名，不抛错", () => {
  assert.equal(filenameFromDisposition(null, "fallback.xlsx"), "fallback.xlsx");
  assert.equal(filenameFromDisposition("attachment", "fallback.xlsx"), "fallback.xlsx");
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E4%B8", "fallback.xlsx"), "fallback.xlsx");
});
