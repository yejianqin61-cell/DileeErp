import { describe, expect, it } from "vitest";
import { EMPTY_BRANCHES, addBranch, ancestryOf, parentOf, selectVersion, versionsOf, visiblePath } from "../features/agent-chat/chat/branches";

const base = ["甲", "乙", "丙"];
const edited = addBranch(EMPTY_BRANCHES, "丁", "甲");
const all = [...base, "丁"];

describe("分支纯函数", () => {
  it("没有记录时是按时间排的一条直线", () => {
    expect(visiblePath(base, EMPTY_BRANCHES)).toEqual(base);
    expect(versionsOf(base, EMPTY_BRANCHES, "乙")).toEqual({ ids: ["乙"], index: 0 });
  });

  it("改第二问产生同父的新版本并选中它", () => {
    expect(visiblePath(all, edited)).toEqual(["甲", "丁"]);
    expect(versionsOf(all, edited, "丁")).toEqual({ ids: ["乙", "丁"], index: 1 });
  });

  it("切回旧版本时恢复它后面的对话", () => {
    expect(visiblePath(all, selectVersion(all, edited, "乙"))).toEqual(base);
  });

  it("父节点不可见时退回时间上的前一轮", () => {
    const state = addBranch(EMPTY_BRANCHES, "丙", "看不见");
    expect(parentOf(base, state, "丙")).toBe("乙");
    expect(visiblePath(base, state)).toEqual(base);
  });

  it("首问的新版本以根为父", () => {
    const state = addBranch(EMPTY_BRANCHES, "丁", null);
    expect(visiblePath(all, state)).toEqual(["丁"]);
    expect(versionsOf(all, state, "丁")).toEqual({ ids: ["甲", "丁"], index: 1 });
  });

  it("上下文是到父节点为止的路径，最多 200 项", () => {
    expect(ancestryOf(all, edited, "丁")).toEqual(["甲", "丁"]);
    expect(ancestryOf(all, edited, null)).toEqual([]);
    const long = Array.from({ length: 205 }, (_, index) => `r${index}`);
    const context = ancestryOf(long, EMPTY_BRANCHES, "r204");
    expect(context).toHaveLength(200);
    expect(context[0]).toBe("r5");
  });
});
