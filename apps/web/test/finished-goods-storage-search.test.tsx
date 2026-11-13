// 成品仓储情况（app/warehouse/finished-goods-storage/page.tsx）的关键字搜索（2026-11-13）。
//
// 用户：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上搜索功能。
// 因为现在单子多了，查找比较麻烦。」
//
// 这一页有六张表（成品存量 / 次品存量 / 待入库通知 / 成品入库单 / 成品出库通知 / 成品出库单），
// 本文件钉住：
//   1) **一个**搜索词同时过滤六张表（仓库找的是「这一单 / 这个成品的库存与单据」，不该搜六遍）；
//   2) 每个面板给出「筛选后 N / M」计数，清空查询后计数消失；
//   3) 只按屏幕上看得见的列匹配，且状态按**中文**匹配（搜「待入库登记」命中 draft 行）；
//   4) 成品存量按订单号收束成一行 —— 成品名只在展开行里，搜成品名仍要能命中它所在的订单；
//   5) 每张表的空态区分「没有匹配“xx”」与「本来就空」；
//   6) 关键字是**本地过滤**（不发请求），与原有的服务端订单号筛选（order_no 重新取数）互不干扰。
//
// 注意：globals: false，vitest API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinishedGoodsStoragePage from "../app/warehouse/finished-goods-storage/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/* ----------------------------------------------------------------- 桩数据 */

/** 库存事实余额（/inventory/balances 的一行）。 */
const balance = (orderNo: string, productName: string, specification: string, quantity: string, category: string) => ({
  category, unit_id: "unit-1", production_order_id: `po-${orderNo}`, order_no: orderNo,
  product_name: productName, product_specification: specification, quantity,
});

const finished = [
  balance("SO-1", "连衣裙", "M", "10", "finished_goods"),
  balance("SO-2", "衬衫", "L", "20", "finished_goods"),
];
const defective = [
  balance("SO-1", "连衣裙", "M", "2", "defective_goods"),
  balance("SO-2", "衬衫", "L", "1", "defective_goods"),
];

/** 待入库通知（分批）：两单各一条。 */
const notice = (orderNo: string, noticeNo: string) => ({
  id: `n-${noticeNo}`, noticeNo, orderNo, batchNo: `B-${noticeNo}`, noticeDate: "2026-01-01T00:00:00.000Z",
  status: "pending", noticeQuantity: "20", submittedQuantity: "0", qcQualifiedQuantity: "0", inboundDraftQuantity: "0",
  inboundPostedQuantity: "0", availableSubmissionQuantity: "20", remainingForInbound: "20",
  operationNameSnapshot: "包装", unitNameSnapshot: "件",
});
const notices = [notice("SO-1", "FGI-1"), notice("SO-2", "FGI-2")];

/** 成品入库单：SO-1 还是草稿（屏幕上显示「待入库登记」），SO-2 已过账。 */
const inbound = (orderNo: string, inboundNo: string, status: string, productName: string) => ({
  id: `ib-${inboundNo}`, inboundNo, orderNo, quantity: "10", status, productNameSnapshot: productName,
});
const inbounds = [inbound("SO-1", "FGB-1", "draft", "连衣裙"), inbound("SO-2", "FGB-2", "posted", "衬衫")];

/** 成品出库通知（销售发起）。 */
const outboundNotice = (orderNo: string, noticeNo: string, productName: string, specification: string) => ({
  id: `on-${noticeNo}`, noticeNo, orderNo, productionOrderId: `po-${orderNo}`,
  productNameSnapshot: productName, productSpecificationSnapshot: specification,
  noticeQuantity: "5", shippedQuantity: "0", remaining_quantity: "5", status: "pending",
  notifiedAt: "2026-01-02T00:00:00.000Z", outbound_summary: "", unit: { name: "件" },
  salesOrder: { customer: { name: "客户A" } },
});
const outboundNotices = [outboundNotice("SO-1", "OGN-1", "连衣裙", "M"), outboundNotice("SO-2", "OGN-2", "衬衫", "L")];

/** 成品出库单。 */
const outbound = (orderNo: string, outboundNo: string, productName: string) => ({
  id: `ob-${outboundNo}`, outboundNo, orderNo, quantity: "5", status: "draft", productNameSnapshot: productName,
  unit: { name: "件" },
  salesOrder: { currency: "USD", unitPrice: "10", settlementUnitPrice: null, customer: { name: "客户A" } },
  outboundNotice: { id: "on-OGN-1", noticeNo: "OGN-1", status: "outbound_created" },
});
const outbounds = [outbound("SO-1", "FGO-1", "连衣裙"), outbound("SO-2", "FGO-2", "衬衫")];

/**
 * 六个接口全部打桩。判断顺序有讲究：`/finished-goods/outbounds` 与 `/finished-goods/outbound-notices`
 * 是前缀关系，先判更长的那个，否则出库通知会被出库单的桩抢走。
 */
function stubPage(): StubbedCall[] {
  return stubApi((url, call) => {
    if (url.includes("/inventory/balances") && url.includes("category=finished_goods")) return apiOk(finished);
    if (url.includes("/inventory/balances") && url.includes("category=defective_goods")) return apiOk(defective);
    if (url.includes("/finished-goods/inbound-notices")) return apiOk(notices);
    if (url.includes("/finished-goods/inbounds")) return apiOk(inbounds);
    if (url.includes("/finished-goods/outbound-notices")) return apiOk(outboundNotices);
    if (url.includes("/finished-goods/outbounds")) return apiOk(outbounds);
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

async function renderPage() {
  const calls = stubPage();
  render(<><Toaster /><FinishedGoodsStoragePage /></>);
  // 六张表都渲染完（最后一张是「成品出库单」）
  await screen.findByRole("heading", { name: "成品出库单" });
  return calls;
}

const search = () => screen.getByTestId<HTMLInputElement>("finished-goods-search");

describe("成品仓储情况 · 关键字搜索：一个词过滤六张表", () => {
  it("输入订单号：六张表一起收窄，每个面板给出「筛选后 N / M」", async () => {
    await renderPage();
    // 两个订单在六张表里各出现一次：成品存量（收束行）/ 次品 / 待入库通知 / 入库单 / 出库通知 / 出库单
    expect(screen.getAllByText("SO-2")).toHaveLength(6);

    await userEvent.type(search(), "SO-1");

    expect(screen.queryAllByText("SO-2")).toHaveLength(0);
    expect(screen.getAllByText("SO-1")).toHaveLength(6);
    expect(screen.getByTestId("finished-goods-search-count-stock")).toHaveTextContent("成品 筛选后 1 / 2 条 · 次品 筛选后 1 / 2 条");
    expect(screen.getByTestId("finished-goods-search-count-notices")).toHaveTextContent("筛选后 1 / 2 条");
    expect(screen.getByTestId("finished-goods-search-count-inbounds")).toHaveTextContent("筛选后 1 / 2 条");
    expect(screen.getByTestId("finished-goods-search-count-outbound-notices")).toHaveTextContent("筛选后 1 / 2 条");
    expect(screen.getByTestId("finished-goods-search-count-outbounds")).toHaveTextContent("筛选后 1 / 2 条");
  });

  it("搜成品名：收束行上没有这几个字，也要命中它所在的订单（成品名只在展开行里）", async () => {
    await renderPage();

    // 「衬衫」只出现在 SO-2 的那些行上；成品存量表默认是**收起**的，屏幕上根本没有这三个字
    await userEvent.type(search(), "衬衫");

    expect(screen.queryAllByText("SO-1")).toHaveLength(0);
    // 5 = 成品存量（收束行，靠组内批次的成品名命中）/ 次品 / 入库单 / 出库通知 / 出库单。
    // 「待入库通知」那张表**没有成品列**（屏幕上看不到产品名），所以它匹配不到 ——
    // 这是「只按看得见的列匹配」的必然结果，不是漏了一张表：那张表的可见列是
    // 单号 / 订单号 / 批次 / 包装工序 / 日期 / 数量 / 状态，按订单号或单号能搜到它。
    expect(screen.getAllByText("SO-2")).toHaveLength(5);
    expect(screen.getByTestId("finished-goods-search-count-notices")).toHaveTextContent("筛选后 0 / 2 条");
    expect(screen.getByTestId("finished-goods-search-count-stock")).toHaveTextContent("成品 筛选后 1 / 2 条 · 次品 筛选后 1 / 2 条");
  });

  it("状态按屏幕上的中文匹配：搜「待入库登记」命中 draft 的入库单，不需要输入 draft", async () => {
    await renderPage();

    await userEvent.type(search(), "待入库登记");

    expect(screen.getByTestId("finished-goods-search-count-inbounds")).toHaveTextContent("筛选后 1 / 2 条");
    expect(screen.getByText("FGB-1")).toBeVisible();
    expect(screen.queryByText("FGB-2")).toBeNull();
  });

  it("没有匹配：六张表都说「没有匹配“xx”」，而不是「暂无」", async () => {
    await renderPage();

    await userEvent.type(search(), "查无此单");

    expect(screen.getAllByText(/没有匹配“查无此单”/)).toHaveLength(6);
    // 「本来就空」那几句必须消失：否则用户分不清是搜不到还是没有数据
    for (const emptyTitle of ["暂无成品存量", "暂无次品存量", "暂无入库通知", "暂无成品入库单", "暂无出库通知", "暂无成品出库单"]) {
      expect(screen.queryByText(emptyTitle)).toBeNull();
    }
    expect(screen.getByTestId("finished-goods-search-count-notices")).toHaveTextContent("筛选后 0 / 2 条");
  });

  it("清除搜索：六张表恢复全量，计数不再显示", async () => {
    await renderPage();
    await userEvent.type(search(), "SO-1");
    expect(screen.queryAllByText("SO-2")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    expect(search().value).toBe("");
    expect(screen.getAllByText("SO-2")).toHaveLength(6);
    expect(screen.queryByTestId("finished-goods-search-count-notices")).toBeNull();
  });
});

describe("成品仓储情况 · 关键字是本地过滤，与服务端订单号筛选互不干扰", () => {
  it("输入关键字不触发任何请求（只改屏幕上的行）", async () => {
    const calls = await renderPage();
    expect(callsTo(calls, "/finished-goods/inbounds")).toHaveLength(1);
    const before = calls.length;

    await userEvent.type(search(), "SO-1");

    // 一个字符都不该变成一次取数：关键字过滤的是已经在手上的行。
    // 反过来做（关键字并进服务端查询）会让「搜成品名」把六个接口各查一遍、全部返回 0 条。
    expect(calls.length).toBe(before);
  });

  it("原有的订单号筛选照旧走服务端：点「筛选」把 order_no 送到六个接口", async () => {
    const calls = await renderPage();

    await userEvent.type(screen.getByPlaceholderText("可选，留空看全部"), "SO-9");
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));

    await waitFor(() => expect(callsTo(calls, "/api/v1/finished-goods/outbound-notices?order_no=SO-9")).toHaveLength(1));
    const scoped = calls.filter((call) => call.url.includes("order_no=SO-9")).map((call) => call.url);
    expect(scoped).toContain("/api/v1/inventory/balances?category=finished_goods&order_no=SO-9");
    expect(scoped).toContain("/api/v1/inventory/balances?category=defective_goods&order_no=SO-9");
    expect(scoped).toContain("/api/v1/finished-goods/inbounds?order_no=SO-9");
    expect(scoped).toContain("/api/v1/finished-goods/outbounds?order_no=SO-9");
  });
});
