// 成品入库与成品存量的接线守卫（用户明确要求，且都是“看不见就会退化”的实现细节）：
// 1) 包装工序是每个生产单的收尾工序：生产单详情要能补建，并按包装累计报工量发分批入库通知；
// 2) 仓库要有成品存量管理页面（成品/次品存量、待入库通知、QC 合格待入库、入库单/出库单）；
// 3) 下游展示：生产单成品存量、工作台成品存量都要有数。
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
const qcPanel = read("components", "warehouse", "finished-goods-qc-panel.tsx");
const workbench = read("app", "workbench.tsx");
const warehousePage = read("app", "warehouse", "page.tsx");

test("仓库新增成品仓储情况页面，并从仓库首页可进入", () => {
  assert.match(warehousePage, /href="\/warehouse\/finished-goods-storage"/, "仓库首页要有成品仓储情况入口");
  assert.match(storagePage, /\/inventory\/balances\?category=finished_goods/, "存量要对成品库存事实聚合");
  assert.match(storagePage, /\/inventory\/balances\?category=defective_goods/, "次品存量同样要展示");
  assert.match(storagePage, /\/finished-goods\/inbound-notices/, "要展示待入库通知（分批）");
  assert.match(storagePage, /\/finished-goods\/qc-records\/available-inbound-sources/, "要展示质检合格待入库（用净值化接口）");
  assert.match(storagePage, /\/finished-goods\/inbounds/, "要展示成品入库单");
  assert.match(storagePage, /\/finished-goods\/outbounds/, "要展示成品出库单");
  assert.match(storagePage, /\/finished-goods\/inbounds\/\$\{row\.original\.id\}\/post/, "成品入库要能过账");
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

test("次品链路在页面里有入口（否则次品存量永远为 0）", () => {
  assert.match(storagePage, /\/finished-goods\/defectives\$\{scope\}/, "要拉取次品记录列表");
  assert.match(storagePage, /label: "本次登记次品数量"/, "要有登记次品入口");
  assert.match(storagePage, /available_for_defective_quantity/, "默认值取净值可登记次品量");
  assert.match(storagePage, /\/finished-goods\/defectives\/\$\{row\.original\.id\}\/post/, "次品要能过账");
  assert.match(storagePage, /\/finished-goods\/defectives\/\$\{row\.id\}\/reverse/, "次品要能冲销");
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

test("工作台成品库存卡片展示成品存量与待入库", () => {
  assert.match(workbench, /成品存量 \{summary\.stock_quantity\}/);
  assert.match(workbench, /待入库 \{summary\.pending_inbound_quantity\}/);
  assert.match(workbench, /已出库 \{summary\.outbound_quantity\}/);
  assert.match(workbench, /stock_quantity\?: string/, "工作台类型要声明成品存量字段");
});
