// 成品存量与入库通知面板（components/production/finished-goods-panel.tsx）的真实行为测试。
//
// 取代 apps/web/lib/finished-goods-storage.test.mjs 中针对本面板的**源码正则**断言（第 61-78 行）：
// 那些断言用 readFileSync 读 .tsx 再正则匹配 JSX 文本，把书写形式当契约（重构即误红），
// 而真实的运行时缺陷（门禁失效、请求体错误、刷新不生效、状态文案错）一律漏过。
// 这里保留其全部断言意图，改为真实渲染 + userEvent 驱动 + fetch 桩断言请求与 DOM：
//   1) 汇总必须读 GET /production/orders/:id/finished-goods-summary；
//   2) 缺包装工序要能补建（POST /production/orders/:id/packaging-operation），文案区分「补建/确认」；
//   3) 发成品入库通知（POST /production/finished-goods-inbound-notices），通知数量默认取可通知量；
//   4) 未送检的通知要能取消（POST /:id/cancel）；已有送检量或已取消的行不给必然失败的按钮；
//   5) 只有厂内（in_house）生产单才允许发通知；
//   6) 包装累计报工/已通知/可通知/送检/QC/在途/已入库/成品存量/次品存量等指标都要展示；
//   7) 焦点/可见性/生产变更事件刷新，且卸载时必须解绑（原测试只正则匹配 addEventListener/removeEventListener）。
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FinishedGoodsPanel } from "../components/production/finished-goods-panel";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

const SUMMARY_SUFFIX = "/production/orders/po-1/finished-goods-summary";
const PACKAGING_SUFFIX = "/production/orders/po-1/packaging-operation";
const NOTICE_SUFFIX = "/production/finished-goods-inbound-notices";
const today = () => new Date().toISOString().slice(0, 10);

function notice(overrides: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    noticeNo: "FGI-001",
    noticeDate: "2026-09-01T00:00:00.000Z",
    batchNo: "B1",
    status: "pending",
    noticeQuantity: "20",
    submittedQuantity: "0",
    qcQualifiedQuantity: "0",
    qcRejectedQuantity: "0",
    inboundDraftQuantity: "0",
    inboundPostedQuantity: "0",
    availableSubmissionQuantity: "20",
    remainingForInbound: "20",
    operationNameSnapshot: "包装",
    unitNameSnapshot: "件",
    ...overrides,
  };
}

/** 汇总 DTO（形状对齐 finished-goods-summary 接口；notices 覆盖 4 种状态）。 */
const baseSummary = {
  production_order_id: "po-1",
  production_order_no: "MO-2026-001",
  order_no: "SO-2026-001",
  execution_mode: "in_house",
  status: "in_progress",
  planned_quantity: "100",
  unit_name: "件",
  packaging_operation: { id: "op-pack", name: "包装", sequence_no: 5, target_quantity: "100", status: "active" },
  packaging_reported_quantity: "60",
  notified_quantity: "20",
  available_notice_quantity: "40",
  submitted_quantity: "20",
  qc_qualified_quantity: "18",
  inbound_draft_quantity: "10",
  inbound_posted_quantity: "8",
  finished_goods_stock: "8",
  defective_goods_stock: "2",
  outbound_quantity: "3",
  customer_return_quantity: "1",
  notice_count: 4,
  notices: [
    notice({ id: "n-1", noticeNo: "FGI-001", status: "pending", submittedQuantity: "0" }),
    notice({ id: "n-2", noticeNo: "FGI-002", batchNo: null, status: "partially_inbound", submittedQuantity: "20" }),
    notice({ id: "n-3", noticeNo: "FGI-003", status: "completed", submittedQuantity: "20" }),
    notice({ id: "n-4", noticeNo: "FGI-004", status: "cancelled", submittedQuantity: "0" }),
  ],
};

const summary = (overrides: Record<string, unknown> = {}) => ({ ...baseSummary, ...overrides });

type PanelProps = { productionOrderId: string; executionMode: string; orderStatus: string; onChanged: () => void };

/** 渲染面板 + Toaster（面板的提示走全局 toast，toast 也是用户可见行为的一部分）。 */
function renderPanel(overrides: Partial<PanelProps> = {}) {
  const onChanged = vi.fn();
  const result = render(
    <>
      <FinishedGoodsPanel productionOrderId="po-1" executionMode="in_house" orderStatus="in_progress" onChanged={onChanged} {...overrides} />
      <Toaster />
    </>
  );
  return { ...result, onChanged };
}

/** 汇总指标行是 <span><small>标签</small><strong>值</strong></span>；用 SMALL 与表头同名标签区分。 */
function metric(label: string): HTMLElement {
  const node = screen.getAllByText(label).find((element) => element.tagName === "SMALL");
  if (!node?.parentElement) throw new Error(`未渲染汇总指标：${label}`);
  return node.parentElement;
}

const noticeButton = () => screen.getByRole("button", { name: "发成品入库通知" });

describe("成品存量面板：加载、列表与存量渲染", () => {
  it("初次渲染显示加载态，并请求该生产单的成品存量汇总接口", async () => {
    const calls = stubApi(() => apiOk(baseSummary));

    renderPanel();

    // 数据到达前必须是可读的加载文案，而不是空白面板
    expect(screen.getByText("正在加载成品存量…")).toBeVisible();

    await screen.findByText("包装累计报工");
    const gets = callsTo(calls, SUMMARY_SUFFIX);
    expect(gets).toHaveLength(1);
    expect(gets[0].method).toBe("GET");
    expect(gets[0].url).toBe(`/api/v1${SUMMARY_SUFFIX}`);
  });

  it("渲染包装累计报工→通知→送检/QC/入库→成品/次品存量的完整数字链", async () => {
    stubApi(() => apiOk(baseSummary));

    renderPanel();
    await screen.findByText("包装累计报工");

    const expected: Array<[string, string]> = [
      ["包装累计报工", "60"],
      ["已通知入库", "20"],
      ["可通知入库", "40"],
      ["已送检", "20"],
      ["QC 合格", "18"],
      ["在途入库", "10"],
      ["已入库", "8"],
      ["成品存量", "8"],
      ["次品存量", "2"],
      ["已出库", "3"],
      ["客户退货", "1"],
    ];
    for (const [label, value] of expected) expect(metric(label)).toHaveTextContent(value);
    expect(metric("包装工序")).toHaveTextContent("包装（第 5 道）");
    expect(screen.getByText(/单位：件；/)).toBeVisible();
  });

  it("入库通知逐行渲染通知单/批次/日期/数量，状态显示中文而不是英文原值", async () => {
    stubApi(() => apiOk(baseSummary));

    renderPanel();
    const rows = await screen.findAllByTestId("data-table-row");
    expect(rows).toHaveLength(4);

    const cells = (row: HTMLElement) => within(row).getAllByRole("cell");
    expect(cells(rows[0])[0]).toHaveTextContent("FGI-001");
    expect(cells(rows[0])[1]).toHaveTextContent("B1");
    expect(cells(rows[0])[2]).toHaveTextContent("2026-09-01");
    expect(cells(rows[0])[3]).toHaveTextContent("20 件");
    // 批次为空时回落到「-」（不能渲染成空白，仓库看不出有没有批次）
    expect(cells(rows[1])[1]).toHaveTextContent(/^-$/);

    for (const [index, label] of ["待送检", "入库中", "已完成", "已取消"].entries()) {
      expect(cells(rows[index])[9]).toHaveTextContent(label);
      expect(cells(rows[index])[9]).not.toHaveTextContent(/pending|partially_inbound|completed|cancelled/);
    }
  });

  it("没有入库通知时回落空态而不是空表格", async () => {
    stubApi(() => apiOk(summary({ notices: [], notice_count: 0 })));

    renderPanel();

    expect(await screen.findByText("暂无入库通知")).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();
  });

  it("加载失败时把后端错误信息展示给用户", async () => {
    stubApi(() => apiErr(500, "INTERNAL_ERROR", "成品存量加载失败：数据库不可用"));

    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("成品存量加载失败：数据库不可用");
  });

  it("KNOWN_DEFECT：加载失败后仍然永久显示「正在加载成品存量…」", async () => {
    stubApi(() => apiErr(500, "INTERNAL_ERROR", "成品存量加载失败：数据库不可用"));

    renderPanel();
    await screen.findByRole("alert");

    // 期望：失败后 summary 为空时应显示错误/空态，加载文案消失；
    // 实际：summary 始终为 null，走 `!summary ? 正在加载成品存量…` 分支，
    //       于是错误提示与"正在加载"同时常驻，用户会以为数据还在加载。
    // 责任文件：apps/web/components/production/finished-goods-panel.tsx:144（!summary 分支），
    //          成因：:50 只 setError，未把 summary 置为可区分的错误态。
    expect(screen.getByText("正在加载成品存量…")).toBeVisible();
    expect(screen.queryByText("包装累计报工")).toBeNull();
  });
});

describe("成品存量面板：包装（收尾）工序补建", () => {
  it("缺包装工序时给出警告与「补建包装工序」入口", async () => {
    // 现实数据：没有包装工序 ⇒ 包装累计报工为 0 ⇒ 可通知量为 0
    stubApi(() => apiOk(summary({ packaging_operation: null, packaging_reported_quantity: "0", notified_quantity: "0", available_notice_quantity: "0" })));

    renderPanel();

    expect(await screen.findByText(/该生产单还没有包装（收尾）工序/)).toBeVisible();
    expect(metric("包装工序")).toHaveTextContent("未建立");
    expect(screen.getByRole("button", { name: "补建包装工序" })).toBeEnabled();
    // 没有包装工序就没有可通知量，通知入口必须关掉（后端也会拒绝）
    expect(noticeButton()).toBeDisabled();
  });

  it("点击「补建包装工序」发出 POST，成功后提示并重新拉取汇总、通知父组件", async () => {
    let round = 0;
    const onChanged = vi.fn();
    const calls = stubApi((url) => {
      if (url.endsWith(SUMMARY_SUFFIX)) {
        round += 1;
        return apiOk(round === 1 ? summary({ packaging_operation: null, available_notice_quantity: "0" }) : baseSummary);
      }
      if (url.endsWith(PACKAGING_SUFFIX)) {
        return apiOk({ created: true, operation: { id: "op-pack", name: "包装", sequence_no: 5, target_quantity: "100", status: "active" } });
      }
      return apiOk({});
    });

    renderPanel({ onChanged });
    await screen.findByText("未建立");
    await userEvent.click(screen.getByRole("button", { name: "补建包装工序" }));

    expect(await screen.findByText("已补建包装工序")).toBeVisible();
    const posts = callsTo(calls, PACKAGING_SUFFIX);
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    // 补建接口无入参：body 必须是空对象而不是 undefined（后者会被服务端当成缺体）
    expect(JSON.parse(String(posts[0].body))).toEqual({});
    await waitFor(() => expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // 刷新后包装工序与可通知量进入界面，通知入口随之打开
    await waitFor(() => expect(metric("包装工序")).toHaveTextContent("包装（第 5 道）"));
    await waitFor(() => expect(noticeButton()).toBeEnabled());
  });

  it("补建失败时提示后端原因，且不刷新、不通知父组件", async () => {
    const onChanged = vi.fn();
    const calls = stubApi((url) => {
      if (url.endsWith(PACKAGING_SUFFIX)) return apiErr(422, "PACKAGING_OPERATION_CATALOG_MISSING", "工序主数据里没有启用的「包装」工序，请先建立包装工序");
      return apiOk(summary({ packaging_operation: null, packaging_reported_quantity: "0", available_notice_quantity: "0" }));
    });

    renderPanel({ onChanged });
    await screen.findByText("未建立");
    await userEvent.click(screen.getByRole("button", { name: "补建包装工序" }));

    expect(await screen.findByText("工序主数据里没有启用的「包装」工序，请先建立包装工序")).toBeVisible();
    expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("已有包装工序时入口文案变为「确认包装工序」，点击是幂等确认而不是报错", async () => {
    const calls = stubApi((url) => {
      if (url.endsWith(PACKAGING_SUFFIX)) return apiOk({ created: false, operation: { id: "op-pack", name: "包装", sequence_no: 5, target_quantity: "100", status: "active" } });
      return apiOk(baseSummary);
    });

    renderPanel();
    await screen.findByText("包装累计报工");
    await userEvent.click(screen.getByRole("button", { name: "确认包装工序" }));

    expect(await screen.findByText("该生产单已有包装工序")).toBeVisible();
    expect(callsTo(calls, PACKAGING_SUFFIX)).toHaveLength(1);
  });
});

describe("成品入库通知：入口门禁与创建", () => {
  it("厂内 + 生产中 + 有可通知量时才能发通知", async () => {
    stubApi(() => apiOk(baseSummary));

    renderPanel();
    await screen.findByText("包装累计报工");

    expect(noticeButton()).toBeEnabled();
  });

  it("外加工生产单禁用发通知入口（即使汇总数据说 in_house）", async () => {
    stubApi(() => apiOk(baseSummary));

    renderPanel({ executionMode: "outsourced" });
    await screen.findByText("包装累计报工");

    // 门禁以 props.executionMode 为准，summary.execution_mode 只作展示数据
    expect(noticeButton()).toBeDisabled();
  });

  it("生产单尚未开始（planned）时禁用发通知入口", async () => {
    stubApi(() => apiOk(baseSummary));

    renderPanel({ orderStatus: "planned" });
    await screen.findByText("包装累计报工");

    expect(noticeButton()).toBeDisabled();
  });

  it("已完成的生产单仍可补发通知，但可通知量为 0 时入口关闭", async () => {
    stubApi(() => apiOk(baseSummary));
    const first = renderPanel({ orderStatus: "completed" });
    await screen.findByText("包装累计报工");
    expect(noticeButton()).toBeEnabled();
    first.unmount();

    stubApi(() => apiOk(summary({ available_notice_quantity: "0" })));
    renderPanel();
    await screen.findByText("包装累计报工");
    expect(noticeButton()).toBeDisabled();
  });

  it("打开通知对话框：数量默认取可通知量、日期默认今天，提交后 POST 正确 body 并刷新", async () => {
    const onChanged = vi.fn();
    const calls = stubApi((url) => (url.endsWith(SUMMARY_SUFFIX) ? apiOk(baseSummary) : apiOk({ id: "n-new" })));

    renderPanel({ onChanged });
    await screen.findByText("包装累计报工");
    await userEvent.click(noticeButton());

    const quantity = await screen.findByTestId<HTMLInputElement>("action-field-notice_quantity");
    expect(quantity.value).toBe("40");
    expect(quantity).toHaveAttribute("placeholder", "可通知 40");
    expect(screen.getByTestId<HTMLInputElement>("action-field-notice_date").value).toBe(today());

    await userEvent.type(screen.getByTestId("action-field-batch_no"), "B7");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    const posts = callsTo(calls, NOTICE_SUFFIX);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].method).toBe("POST");
    expect(JSON.parse(String(posts[0].body))).toEqual({
      production_order_id: "po-1",
      notice_quantity: "40",
      notice_date: today(),
      batch_no: "B7",
    });
    expect(await screen.findByText("成品入库通知已发出，仓库可按通知送检/质检")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, SUMMARY_SUFFIX).length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("不填批次/备注时请求体里不出现这两个字段（避免写进空串）", async () => {
    const calls = stubApi((url) => (url.endsWith(SUMMARY_SUFFIX) ? apiOk(baseSummary) : apiOk({ id: "n-new" })));

    renderPanel();
    await screen.findByText("包装累计报工");
    await userEvent.click(noticeButton());
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, NOTICE_SUFFIX)).toHaveLength(1));
    const body = JSON.parse(String(callsTo(calls, NOTICE_SUFFIX)[0].body)) as Record<string, unknown>;
    expect(body).toEqual({ production_order_id: "po-1", notice_quantity: "40", notice_date: today() });
    expect("batch_no" in body).toBe(false);
    expect("remark" in body).toBe(false);
  });

  it("发通知失败时用错误提示暴露后端原因，不刷新也不通知父组件", async () => {
    const onChanged = vi.fn();
    const calls = stubApi((url) => (url.endsWith(SUMMARY_SUFFIX) ? apiOk(baseSummary) : apiErr(422, "INBOUND_NOTICE_QUANTITY_EXCEEDED", "通知数量超过可通知入库量")));

    renderPanel({ onChanged });
    await screen.findByText("包装累计报工");
    await userEvent.click(noticeButton());
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("通知数量超过可通知入库量")).toBeVisible();
    expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
    // 失败后弹窗关闭（用户在 toast 里看到原因），不会把失败当成成功留在界面上
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
  });
});

describe("成品入库通知：取消", () => {
  it("只有未送检且未取消的通知才提供「取消」入口", async () => {
    stubApi(() => apiOk(baseSummary));

    renderPanel();
    const rows = await screen.findAllByTestId("data-table-row");

    // 第 1 行：pending 且送检量为 0 → 可取消
    expect(within(rows[0]).getByRole("button", { name: "取消" })).toBeVisible();
    // 第 2、3 行：已有送检量，后端会 422，界面不应给出必然失败的按钮
    expect(within(rows[1]).queryByRole("button", { name: "取消" })).toBeNull();
    expect(within(rows[2]).queryByRole("button", { name: "取消" })).toBeNull();
    // 第 4 行：已取消 → 不再给入口
    expect(within(rows[3]).queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("取消原因必填：不填直接提交不会发出任何请求", async () => {
    const calls = stubApi((url) => (url.endsWith(SUMMARY_SUFFIX) ? apiOk(baseSummary) : apiOk({})));

    renderPanel();
    const rows = await screen.findAllByTestId("data-table-row");
    await userEvent.click(within(rows[0]).getByRole("button", { name: "取消" }));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写取消原因");
    expect(callsTo(calls, "/cancel")).toHaveLength(0);
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });

  it("提交取消原因后 POST 到该通知的 cancel 端点，提示成功并刷新", async () => {
    const onChanged = vi.fn();
    const calls = stubApi((url) => (url.endsWith(SUMMARY_SUFFIX) ? apiOk(baseSummary) : apiOk({})));

    renderPanel({ onChanged });
    const rows = await screen.findAllByTestId("data-table-row");
    await userEvent.click(within(rows[0]).getByRole("button", { name: "取消" }));
    expect(await screen.findByText("取消入库通知：FGI-001")).toBeVisible();

    await userEvent.type(screen.getByTestId("action-field-reason"), "客户改单，不再入库");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    const posts = callsTo(calls, `${NOTICE_SUFFIX}/n-1/cancel`);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].method).toBe("POST");
    expect(JSON.parse(String(posts[0].body))).toEqual({ reason: "客户改单，不再入库" });
    expect(await screen.findByText("入库通知已取消")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("取消失败时提示后端原因，不会静默吞掉", async () => {
    stubApi((url) => {
      if (url.endsWith(SUMMARY_SUFFIX)) return apiOk(baseSummary);
      return apiErr(422, "INBOUND_NOTICE_ALREADY_SUBMITTED", "该通知已有送检记录，不能取消");
    });

    renderPanel();
    const rows = await screen.findAllByTestId("data-table-row");
    await userEvent.click(within(rows[0]).getByRole("button", { name: "取消" }));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-reason"), "误操作");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("该通知已有送检记录，不能取消")).toBeVisible();
  });
});

describe("成品存量面板：刷新触发", () => {
  it("「刷新」按钮重新拉取汇总", async () => {
    const calls = stubApi(() => apiOk(baseSummary));

    renderPanel();
    await screen.findByText("包装累计报工");
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(2));
  });

  it("收到 production-order-operation-updated 事件时自动刷新并更新界面", async () => {
    let round = 0;
    const calls = stubApi((url) => {
      if (!url.endsWith(SUMMARY_SUFFIX)) return apiOk({});
      round += 1;
      return apiOk(summary({ packaging_reported_quantity: round === 1 ? "60" : "75" }));
    });

    renderPanel();
    await waitFor(() => expect(metric("包装累计报工")).toHaveTextContent("60"));

    await act(async () => {
      window.dispatchEvent(new Event("production-order-operation-updated"));
    });

    await waitFor(() => expect(metric("包装累计报工")).toHaveTextContent("75"));
    expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(2);
  });

  it("页面可见（focus / visibilitychange）时刷新，隐藏时不刷新", async () => {
    const calls = stubApi(() => apiOk(baseSummary));

    renderPanel();
    await screen.findByText("包装累计报工");

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    try {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(2));

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(3));

      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // 后台标签页不该无意义地反复请求
      expect(callsTo(calls, SUMMARY_SUFFIX)).toHaveLength(3);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it("卸载后不再响应任何刷新事件（事件必须解绑，否则泄漏且会对已卸载组件 setState）", async () => {
    const calls = stubApi(() => apiOk(baseSummary));

    const { unmount } = renderPanel();
    await screen.findByText("包装累计报工");
    unmount();
    const before = calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("production-order-operation-updated"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(calls).toHaveLength(before);
  });
});
