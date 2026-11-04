// 采购 → 原料入库：双击单据查看详情（2026-11-04）。
//
// 用户要求：「原料入库单模块，双击单据条目也要支持查看详情。居中悬浮窗口，复用就行」。
//
// 这张单在两个页面各列一次（仓库「原料仓储情况」看数量/状态，采购「原料入库」看应付与财务通知），
// 双击打开的必须是**同一个组件、同一套字段**（`components/warehouse/raw-material-inbound-detail-dialog.tsx`）。
// 这里钉的是采购页这一侧：
//   ① 双击行弹出居中详情，字段来自列表行本身（不再打 :id 请求）；
//   ② 详情底部动作与列表行一致：编辑 / 冲销 / 通知财务付款；
//   ③ 「通知财务付款」打到 /finance/payable-entries/from-source，且带上这条应付来源的 id。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import InboundsPage from "../app/procurement/inbounds/page";
import { Toaster } from "../components/ui/toaster";
import { apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const inbound = {
  id: "ib-1",
  inboundNo: "IN-001",
  orderNo: "SO-1",
  quantity: "100.0000",
  status: "posted",
  inventoryCategory: "raw_material",
  remark: "第一批到货",
  purchase_order_no: "PO-1",
  receipt_no: "GR-1",
  batch_sequence: 1,
  inspection_status: "accepted",
  material_code: "M-001",
  material_name: "涤纶布",
  material_specification: "150D",
  material_color: "本白",
  unit_name: "米",
  supplier_name: "苏州织造一厂",
  inspection_no: "QCS-1",
  inspected_quantity: "100.0000",
  settlementUnitPrice: "12.5000",
  settlementTotalAmount: "1250.0000",
  created_by_name: "张三",
  updated_by_name: "李四",
  createdAt: "2026-11-04T06:00:00.000Z",
  updatedAt: "2026-11-04T06:10:00.000Z",
  payableSources: [{ id: "ps-1", status: "pending_finance", amount: "1250.0000", currency: "CNY", supplierPayableEntry: null }],
  inventoryFacts: [{ id: "if-1", quantityDelta: "100.0000", sourceType: "raw_material_inbound", createdAt: "2026-11-04T06:05:00.000Z" }],
};

const payableSources = [{ id: "ps-1", orderNo: "SO-1", amount: "1250.0000", status: "pending_finance", rawMaterialInboundId: "ib-1" }];

function stub(): StubbedCall[] {
  return stubApi((url) => {
    if (url.endsWith("/payable-sources")) return apiOk(payableSources);
    if (url.includes("/finance/payable-entries")) return apiOk([]);
    if (url.endsWith("/raw-material-inbounds")) return apiOk([inbound]);
    return apiOk([]);
  });
}

async function openDetail() {
  render(<><InboundsPage /><Toaster /></>);
  const row = await screen.findByText("IN-001");
  fireEvent.doubleClick(row);
  return screen.getByTestId("raw-material-inbound-detail");
}

describe("采购原料入库：双击查看详情", () => {
  it("双击单据行弹出居中详情：字段来自列表行，且不打 :id 请求", async () => {
    const calls = stub();
    const dialog = await openDetail();
    // 详情不再请求：列表接口已经把物料/质检/应付来源/库存流水一起带回来了
    expect(calls.filter((call) => /\/raw-material-inbounds\/ib-1$/.test(call.url))).toHaveLength(0);

    expect(dialog).toHaveTextContent("原料入库单详情：IN-001");
    expect(dialog).toHaveTextContent("M-001 / 涤纶布");
    expect(dialog).toHaveTextContent("苏州织造一厂");
    expect(dialog).toHaveTextContent("QCS-1");
    expect(dialog).toHaveTextContent("1250.0000");
    // 两张下游表：应付来源（财务从这张单拿到的应付）与库存流水
    expect(within(dialog).getByRole("heading", { name: "应付来源（1 条）" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "库存流水（1 条）" })).toBeInTheDocument();
  });

  it("详情底部动作与列表行一致：已过账单给 编辑 / 冲销 / 通知财务付款", async () => {
    stub();
    const dialog = await openDetail();
    expect(within(dialog).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "冲销" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "通知财务付款" })).toBeInTheDocument();
  });

  it("详情里点「通知财务付款」：打到 from-source 并带上应付来源 id", async () => {
    const calls = stub();
    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole("button", { name: "通知财务付款" }));
    await waitFor(() => expect(callsTo(calls, "/finance/payable-entries/from-source")).toHaveLength(1));
    expect(JSON.parse(String(callsTo(calls, "/finance/payable-entries/from-source")[0].body))).toMatchObject({ source_type: "raw_material_inbound", source_id: "ps-1" });
    // 点完弹窗先关掉，避免它挡在刷新后的页面上
    await waitFor(() => expect(screen.queryByTestId("raw-material-inbound-detail")).toBeNull());
  });
});
