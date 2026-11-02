// 成品出库单「导出 / 打印」口径的纯函数测试（node --test）。
//
// 这张纸会跟着货一起到司机和客户手上：标题必须写清状态（草稿/已取消/已冲销），文件名必须带单号，
// 打印件与导出件必须是同一组字段 —— 三条都在这里钉住。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTBOUND_SLIP_COLUMNS, OUTBOUND_SLIP_SIGN_LINE,
  outboundSlipDocumentPath, outboundSlipExportPath, outboundSlipFileName, outboundSlipHeading, outboundSlipLogisticsRows,
} from "./finished-goods-outbound-slip.ts";

const slip = {
  outboundNo: "FGO-20261102-0001",
  status: "posted",
  statusLabel: "已出库",
  orderNo: "DL260134",
  customerName: "家百纳",
  productName: "50cm*5K 三折手开碳纤维伞",
  productSpecification: "50cm*5K",
  implementationOrderNo: "MO-20261102-0001",
  outboundNoticeNo: "OGN-0001",
  outboundDate: "2026-11-02",
  quantity: "1200",
  unitName: "支",
  shipmentDate: "2026-11-03",
  carrier: "顺丰",
  trackingNo: "SF123",
  packingListNo: "PL-1",
  invoiceNo: "INV-1",
  signedDate: "2026-11-05",
  signatureReference: "签收单1",
  remark: "分两车",
  riskReason: "",
  makerName: "张三",
  printedAt: "2026-11-02 10:00:00",
};

test("路径：打印件走 apiGet（不带 /api/v1），导出走原生下载（带 /api/v1）", () => {
  assert.equal(outboundSlipDocumentPath("ob 1"), "/finished-goods/outbounds/ob%201/slip-document");
  assert.equal(outboundSlipExportPath("ob 1"), "/api/v1/finished-goods/outbounds/ob%201/export.xlsx");
  assert.equal(outboundSlipFileName("FGO-1"), "迪礼ERP-成品出库单-FGO-1.xlsx");
  assert.equal(outboundSlipFileName(""), "迪礼ERP-成品出库单-未命名.xlsx");
});

test("纸头标题：草稿/已取消/已冲销必须写出来（否则会被当成发货凭据）", () => {
  assert.equal(outboundSlipHeading({ status: "posted", statusLabel: "已出库" }), "成品出库单");
  assert.equal(outboundSlipHeading({ status: "shipped", statusLabel: "已发出" }), "成品出库单");
  assert.equal(outboundSlipHeading({ status: "draft", statusLabel: "待出库" }), "成品出库单（待出库）");
  assert.equal(outboundSlipHeading({ status: "cancelled", statusLabel: "已取消" }), "成品出库单（已取消）");
  assert.equal(outboundSlipHeading({ status: "reversed", statusLabel: "已冲销" }), "成品出库单（已冲销）");
});

test("明细列与签字行与导出 xlsx 一致", () => {
  assert.deepEqual([...OUTBOUND_SLIP_COLUMNS], ["序号", "产品名称", "规格型号", "单位", "数量", "备注"]);
  assert.equal(OUTBOUND_SLIP_SIGN_LINE, "仓库经办：　　　　　　　承运人：　　　　　　　客户签收：　　　　　　　日期：");
});

test("发货与签收小格：顺序固定，空值也留格（手写补）", () => {
  const rows = outboundSlipLogisticsRows(slip);
  assert.deepEqual(rows.map(([label]) => label), ["运单号", "装箱单号", "发票号", "签收日期", "签收凭证", "备注"]);
  assert.deepEqual(rows.map(([, value]) => value), ["SF123", "PL-1", "INV-1", "2026-11-05", "签收单1", "分两车"]);
  assert.deepEqual(outboundSlipLogisticsRows({ ...slip, trackingNo: "", packingListNo: "" }).slice(0, 2), [["运单号", ""], ["装箱单号", ""]]);
});
