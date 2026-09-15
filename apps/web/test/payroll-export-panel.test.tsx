// 生产工序导出面板（components/production/payroll-export-panel.tsx）的真实行为测试。
//
// 为什么这个组件值得独立护栏 —— 它是全站少见的"纯副作用"组件，四个导出入口共用一个 download()，
// 风险面集中在四类静默故障上：
//   1) HTTP 失败 / 非 JSON 错误体被当成成功，产出一个 0 字节的坏文件（用户以为导出了）；
//   2) 导出在飞行中按钮不禁用 → 连点产生多份并发导出；
//   3) 生成的 URL 参数与用户所选不符（漏 order_no / 漏 operation_id / 月份没带上）；
//   4) 未选必填项时只在弹窗之外提示，用户点了没反应。
//
// 纪律（见 docs/test/01-test-master-plan.md）：不 readFileSync、不正则匹配源码、不断言 className。
// 断言只落在可见结果（文案 / disabled / 弹窗开关 / 下拉里有什么可选项）与网络调用（url、method）
// 以及"浏览器真的收到了一次带文件名的下载"这一副作用上。
//
// jsdom 的两个缺口在测试侧补齐（不是产品缺陷）：
//   - URL.createObjectURL / revokeObjectURL 未实现 → 桩成"记录参数 + 返回假 blob: URL"；
//     若不补，成功分支会抛 TypeError，看起来像组件坏了。
//   - <a download>.click() 会真的触发 jsdom 导航 → 拦 HTMLAnchorElement.prototype.click 记录 href/download。
//
// Radix 交互注意：Select 打开时会给 body 设 pointer-events:none（DismissableLayer
// disableOutsidePointerEvents），此时用 user-event 点任何别处都会抛 "pointer-events: none"，
// 因此关闭列表一律用 Escape / 选中项，而不是点空白处。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayrollExportPanel } from "../components/production/payroll-export-panel";
import { Toaster } from "../components/ui/toaster";
import { apiErr, stubApi } from "./helpers/api-stub";

type ExportOperation = { id: string; operationName?: string; operationNameSnapshot?: string };
type ExportOrder = { id: string; orderNo: string; productionOrderNo: string; operations: ExportOperation[] };

const operationPool: ExportOperation[] = [
  { id: "op-1", operationName: "裁剪" },
  // 工序池条目只有快照名时同样必须可选（组件用的是 operationName ?? operationNameSnapshot）
  { id: "op-2", operationNameSnapshot: "缝制" },
];

const productionOrders: ExportOrder[] = [
  {
    id: "po-1",
    orderNo: "SO-2026-009",
    productionOrderNo: "MO-2026-001",
    operations: [
      { id: "opr-1", operationNameSnapshot: "裁剪" },
      { id: "opr-2", operationNameSnapshot: "缝制" },
    ],
  },
  // 第二张单故意没有工序：验证换订单后工序下拉被重置、且订单级导出仍然可用
  { id: "po-2", orderNo: "SO-2026-010", productionOrderNo: "MO-2026-002", operations: [] },
];

const ORDER_A = "SO-2026-009 / MO-2026-001";
const ORDER_B = "SO-2026-010 / MO-2026-002";

/** 导出端点的真实响应形态：XLSX 二进制（PK\x03\x04 是 zip/xlsx 的魔数）。 */
function xlsxResponse(bytes: number[] = [0x50, 0x4b, 0x03, 0x04]) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
}

type Download = { blob: Blob; url: string };
let downloads: Download[] = [];
let revokedUrls: string[] = [];
let anchorClicks: Array<{ download: string; href: string }> = [];

/**
 * 记录下载副作用。在每个用例体内安装（而不是 beforeEach），
 * 这样不依赖 vi 的 restoreMocks 与用户钩子的先后顺序。
 */
function captureDownloads() {
  downloads = [];
  revokedUrls = [];
  anchorClicks = [];
  let seq = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:http://localhost/${++seq}`;
      downloads.push({ blob, url });
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
  });
}

afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  // 生产进度表的工序列顺序按订单号记在 localStorage：用例之间必须清掉，
  // 否则前一个用例存下的顺序会变成后一个用例的初始顺序（本文件实测踩到过）。
  window.localStorage.clear();
});

function renderPanel(props: { orders?: ExportOrder[]; operations?: ExportOperation[] } = {}) {
  captureDownloads();
  render(
    <>
      <PayrollExportPanel orders={props.orders ?? productionOrders} operations={props.operations ?? operationPool} />
      <Toaster />
    </>
  );
}

function panelDialog() {
  return screen.getByRole("dialog");
}

/** 限定在当前打开的导出对话框内查询。 */
function inDialog() {
  return within(panelDialog());
}

async function openDialog(entry: string) {
  await userEvent.click(screen.getByRole("button", { name: entry }));
  expect(panelDialog()).toBeVisible();
}

/** 打开对话框内的第 index 个下拉并选中一项（0=订单号/工序，见各对话框的字段顺序）。 */
async function pickOption(index: number, optionName: string) {
  await userEvent.click(inDialog().getAllByRole("combobox")[index]);
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

async function openSelect(index: number) {
  await userEvent.click(inDialog().getAllByRole("combobox")[index]);
}

function monthInput() {
  return inDialog().getByLabelText(/月份/);
}

function exportButton() {
  return inDialog().getByRole("button", { name: "导出 XLSX" });
}

async function clickExport() {
  await userEvent.click(exportButton());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 面板级校验提示（<p role="alert">，在弹窗之外）。
 * 不能用 getByText("请选择订单号")：对话框里 SelectValue 的占位符就是同一串字，
 * 会命中两个节点。这里按 role 精确定位这个 <p>。
 */
function panelAlertMessage() {
  return document.querySelector('p[role="alert"]');
}

const currentMonth = new Date().toISOString().slice(0, 7);

describe("生产工序导出面板 · 五个入口与弹窗", () => {
  it("五个入口按钮各打开自己的对话框，取消后弹窗关闭", async () => {
    stubApi(() => xlsxResponse());
    renderPanel();

    // 客户要求把「材料与车间生产对应表」拆成上表/下表两张独立导出表。
    const entries: Array<[string, string]> = [
      ["工序盘点表", "导出工序盘点表"],
      ["订单号盘点表", "导出订单号盘点表"],
      ["当月工序明细总表", "导出当月工序明细总表"],
      ["原料对应表", "导出原料对应表"],
      ["生产进度表", "导出生产进度表"],
    ];

    for (const [entry, title] of entries) {
      await openDialog(entry);
      expect(inDialog().getByRole("heading", { name: title })).toBeVisible();

      await userEvent.click(inDialog().getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  it("上一次的校验提示不残留：重新打开任一入口即被清空", async () => {
    stubApi(() => xlsxResponse());
    renderPanel();

    await openDialog("工序盘点表");
    await clickExport();
    expect(screen.getByText("请选择工序并填写有效月份")).toBeInTheDocument();

    await userEvent.click(inDialog().getByRole("button", { name: "取消" }));
    expect(await screen.findByText("请选择工序并填写有效月份")).toBeVisible();

    await openDialog("订单号盘点表");
    expect(screen.queryByText("请选择工序并填写有效月份")).toBeNull();
  });
});

describe("生产工序导出面板 · 工序盘点表", () => {
  it("没选工序就导出：给出提示、不发任何请求、弹窗保持打开", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("工序盘点表");

    await clickExport();

    expect(screen.getByText("请选择工序并填写有效月份")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(panelDialog()).toBeVisible();
    expect(downloads).toHaveLength(0);
  });

  it("月份被清空时同样拦截（月份是导出范围的另一半）", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");

    fireEvent.change(monthInput(), { target: { value: "" } });
    await clickExport();

    expect(screen.getByText("请选择工序并填写有效月份")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("选好工序与月份：请求带参数的 xlsx 端点、把二进制交给 createObjectURL 并触发一次带文件名的下载", async () => {
    const calls = stubApi(() => xlsxResponse([1, 2, 3, 4]));
    renderPanel();
    await openDialog("工序盘点表");

    await pickOption(0, "裁剪");
    fireEvent.change(monthInput(), { target: { value: "2026-03" } });
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("/api/v1/production/reports/operation-payroll.xlsx?operation_id=op-1&month=2026-03");

    // 下载三件套：把响应体转成 blob、用 blob URL 建 <a download>、点它一次，然后回收 URL
    expect(downloads).toHaveLength(1);
    expect(downloads[0].blob.size).toBe(4);
    expect(anchorClicks[0]).toEqual({ download: "迪礼ERP-工序盘点表.xlsx", href: downloads[0].url });
    expect(revokedUrls).toEqual([downloads[0].url]);

    // 导出成功后弹窗自动关闭，避免用户以为还要再点一次
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("服务端拒绝：弹出服务端原因、不产生下载、弹窗不关闭且按钮恢复可点", async () => {
    const calls = stubApi(() => apiErr(403, "FORBIDDEN", "没有导出工资表的权限"));
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");
    fireEvent.change(monthInput(), { target: { value: "2026-03" } });

    await clickExport();

    expect(await screen.findByText("没有导出工资表的权限")).toBeVisible();
    expect(downloads).toHaveLength(0);
    expect(anchorClicks).toHaveLength(0);
    expect(calls).toHaveLength(1);
    // 失败必须回到可重试状态，而不是把弹窗关掉让用户重来
    expect(panelDialog()).toBeVisible();
    await waitFor(() => expect(exportButton()).toBeEnabled());
    expect(exportButton()).toHaveTextContent("导出 XLSX");
  });

  it("错误响应体不是 JSON：回落到 HTTP 状态文案，而不是静默下载空文件", async () => {
    stubApi(() => new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/html" } }));
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");

    await clickExport();

    expect(await screen.findByText("导出失败（HTTP 502）")).toBeVisible();
    expect(downloads).toHaveLength(0);
    expect(anchorClicks).toHaveLength(0);
  });

  it("请求超时：提示缩小范围重试，且不当成成功", async () => {
    stubApi(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");

    await clickExport();

    expect(await screen.findByText("导出超时，请缩小范围后重试")).toBeVisible();
    expect(downloads).toHaveLength(0);
  });
});

describe("生产工序导出面板 · 订单号盘点表", () => {
  it("没选订单号就导出：给出提示且不发请求", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("订单号盘点表");

    await clickExport();

    expect(panelAlertMessage()).toHaveTextContent("请选择订单号");
    expect(calls).toHaveLength(0);
    expect(panelDialog()).toBeVisible();
  });

  it("不选工序（全部工序）：URL 只带 order_no", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("订单号盘点表");

    await pickOption(0, ORDER_A);
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/v1/production/reports/order-operation-payroll.xlsx?order_no=SO-2026-009");
    expect(anchorClicks[0].download).toBe("迪礼ERP-订单号盘点表.xlsx");
  });

  it("指定工序：URL 追加 operation_id，且工序候选来自所选订单", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("订单号盘点表");

    await pickOption(0, ORDER_A);
    await pickOption(1, "缝制");
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/production/reports/order-operation-payroll.xlsx?order_no=SO-2026-009&operation_id=opr-2");
  });

  it("换订单号会把工序选择重置为「全部工序」，导出范围不会串到上一张单", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("订单号盘点表");

    await pickOption(0, ORDER_A);
    await pickOption(1, "裁剪");
    expect(inDialog().getAllByRole("combobox")[1]).toHaveTextContent("裁剪");

    await pickOption(0, ORDER_B);

    // 可见结果：第二个下拉回到「全部工序」
    expect(inDialog().getAllByRole("combobox")[1]).toHaveTextContent("全部工序");
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/production/reports/order-operation-payroll.xlsx?order_no=SO-2026-010");
  });
});

describe("生产工序导出面板 · 当月工序明细总表", () => {
  it("默认月份就是本月，导出当月总表", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("当月工序明细总表");

    expect(monthInput()).toHaveValue(currentMonth);
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe(`/api/v1/production/reports/monthly-operations-payroll.xlsx?month=${currentMonth}`);
    expect(anchorClicks[0].download).toBe("迪礼ERP-当月工序明细总表.xlsx");
  });

  it("月份为空时拦截：不发请求也不提示超时之类无关错误", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("当月工序明细总表");

    fireEvent.change(monthInput(), { target: { value: "" } });
    await clickExport();

    expect(screen.getByText("请填写有效月份")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(panelDialog()).toBeVisible();
  });
});

describe("生产工序导出面板 · 原料对应表 / 生产进度表（拆表后）", () => {
  it("选订单后导出原料对应表，文件名与端点都对", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("原料对应表");

    await pickOption(0, ORDER_A);
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/production/reports/material-reference.xlsx?order_no=SO-2026-009");
    expect(anchorClicks[0].download).toBe("迪礼ERP-原料对应表.xlsx");
  });

  it("选订单后导出生产进度表，文件名与端点都对", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    anchorClicks.length = 0;
    await openDialog("生产进度表");

    await pickOption(0, ORDER_A);
    await clickExport();

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/production/reports/production-progress.xlsx?order_no=SO-2026-009");
    expect(anchorClicks[0].download).toBe("迪礼ERP-生产进度表.xlsx");
  });
});

// 用户 2026-09-15 要求：导出生产进度表时允许拖拽调整工序排序，导出的工序 column 按这个顺序来。
// 顺序只影响列序（导出请求的 operation_order），不写回生产工序的 sequence_no。
describe("生产工序导出面板 · 生产进度表的工序列排序", () => {
  const sourceOrder = ["opr-1", "opr-2"]; // 夹具里 SO-2026-009 的工序：裁剪 → 缝制

  it("弹窗里列出该订单的工序，默认顺序时导出不带 operation_order", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("生产进度表");
    await pickOption(0, ORDER_A);

    const editor = inDialog().getByTestId("progress-column-order-editor");
    expect(within(editor).getByTestId("progress-column-opr-1")).toHaveTextContent("裁剪");
    expect(within(editor).getByTestId("progress-column-opr-2")).toHaveTextContent("缝制");
    expect(within(editor).getByTestId("progress-column-order-state")).toHaveTextContent("当前是默认列序");

    await clickExport();
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/production/reports/production-progress.xlsx?order_no=SO-2026-009");
  });

  it("下移调整顺序后导出，operation_order 按新顺序带上", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("生产进度表");
    await pickOption(0, ORDER_A);

    await userEvent.click(inDialog().getByTestId("progress-column-down-opr-1"));
    expect(inDialog().getByTestId("progress-column-order-state")).toHaveTextContent("已自定义列序");
    // 列表里的先后也随之变化（1 号位变成缝制）
    const list = inDialog().getByTestId("progress-column-order-editor").querySelectorAll("li");
    expect(list[0]).toHaveTextContent("缝制");
    expect(list[1]).toHaveTextContent("裁剪");

    await clickExport();
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe(`/api/v1/production/reports/production-progress.xlsx?order_no=SO-2026-009&operation_order=${sourceOrder[1]}%2C${sourceOrder[0]}`);
  });

  it("拖拽也能改顺序（原生 HTML5 拖拽路径）", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("生产进度表");
    await pickOption(0, ORDER_A);

    const editor = inDialog().getByTestId("progress-column-order-editor");
    const source = within(editor).getByTestId("progress-column-opr-1");
    const target = within(editor).getByTestId("progress-column-opr-2");
    // jsdom 没有真正的 drag 会话：显式带上 dataTransfer，才能走到 React 的 onDragStart/onDrop
    const dataTransfer = { setData: () => undefined, getData: () => null, effectAllowed: "move", dropEffect: "move" };
    fireEvent.dragStart(source, { dataTransfer });
    expect(source.className, "dragstart 必须被组件接收到（行进入拖拽态）").toContain("dragging");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await clickExport();
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toContain(`operation_order=${sourceOrder[1]}%2C${sourceOrder[0]}`);
  });

  it("恢复默认顺序后参数消失；顺序按订单号记在本机（重新打开弹窗仍在）", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("生产进度表");
    await pickOption(0, ORDER_A);
    await userEvent.click(inDialog().getByTestId("progress-column-down-opr-1"));
    expect(window.localStorage.getItem("dilee:progress-columns:SO-2026-009")).toBe('["opr-2","opr-1"]');

    // 关掉再打开：顺序从本机读回来
    await userEvent.keyboard("{Escape}");
    await openDialog("生产进度表");
    expect(inDialog().getByTestId("progress-column-order-state")).toHaveTextContent("已自定义列序");

    await userEvent.click(inDialog().getByTestId("progress-column-reset"));
    expect(inDialog().getByTestId("progress-column-order-state")).toHaveTextContent("当前是默认列序");
    expect(window.localStorage.getItem("dilee:progress-columns:SO-2026-009")).toBeNull();

    await clickExport();
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/production/reports/production-progress.xlsx?order_no=SO-2026-009");
  });

  it("没有工序的订单：给出提示而不是空列表", async () => {
    renderPanel();
    await openDialog("生产进度表");
    await pickOption(0, ORDER_B);
    expect(inDialog().getByTestId("progress-column-order-editor")).toHaveTextContent("该订单还没有工序");
  });
});

describe("生产工序导出面板 · 导出中的防重复提交", () => {
  it("导出中：按钮禁用并改文案、取消禁用、连点不产生第二次请求、关闭按钮关不掉弹窗", async () => {
    const gate = deferred<Response>();
    const calls = stubApi(() => gate.promise);
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");

    await clickExport();

    const pending = await inDialog().findByRole("button", { name: "导出中..." });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);
    await userEvent.click(pending);
    expect(calls).toHaveLength(1);

    // 导出在飞行中时不允许把弹窗关掉：关掉会让人以为请求被取消了
    expect(inDialog().getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.click(inDialog().getByRole("button", { name: "关闭" }));
    expect(panelDialog()).toBeVisible();

    await act(async () => {
      gate.resolve(xlsxResponse());
    });
  });

  it("请求返回后：恢复可导出状态、弹窗关闭、只下载一次", async () => {
    const gate = deferred<Response>();
    stubApi(() => gate.promise);
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");
    await clickExport();
    await inDialog().findByRole("button", { name: "导出中..." });

    await act(async () => {
      gate.resolve(xlsxResponse());
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(downloads).toHaveLength(1);
    expect(anchorClicks).toHaveLength(1);
  });
});

describe("生产工序导出面板 · 下拉数据为空时", () => {
  it("订单列表为空：订单号下拉没有任何选项，导出被拦截并提示", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel({ orders: [] });
    await openDialog("订单号盘点表");

    expect(inDialog().getAllByRole("combobox")).toHaveLength(2);
    await openSelect(0);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    expect(panelDialog()).toBeVisible();

    await clickExport();

    // 与上面「没选订单号就导出」同源：对话框里 SelectValue 的占位符也是「请选择订单号」，
    // 全局 getByText 会命中两个节点；这里用 panelAlertMessage() 精确定位面板级 <p role="alert">。
    expect(panelAlertMessage()).toHaveTextContent("请选择订单号");
    expect(calls).toHaveLength(0);
  });

  it("工序池为空：工序下拉没有选项，导出被拦截并提示", async () => {
    const calls = stubApi(() => xlsxResponse());
    renderPanel({ operations: [] });
    await openDialog("工序盘点表");

    expect(inDialog().getAllByRole("combobox")).toHaveLength(1);
    await openSelect(0);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");

    await clickExport();

    expect(screen.getByText("请选择工序并填写有效月份")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("有工序时下拉按 operationName ?? operationNameSnapshot 渲染，两项都能选", async () => {
    stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("工序盘点表");

    await openSelect(0);
    expect(await screen.findByRole("option", { name: "裁剪" })).toBeVisible();
    expect(screen.getByRole("option", { name: "缝制" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
  });
});

describe("生产工序导出面板 · 校验提示的可见性", () => {
  it("KNOWN_DEFECT：校验失败提示渲染在模态框之外，点导出那一刻用户看不到任何反馈", async () => {
    // 期望：导出被本组件校验拦下时（未选订单号 / 未选工序），用户应当**在当前对话框内**看到原因。
    // 实际：setError(...) 的 <p role="alert"> 渲染在**所有 <Dialog> 之外**（payload 面板层），
    //      弹窗打开期间它被 Radix 的 hideOthers 打上 aria-hidden、并被 overlay 盖住 ——
    //      无障碍树上取不到（读屏不会播报），鼠标用户也只能先关掉弹窗才看得见这行字，
    //      表现为"点了导出没反应"。
    // 责任文件：components/production/payroll-export-panel.tsx:31（错误段落挂在 section 下、Dialog 之外，
    //      与 :27 / :28 / :29 / :30 的校验写入点分离）。
    // 本用例按现状钉住缺陷（提示确实进了 DOM，但不在无障碍树里），不掩盖、也不修产品代码。
    const calls = stubApi(() => xlsxResponse());
    renderPanel();
    await openDialog("订单号盘点表");

    await clickExport();

    expect(document.querySelector('p[role="alert"]')).toHaveTextContent("请选择订单号");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toHaveLength(0);
    // 关掉弹窗之后才可见 —— 证明它只是被模态框挡在外面
    await userEvent.click(inDialog().getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("请选择订单号"));
  });

  it("导出失败走的是 toast：错误原因以操作失败通知呈现，且不重复请求", async () => {
    const calls = stubApi(() => apiErr(500, "INTERNAL_SERVER_ERROR", "导出服务暂时不可用"));
    renderPanel();
    await openDialog("工序盘点表");
    await pickOption(0, "裁剪");

    await clickExport();

    expect(await screen.findByText("导出服务暂时不可用")).toBeVisible();
    expect(calls).toHaveLength(1);
  });
});
