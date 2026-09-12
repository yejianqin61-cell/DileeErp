// 可收纳面板状态的回归测试（生产单详情「工序与进度」可展开/收起，选择要能记住）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { panelStateFromStorage, panelStateToStorage, panelStorageKey } from "./collapsible-panel.ts";

test("折叠状态序列化成 localStorage 认得的两个值", () => {
  assert.equal(panelStateToStorage(true), "expanded");
  assert.equal(panelStateToStorage(false), "collapsed");
});

test("默认（没有记录）时不返回任何状态，交给调用方用默认展开", () => {
  for (const value of [null, undefined, "", "open", "closed", "true", "EXPANDED"]) {
    assert.equal(panelStateFromStorage(value), null, `${String(value)} 不应被当成有效状态`);
  }
});

test("读取自己写入的状态", () => {
  assert.equal(panelStateFromStorage("expanded"), "expanded");
  assert.equal(panelStateFromStorage("collapsed"), "collapsed");
});

test("存储键按面板名区分，避免不同面板互相覆盖", () => {
  assert.equal(panelStorageKey("production-order-operations"), "dilee:panel:production-order-operations");
  assert.notEqual(panelStorageKey("a"), panelStorageKey("b"));
});

test("生产单详情的「工序与进度」必须真的可收纳（含测量表格一起收起）", () => {
  const source = readFileSync(fileURLToPath(new URL("../components/production/production-order-detail-page.tsx", import.meta.url)), "utf8");
  assert.match(source, /useCollapsiblePanel\("production-order-operations"\)/, "必须使用统一的折叠状态（记住用户选择）");
  assert.match(source, /<h2>工序与进度<\/h2>[\s\S]{0,200}aria-expanded=\{operationsPanel\.open\}[\s\S]{0,200}operationsPanel\.toggle/, "标题栏要有展开/收起按钮");
  assert.match(source, /operationsPanel\.open \? "收起" : "展开"/, "按钮文案要随状态变化");
  assert.match(source, /\{operationsPanel\.open && <div className="panel-body">/, "收起时必须连内容一起隐藏（含完成率表格）");
});
