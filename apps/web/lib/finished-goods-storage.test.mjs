// 成品入库与成品存量的接线守卫（用户明确要求，且都是“看不见就会退化”的实现细节）：
// 1) 包装工序是每个生产单的收尾工序：生产单详情要能补建，并按包装累计报工量发分批入库通知；
// 2) 仓库要有成品存量管理页面（成品/次品存量、待入库通知、入库单/出库单）；
// 3) 质检（送检与质检、质检合格待入库、次品登记）已统一收在【质检】模块（/qc），
//    业务页面只保留入口链接，因此这些接线守卫改为对着 QC 模块断言；
// 4) 下游展示：生产单成品存量、工作台成品存量都要有数。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");
const storagePage = read("app", "warehouse", "finished-goods-storage", "page.tsx");
const productionPanel = read("components", "production", "finished-goods-panel.tsx");
const detailPage = read("components", "production", "production-order-detail-page.tsx");
const qcPanel = read("components", "qc", "finished-goods-qc-panel.tsx");
const qcInboundPanel = read("components", "qc", "qc-inbound-panel.tsx");
const incomingInspectionsPanel = read("components", "qc", "incoming-inspections-panel.tsx");
const qcPage = read("app", "qc", "page.tsx");
// 2026-09-14 拆分后：/qc 变成枢纽页，三块面板各自挂在独立子页上。
const qcIncomingPage = read("app", "qc", "incoming", "page.tsx");
const qcFinishedGoodsPage = read("app", "qc", "finished-goods", "page.tsx");
const qcInboundPage = read("app", "qc", "inbound", "page.tsx");
const workbench = read("app", "workbench.tsx");
const warehousePage = read("app", "warehouse", "page.tsx");

test("仓库新增成品仓储情况页面，并从仓库首页可进入", () => {
  assert.match(warehousePage, /href="\/warehouse\/finished-goods-storage"/, "仓库首页要有成品仓储情况入口");
  assert.match(storagePage, /\/inventory\/balances\?category=finished_goods/, "存量要对成品库存事实聚合");
  assert.match(storagePage, /\/inventory\/balances\?category=defective_goods/, "次品存量同样要展示");
  assert.match(storagePage, /\/finished-goods\/inbound-notices/, "要展示待入库通知（分批）");
  assert.match(storagePage, /\/finished-goods\/inbounds/, "要展示成品入库单");
  assert.match(storagePage, /\/finished-goods\/outbounds/, "要展示成品出库单");
  assert.match(storagePage, /\/finished-goods\/inbounds\/\$\{row\.original\.id\}\/post/, "成品入库要能过账");
});

test("质检模块（/qc）承接来料质检、成品质检与质检合格待入库，业务页面只留入口", () => {
  // 页面与导航：质检必须是全站可达的独立入口。
  assert.match(qcPage, /data-testid="page-qc"/, "质检页要有页面根钩子");
  // 2026-09-14 拆分：枢纽页只给三个子页的入口，三块面板分别由子页挂载。
  assert.match(qcPage, /href="\/qc\/incoming"/, "枢纽页要到来料质检的入口");
  assert.match(qcPage, /href="\/qc\/finished-goods"/, "枢纽页要到成品质检的入口");
  assert.match(qcPage, /href="\/qc\/inbound"/, "枢纽页要到质检合格待入库/次品登记的入口");
  assert.match(qcIncomingPage, /IncomingInspectionsPanel/, "来料质检子页要挂载来料质检");
  assert.match(qcFinishedGoodsPage, /FinishedGoodsQcPanel/, "成品质检子页要挂载成品质检");
  assert.match(qcInboundPage, /QcInboundPanel/, "待入库子页要挂载质检合格待入库/次品登记");
  const appShell = read("components", "layout", "app-shell.tsx");
  assert.match(appShell, /\["质检", "\/qc"/, "主导航要有质检 tab");
  // 原页面不得再各自实现一套质检，只能给跳转入口。
  assert.match(storagePage, /href="\/qc"/, "成品仓储页要给出质检模块入口");
  assert.match(warehousePage, /href="\/qc"/, "仓库页要给出质检模块入口");
  // 采购侧的质检入口与批次深链随草稿工作区一起搬到了 orders 子页。
  const procurementOrdersPage = read("app", "procurement", "orders", "page.tsx");
  assert.match(procurementOrdersPage, /href="\/qc/, "采购页要给出质检模块入口");
  assert.match(procurementOrdersPage, /\/qc\/incoming\?receipt_id=\$\{receipt!\.id\}/, "采购批次要能带批次深链到质检");
  assert.equal(/incoming-inspections", ?\{ purchase_receipt_id/.test(procurementOrdersPage), false, "采购页不得再自己登记质检");
});

test("质检合格待入库与次品登记用净值化接口，并保留次品过账/冲销入口", () => {
  assert.match(qcInboundPanel, /\/finished-goods\/qc-records\/available-inbound-sources/, "要展示质检合格待入库（用净值化接口）");
  assert.match(qcInboundPanel, /\/finished-goods\/defectives"/, "要拉取次品记录列表");
  assert.match(qcInboundPanel, /label: "本次登记次品数量"/, "要有登记次品入口");
  assert.match(qcInboundPanel, /available_for_defective_quantity/, "默认值取净值可登记次品量");
  assert.match(qcInboundPanel, /\/finished-goods\/defectives\/\$\{row\.original\.id\}\/post/, "次品要能过账");
  assert.match(qcInboundPanel, /\/finished-goods\/defectives\/\$\{row\.id\}\/reverse/, "次品要能冲销");
  assert.match(qcInboundPanel, /\/finished-goods\/inbounds/, "要能按 QC 合格量登记成品入库");
});

test("来料质检模块保留送检、判定、通知入库与退货的完整入口", () => {
  for (const [pattern, label] of [
    [/apiPost\("\/incoming-inspections"/, "送检登记"],
    [/\/incoming-inspections\/\$\{item\.id\}`/, "质检编辑"],
    [/\/incoming-inspections\/\$\{item\.id\}\/status/, "判定流转"],
    [/\/incoming-inspections\/\$\{item\.id\}\/return/, "整批退货"],
    [/\/raw-material-inbound-notices", \{ inspection_id/, "通知入库"],
    [/\/raw-material-inbounds"/, "按质检结果建原料入库草稿"],
  ]) assert.match(incomingInspectionsPanel, pattern, `来料质检缺少「${label}」`);
});

test("成品仓储页面注册焦点/可见性刷新并提供刷新按钮", () => {
  assert.match(storagePage, /shouldRefreshOnVisibility/, "使用统一的刷新判定");
  assert.match(storagePage, /addEventListener\("focus"/, "注册窗口焦点刷新");
  assert.match(storagePage, /addEventListener\("visibilitychange"/, "注册可见性刷新");
  assert.match(storagePage, /removeEventListener\("focus"/, "必须解绑事件");
  assert.match(storagePage, />刷新<\/Button>/, "缺少刷新按钮");
});

test("成品仓储页面状态显示中文，不暴露英文原值", () => {
  assert.match(storagePage, /draft: "待入库登记"/);
  assert.match(storagePage, /posted: "入库成功"/);
  assert.match(storagePage, /reversed: "已冲销"/);
  assert.match(storagePage, /partially_inbound: "入库中"/);
});

test("次品存量在仓储页展示，次品单据链路由质检模块负责", () => {
  assert.match(storagePage, /category=defective_goods/, "次品存量仍要在仓储页可见");
  assert.match(qcInboundPanel, /\/finished-goods\/defectives"/, "次品记录在质检模块拉取");
});

test("待入库通知按剩余工作量统计，而不是按状态（草稿送检不算完成）", () => {
  assert.match(storagePage, /pendingNoticeCount/, "要有独立的待入库计数");
  // 用「可送检额度 > 0 或在途入库 > 0」判断：QC 不合格部分永远不会入库，按通知量减已入库会永久算成待办。
  assert.match(storagePage, /number\(row\.availableSubmissionQuantity\) > 0 \|\| number\(row\.inboundDraftQuantity\) > 0/, "按可送检额度/在途入库判断待办");
  assert.equal(/status !== "completed" && row\.status !== "cancelled"/.test(storagePage), false, "不能再用“状态不是已完成”来统计待入库");
});

test("生产单详情挂载成品存量与入库通知面板，并支持补建包装工序", () => {
  assert.match(detailPage, /<FinishedGoodsPanel productionOrderId=\{order\.id\}/, "生产单详情必须挂载成品面板");
  assert.match(productionPanel, /\/production\/orders\/\$\{productionOrderId\}\/finished-goods-summary/, "面板要读生产单成品存量汇总");
  assert.match(productionPanel, /\/production\/orders\/\$\{productionOrderId\}\/packaging-operation/, "缺包装工序时要能补建");
  assert.match(productionPanel, /补建包装工序/, "无包装工序时给出明确入口");
  assert.match(productionPanel, /\/production\/finished-goods-inbound-notices/, "要能发成品入库通知");
  assert.match(productionPanel, /defaultValue: summary\.available_notice_quantity/, "通知数量默认取可通知量（包装累计 − 已通知）");
  assert.match(productionPanel, /\/cancel/, "未送检的通知要能取消");
  // 已有送检记录的通知后端会拒绝取消，界面不应给出必然失败的按钮。
  assert.match(productionPanel, /Number\(row\.original\.submittedQuantity \?\? 0\) > 0 \? null/, "已有送检量时不给取消按钮");
});

test("成品面板展示包装报工、已通知、可通知、送检/QC/入库与存量", () => {
  for (const label of ["包装累计报工", "已通知入库", "可通知入库", "已送检", "QC 合格", "在途入库", "已入库", "成品存量", "次品存量"]) {
    assert.match(productionPanel, new RegExp(label), `成品面板缺少「${label}」`);
  }
  assert.match(productionPanel, /executionMode === "in_house"/, "只有厂内生产单才发入库通知");
});

test("质检来源改为成品入库通知（含批次/包装工序列）", () => {
  assert.match(qcPanel, /"finished_goods_inbound_notice" \? "成品入库通知"/, "来源标签要包含入库通知");
  assert.match(qcPanel, /header: "入库通知\/批次"/, "送检来源要能看清是哪个通知/批次");
  assert.match(qcPanel, /header: "包装工序"/, "送检来源要显示包装工序");
});

test("质检记录更正：后端早有 correct 接口，前端必须有入口（且按后端同一条件门控）", () => {
  assert.match(qcPanel, /\/finished-goods\/qc-records\/\$\{row\.qc_id\}\/correct/, "质检记录要能更正");
  assert.match(qcPanel, /available_for_correction === false/, "已有入库/次品事实的记录不给更正按钮（后端也会拒）");
  assert.match(qcPanel, /更正原因/, "更正必须填写原因（后端 CorrectQcDto.reason 必填）");
});

test("工作台成品库存卡片展示成品存量与待入库", () => {
  assert.match(workbench, /成品存量 \{summary\.stock_quantity\}/);
  assert.match(workbench, /待入库 \{summary\.pending_inbound_quantity\}/);
  assert.match(workbench, /已出库 \{summary\.outbound_quantity\}/);
  assert.match(workbench, /stock_quantity\?: string/, "工作台类型要声明成品存量字段");
});
