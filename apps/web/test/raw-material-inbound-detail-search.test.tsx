// 原料入库明细弹窗（components/warehouse/raw-material-inbound-detail-dialog.tsx）的明细搜索（2026-11-13）。
//
// 用户：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上搜索功能。
// 因为现在单子多了，查找比较麻烦。」
//
// 这个弹窗被两个列表页共用（仓库「原料仓储情况」/ 采购「原料入库」），里面两张小表
// （应付来源 / 库存流水）本文件钉住：
//   1) 一个小搜索框**同时**过滤两张表，只匹配屏幕上看得见的列；
//   2) 标题里的条数跟着筛选走（「筛选后 N / M 条」），否则「应付来源（2 条）」下只显示 1 行像丢数据；
//   3) 空态分两种：本来就是空（草稿单，给原因）vs 被关键词筛掉（说「没有匹配“xx”」）；
//   4) 搜索词只在**换单时**清空 —— 上一张单的词带进下一张单会把两张表直接过滤成「没有匹配」，
//      看起来像这张单没有应付、没有流水，比没有搜索更误导；
//   5) 过滤只动这两张表，上面的字段栅格（物料 / 供应商 / 结算金额）一个字都不变。
//
// 注意：globals: false，vitest API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RawMaterialInboundDetailDialog, type RawMaterialInboundRow } from "../components/warehouse/raw-material-inbound-detail-dialog";

/** 一条已过账的入库单：1 条待接收的应付（CNY）+ 1 条已付款的应付（USD），1 条过账流水 + 1 条冲销流水。 */
function inbound(overrides: Partial<RawMaterialInboundRow> = {}): RawMaterialInboundRow {
  return {
    id: "ib-1",
    inboundNo: "IN-001",
    orderNo: "SO-1",
    quantity: "100.0000",
    status: "posted",
    material_code: "M-001",
    material_name: "涤纶布",
    unit_name: "米",
    supplier_name: "苏州织造一厂",
    payableSources: [
      { id: "ps-1", status: "pending_finance", amount: "1250.0000", currency: "CNY", supplierPayableEntry: null },
      { id: "ps-2", status: "received", amount: "800.0000", currency: "USD", supplierPayableEntry: { id: "pe-1", payableNo: "AP-9", status: "paid" } },
    ],
    inventoryFacts: [
      { id: "if-1", quantityDelta: "100.0000", sourceType: "raw_material_inbound", createdAt: "2026-11-04T06:05:00.000Z" },
      { id: "if-2", quantityDelta: "-20.0000", sourceType: "raw_material_inbound_reversal", createdAt: "2026-11-05T06:05:00.000Z" },
    ],
    ...overrides,
  };
}

const onOpenChange = () => undefined;
const search = () => screen.getByTestId<HTMLInputElement>("raw-material-inbound-detail-search");

function renderDialog(row: RawMaterialInboundRow | null) {
  return render(<RawMaterialInboundDetailDialog inbound={row} onOpenChange={onOpenChange} />);
}

describe("原料入库明细弹窗 · 搜索：两张下游表共用一个关键词", () => {
  it("默认两张表全量，标题带条数，搜索框在弹窗里", () => {
    renderDialog(inbound());
    const dialog = screen.getByTestId("raw-material-inbound-detail");

    expect(search()).toBeVisible();
    expect(screen.getByRole("heading", { name: "应付来源（2 条）" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "库存流水（2 条）" })).toBeVisible();
    expect(screen.getByText("AP-9（已付款）")).toBeVisible();
    // 默认没有「筛选后」，因为还没筛
    expect(dialog.textContent).not.toContain("筛选后");
  });

  it("搜金额：只留命中的那一行，标题变「筛选后 N / M 条」，另一张表被筛空时说「没有匹配」", async () => {
    renderDialog(inbound());

    await userEvent.type(search(), "1250");

    expect(screen.getByRole("heading", { name: "应付来源（筛选后 1 / 2 条）" })).toBeVisible();
    expect(screen.getByText(/1250\.0000/)).toBeVisible();
    expect(screen.queryByText("AP-9（已付款）")).toBeNull();
    // 库存流水里没有 1250，被筛空：这里必须是「没有匹配」而不是「还没有库存流水」
    expect(screen.getByRole("heading", { name: "库存流水（筛选后 0 / 2 条）" })).toBeVisible();
    expect(screen.getByText("没有匹配“1250”的库存流水")).toBeVisible();
    expect(screen.queryByText(/这张入库单还没有库存流水/)).toBeNull();
  });

  it("搜「冲销」：按屏幕上中文化的来源类型命中，不需要输入 raw_material_inbound_reversal", async () => {
    renderDialog(inbound());

    await userEvent.type(search(), "冲销");

    expect(screen.getByRole("heading", { name: "库存流水（筛选后 1 / 2 条）" })).toBeVisible();
    expect(screen.getByText("原料入库冲销")).toBeVisible();
    expect(screen.queryByText("原料入库过账")).toBeNull();
    // 应付来源里没有「冲销」：这张单有数据，只是没被命中
    expect(screen.getByText("没有匹配“冲销”的应付来源")).toBeVisible();
    expect(screen.queryByText("尚未接收")).toBeNull();
  });

  it("本来就空（草稿单）仍说原因，不会被改口成「没有匹配」；搜索框也不会消失", async () => {
    renderDialog(inbound({ status: "draft", payableSources: [], inventoryFacts: [] }));

    expect(screen.getByText("草稿入库单还没过账，过账后才会生成应付来源。")).toBeVisible();
    expect(screen.getByText(/这张入库单还没有库存流水/)).toBeVisible();

    await userEvent.type(screen.getByTestId("raw-material-inbound-detail-search"), "随便什么");

    // 表里本来就没有数据：原因照旧，不能冒出一句「没有匹配」
    expect(screen.getByText("草稿入库单还没过账，过账后才会生成应付来源。")).toBeVisible();
    expect(screen.queryByText(/没有匹配/)).toBeNull();
    expect(search()).toBeVisible();
  });

  it("换一张入库单：搜索词清零，两张表回到全量（上一张单的词不许带进来）", async () => {
    const { rerender } = render(<RawMaterialInboundDetailDialog inbound={inbound()} onOpenChange={onOpenChange} />);
    await userEvent.type(search(), "1250");
    expect(search().value).toBe("1250");

    rerender(<RawMaterialInboundDetailDialog inbound={inbound({ id: "ib-2", inboundNo: "IN-002" })} onOpenChange={onOpenChange} />);

    expect(search().value).toBe("");
    expect(screen.getByRole("heading", { name: "应付来源（2 条）" })).toBeVisible();
    expect(screen.getByText("AP-9（已付款）")).toBeVisible();
  });

  it("过滤只动两张表：上面的字段栅格（物料 / 供应商 / 结算）不受关键词影响", async () => {
    renderDialog(inbound());

    await userEvent.type(search(), "查无此单");

    expect(screen.getAllByText(/没有匹配“查无此单”/)).toHaveLength(2);
    expect(screen.getByText("M-001 / 涤纶布")).toBeVisible();
    expect(screen.getByText("苏州织造一厂")).toBeVisible();
  });
});
