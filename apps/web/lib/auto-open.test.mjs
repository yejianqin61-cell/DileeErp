// 自动打开单据弹窗的回归测试：确认“关闭后不会被立刻重新打开”。
import test from "node:test";
import assert from "node:assert/strict";
import { shouldAutoOpenDraft } from "./auto-open.ts";

test("首次带 notice_id 进入且数据已加载时自动打开", () => {
  assert.equal(shouldAutoOpenDraft({ targetId: "notice-1", alreadyOpened: null, hasLoaded: true }), true);
});

test("关闭弹窗后不得再次自动打开（alreadyOpened 已记录该目标）", () => {
  assert.equal(shouldAutoOpenDraft({ targetId: "notice-1", alreadyOpened: "notice-1", hasLoaded: true }), false);
});

test("数据未加载完成时不打开，避免用空列表误判", () => {
  assert.equal(shouldAutoOpenDraft({ targetId: "notice-1", alreadyOpened: null, hasLoaded: false }), false);
});

test("没有目标参数时不打开", () => {
  assert.equal(shouldAutoOpenDraft({ targetId: null, alreadyOpened: null, hasLoaded: true }), false);
  assert.equal(shouldAutoOpenDraft({ targetId: "", alreadyOpened: null, hasLoaded: true }), false);
});

test("切换到另一个目标时仍可自动打开（每个目标各一次）", () => {
  assert.equal(shouldAutoOpenDraft({ targetId: "notice-2", alreadyOpened: "notice-1", hasLoaded: true }), true);
});
