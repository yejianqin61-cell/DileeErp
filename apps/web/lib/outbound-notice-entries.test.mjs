// 成品出库通知链路的入口守卫（需求 4/6，第三批需求 1 改为分批出库）：
//   成品入库 → 销售页「通知仓库出库」 → 仓库页「生成出库单」（可按剩余量分批） → 每次过账自动生成应收，通知财务收款
// 前端入口必须是明显、可点的按钮，不能只有接口没有入口。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const salesPage = read("../app/sales/page.tsx");
const warehousePage = read("../app/warehouse/finished-goods-storage/page.tsx");
const financePage = read("../components/finance/finance-workspace.tsx");

test("销售页：打开销售单能看到成品入库/出库情况", () => {
  assert.match(salesPage, /apiGet<FinishedGoodsSummary>\(`\/sales-orders\/\$\{id\}\/finished-goods`\)/, "必须拉取销售单成品情况接口");
  assert.match(salesPage, /<h3>成品入库与出库<\/h3>/);
  assert.match(salesPage, /成品已入库 \{row\.inbound_quantity\} \/ 已出库 \{row\.outbound_quantity\}/);
  assert.match(salesPage, /可出库 \{row\.available_quantity\}/);
});

test("销售页：有「通知仓库出库」按钮（单批 + 全部可出库批次），并能取消待处理通知", () => {
  assert.match(salesPage, /apiPost<OutboundNotice\[\]>\(`\/sales-orders\/\$\{id\}\/outbound-notices`/);
  assert.match(salesPage, />通知仓库出库<\/Button>/);
  assert.match(salesPage, />通知仓库出库（全部可出库批次）<\/Button>/);
  assert.match(salesPage, /outbound-notices\/\$\{notice\.id\}\/cancel/);
  assert.match(salesPage, /outboundNoticeStatusLabels/);
});

test("仓库页：出库通知列表 + 生成出库单入口（支持分批出库）", () => {
  assert.match(warehousePage, /apiGet<OutboundNotice\[\]>\(`\/finished-goods\/outbound-notices\$\{scope\}`\)/);
  assert.match(warehousePage, /成品出库通知（销售发起）/);
  assert.match(warehousePage, /outbound-notices\/\$\{row\.id\}\/create-outbound/);
  assert.match(warehousePage, />生成出库单<\/Button>/);
  assert.match(warehousePage, /支持分批出库/, "界面要说明支持分批出库");
  assert.match(warehousePage, /已出库 \/ 剩余/, "通知行要显示已出库与剩余量");
});

test("销售页：出库通知显示已出库与剩余量（分批出库进度）", () => {
  assert.match(salesPage, /已出库 \{notice\.shipped_quantity \?\? "0"\} · 剩余 \{notice\.remaining_quantity/, "销售要能看到分批出库进度");
  assert.match(salesPage, /partially_outbound: "已部分出库"/);
});

test("仓库页：出库单能过账、取消草稿、维护发货、登记签收、冲销", () => {
  for (const path of [
    /finished-goods\/outbounds\/\$\{row\.original\.id\}\/post/,
    /finished-goods\/outbounds\/\$\{row\.id\}\/cancel/,
    /finished-goods\/outbounds\/\$\{row\.id\}\/shipping/,
    /finished-goods\/outbounds\/\$\{row\.id\}\/sign/,
    /finished-goods\/outbounds\/\$\{row\.id\}\/reverse/,
  ]) {
    assert.match(warehousePage, path, `缺少出库单操作入口：${path}`);
  }
  assert.match(warehousePage, />取消出库单<\/Button>/, "草稿出库单必须有取消入口（否则通知会永久卡死）");
  assert.match(warehousePage, /已生成应收来源，等待财务收款/, "过账提示要说明已通知财务收款");
});

test("财务页：显示待确认收款（出库过账自动生成应收草稿的提醒）", () => {
  assert.match(financePage, /待确认收款 \$\{pendingReceivables\.length\} 笔/);
  assert.match(financePage, /成品出库过账自动生成/);
});

test("财务页：每个板块可收纳折叠，并且都能进入独立子页面", () => {
  const workspace = read("../components/finance/finance-workspace.tsx");
  assert.match(workspace, /useCollapsiblePanel\(`finance-\$\{sectionKey\}`\)/);
  assert.match(workspace, /进入独立页面/, "每个板块都要有进入独立页面的入口");
  assert.match(workspace, /href=\{`\/finance\/\$\{sectionKey\}`\}/);
  const sectionPage = read("../app/finance/[section]/page.tsx");
  assert.match(sectionPage, /FINANCE_SECTIONS/, "子页面要按板块清单校验参数");
  assert.match(sectionPage, /<FinanceWorkspace only=/, "子页面只渲染一个板块");
});
