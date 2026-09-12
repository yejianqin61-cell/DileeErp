// 生产领料单入口回归检查。
//
// 背景：领料单创建能力此前只挂在仓库页，生产模块（尤其是具体生产单页面）没有任何入口，
// 用户在"生产单 → 需要领料"的自然路径上找不到新建按钮。
// 该检查固化：生产单详情页必须挂载领料面板，且面板必须复用既有领料接口与过账/冲销链路。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const detailPagePath = fileURLToPath(new URL("../components/production/production-order-detail-page.tsx", import.meta.url));
const panelPath = fileURLToPath(new URL("../components/production/material-issues-panel.tsx", import.meta.url));
const detailPage = readFileSync(detailPagePath, "utf8");
const panel = readFileSync(panelPath, "utf8");

test("生产单详情页挂载领料面板并把生产单与 BOM 传下去", () => {
  assert.match(detailPage, /import \{ MaterialIssuesPanel \} from "\.\/material-issues-panel"/);
  assert.match(detailPage, /<MaterialIssuesPanel[\s\S]*?productionOrderId=\{order\.id\}/);
  assert.match(detailPage, /<MaterialIssuesPanel[\s\S]*?bomId=\{order\.bomId \?\? order\.bom\?\.id \?\? null\}/);
});

test("只有生产中(in_progress)的厂内生产单可领料", () => {
  assert.match(detailPage, /issuable=\{order\.executionMode === "in_house" && order\.status === "in_progress"\}/);
  assert.match(panel, /只有「生产中」的厂内生产单可以领料/);
});

test("领料面板复用既有领料接口而非另起一套", () => {
  assert.match(panel, /apiPost<Preview>\("\/production\/material-movements\/issue-preview"/);
  assert.match(panel, /apiPost<\{ id: string \}>\("\/production\/material-movements"/);
  assert.match(panel, /apiPatch\(`\/production\/material-movements\/\$\{draft\.id\}`/);
  // 面板同时列出领料单与补料单：过账必须按单据类型选 /post 或 /post-replenishment。
  assert.match(panel, /postMovementPath\(movement\.documentType, movement\.id\)/);
  assert.match(panel, /postMovementPath\(documentType, id\)/);
  assert.doesNotMatch(panel, /material-movements\/\$\{(?:movement\.id|id)\}\/post`/);
  assert.match(panel, /\/reopen`, \{ reason/);
  assert.match(panel, /\/reverse`, \{ reason/);
});

test("面板提供补料单入口并把每行备注带进草稿", () => {
  assert.match(panel, /movementEditorHref\("replenishment", \{ productionOrderId \}\)/);
  assert.match(panel, /remark: line\.remark \?\? ""/, "编辑草稿必须带出每行备注，否则 PATCH 会清掉");
});

test("先保存草稿再出库，避免保存成功但过账失败时重复建单", () => {
  assert.match(panel, /const id = await saveDraft\(\)/);
  assert.match(panel, /已保存，但过账失败/);
});
