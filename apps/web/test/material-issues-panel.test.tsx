// 生产领料面板（MaterialIssuesPanel）的真实行为测试：真实渲染 + 真实点击/输入 + 断言网络调用。
//
// 取代的遗留源码正则测试：
//   - apps/web/lib/production-material-issue-entry.test.mjs（整文件）
//   - apps/web/lib/warehouse-issue-sheet.test.mjs（其中与领料面板相关的部分）
// 那些测试用 readFileSync + 正则匹配 .tsx 文本，只能证明"源码里出现过某个字符串"：
// 把 postMovementPath(...) 换成别的写法、把 disabled 连同 onClick 一起删掉，正则一样绿。
// 这里改为驱动真实组件：打开草稿、填数量、点过账，然后断言**实际发出的请求**与**屏幕上可见的结果**。
//
// 继承的断言意图（逐条落地为行为）：
//   1) 面板只按 production_order_id 拉单据、按 bomId 拉 BOM 明细（不是全量物料）；
//   2) 补料单必须有独立入口（全屏编辑页并带上本生产单）；
//   3) 过账必须按单据类型走 /post 与 /post-replenishment（补料单打错接口会被服务端 422）；
//   4) 重新打开 / 冲销必须带必填原因；
//   5) 编辑草稿要把每行备注带进 PATCH（PATCH 整批替换明细，漏了备注等于清空用户输入）；
//   6) 同一物料只能一行，保存前先拦；
//   7) 先保存草稿再出库（保存成功但过账失败时不得重复建单）。
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";
import { MaterialIssuesPanel } from "../components/production/material-issues-panel";
import { Toaster } from "../components/ui/toaster";

/** 可手动控制兑现时机的 Promise：用于把组件稳定停在"提交中"状态上做禁用断言。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, any>;
const listCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && call.url.includes("/production/material-movements?"));
const lastTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).at(-1)!;

const bomItems = [
  { materialId: "m-1", materialName: "面料A", specificationModel: "150D", requiredQuantity: "5", unit: "米", unitId: "u-1" },
  { materialId: "m-2", materialName: "拉链B", model: "3号", requiredQuantity: "2", unit: "条", unitId: "u-2" },
];

/** bomId 为空时面板回落到主数据：只列启用的原料（包装材料与停用原料不得出现）。 */
const materials = [
  { id: "m-9", materialCode: "RM-9", name: "原料C", materialType: "raw_material", isActive: true },
  { id: "m-8", materialCode: "PK-8", name: "包装箱", materialType: "packaging", isActive: true },
  { id: "m-7", name: "停用原料", materialType: "raw_material", isActive: false },
];

type Movement = Record<string, any>;
const movement = (over: Movement): Movement => ({
  documentType: "issue",
  status: "draft",
  businessDate: "2026-01-02",
  createdAt: "2026-01-02T03:04:05.000Z",
  remark: null,
  reason: null,
  lines: [{ id: "l-1", materialId: "m-1", quantity: "3", remark: null, unit: { name: "米" }, material: { materialCode: "RM-1", name: "面料A" } }],
  ...over,
});

type ApiRoutes = {
  movements?: (call: StubbedCall) => Response | Promise<Response>;
  bom?: (call: StubbedCall) => Response | Promise<Response>;
  materials?: (call: StubbedCall) => Response | Promise<Response>;
  preview?: (call: StubbedCall) => Response | Promise<Response>;
  create?: (call: StubbedCall) => Response | Promise<Response>;
  patch?: (call: StubbedCall) => Response | Promise<Response>;
  /** 兜底钩子：按 URL 拦截任意请求（过账 / reopen / reverse / 删除），返回 undefined 表示不拦截。 */
  actions?: (url: string, call: StubbedCall) => Response | Promise<Response> | undefined;
};

/** 默认预览桩：按请求里的物料行数回同样行数的预估，数值便于断言。 */
function defaultPreview(call: StubbedCall) {
  const body = bodyOf(call) as { lines: Array<{ material_id: string }> };
  return apiOk({
    lines: body.lines.map((line, index) => ({
      material_id: line.material_id,
      material_name: index === 0 ? "面料A" : "拉链B",
      material_code: index === 0 ? "RM-1" : "RM-2",
      bom_reference_quantity: "5",
      inventory_quantity: "12",
      available_before: "12",
      available_after: "7",
      cumulative_issued_after: "2",
      production_outstanding_quantity: "3",
      risks: index === 0 ? [{ type: "OVER_ISSUE_WARNING" }] : [],
    })),
  });
}

function stubPanelApi(routes: ApiRoutes = {}) {
  return stubApi((url, call) => {
    const intercepted = routes.actions?.(url, call);
    if (intercepted) return intercepted;
    if (url.endsWith("/issue-preview")) return routes.preview?.(call) ?? defaultPreview(call);
    if (url.includes("/boms/")) return routes.bom?.(call) ?? apiOk({ items: bomItems });
    if (url.endsWith("/materials")) return routes.materials?.(call) ?? apiOk(materials);
    if (url.includes("/production/material-movements")) {
      if (call.method === "GET") return routes.movements?.(call) ?? apiOk([]);
      if (call.method === "POST" && url.endsWith("/production/material-movements")) return routes.create?.(call) ?? apiOk({ id: "mv-created" });
      if (call.method === "PATCH") return routes.patch?.(call) ?? apiOk({ id: "mv-1" });
      if (call.method === "POST") return apiOk({});
      if (call.method === "DELETE") return apiOk({});
    }
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

function renderPanel(props: { productionOrderId?: string; bomId?: string | null; issuable?: boolean } = {}) {
  const onChanged = vi.fn();
  const view = render(
    <>
      <Toaster />
      <MaterialIssuesPanel
        productionOrderId={props.productionOrderId ?? "MO-1"}
        bomId={props.bomId === undefined ? "bom-1" : props.bomId}
        issuable={props.issuable ?? true}
        onChanged={onChanged}
      />
    </>
  );
  return { onChanged, ...view };
}

const movementRows = () => screen.getAllByTestId("data-table-row");
/** 草稿编辑表格的数据行（第 0 行是表头）。 */
function draftRows() {
  const tables = screen.getAllByRole("table");
  return within(tables[0]).getAllByRole("row").slice(1);
}
const newIssueButton = () => screen.getByRole("button", { name: /新建领料单|正在编辑草稿/ });
const openCreate = async () => userEvent.click(newIssueButton());

describe("MaterialIssuesPanel：加载、入口与权限提示", () => {
  it("首屏按 production_order_id 拉单据、按 bomId 拉 BOM 明细，并渲染单据行的类型/状态/明细合计", async () => {
    const calls = stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" }), movement({ id: "mv-2", movementNo: "MI-002", status: "posted", lines: [{ id: "l-1", materialId: "m-1", quantity: "2" }, { id: "l-2", materialId: "m-2", quantity: "4" }] })]),
    });
    renderPanel();

    expect(await screen.findByText("MI-001")).toBeVisible();
    expect(screen.getByText("MI-002")).toBeVisible();

    // 只查本生产单的单据，且 BOM 明细按该生产单的 bomId 拉取（不是全量 /materials）
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/v1/production/material-movements?production_order_id=MO-1" });
    expect(calls.some((call) => call.url.endsWith("/boms/bom-1"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/materials"))).toBe(false);

    const rows = movementRows();
    // 类型与状态走本地化文案，而不是原始英文枚举
    expect(rows[0]).toHaveTextContent("领料单");
    expect(rows[0]).toHaveTextContent("草稿");
    expect(rows[0]).toHaveTextContent("1 项 / 合计 3");
    expect(rows[1]).toHaveTextContent("已过账");
    expect(rows[1]).toHaveTextContent("2 项 / 合计 6");
    // 业务日期只显示到天
    expect(rows[0]).toHaveTextContent("2026-01-02");
  });

  it("没有单据时显示空态（而不是空表格）", async () => {
    stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();

    expect(await screen.findByTestId("empty-state")).toHaveTextContent("该生产单暂无领料单");
    expect(screen.queryByTestId("data-table")).toBeNull();
  });

  it("单据加载失败时把服务端消息显示为错误（不静默吞掉）", async () => {
    stubPanelApi({ movements: () => apiErr(500, "INTERNAL", "领料服务暂不可用") });
    renderPanel();

    expect(await screen.findByText("领料服务暂不可用")).toBeVisible();
  });

  it("BOM 明细拉取失败不阻塞单据列表，但提示无可选物料并禁用新建", async () => {
    stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" })]),
      bom: () => apiErr(500, "INTERNAL", "BOM 查询失败"),
    });
    renderPanel();

    // 单据照常渲染：BOM 失败被 .catch 兜成空列表，不得变成整页错误
    expect(await screen.findByText("MI-001")).toBeVisible();
    expect(await screen.findByText(/该生产单没有可选物料/)).toBeVisible();
    expect(newIssueButton()).toBeDisabled();
  });

  it("非生产中订单：给出可读原因并禁用新建领料单", async () => {
    stubPanelApi({ movements: () => apiOk([]) });
    renderPanel({ issuable: false });

    expect(await screen.findByText(/只有「生产中」的厂内生产单可以领料/)).toBeVisible();
    // 补料单入口不受 issuable 影响（它走独立页面），领料入口必须关闭
    expect(newIssueButton()).toBeDisabled();
    expect(screen.getByRole("link", { name: "新建补料单" })).toBeVisible();
  });

  it("「新建补料单」跳转到全屏编辑页并带上本生产单 id", async () => {
    stubPanelApi({ movements: () => apiOk([]) });
    renderPanel({ productionOrderId: "MO-7" });

    const link = await screen.findByRole("link", { name: "新建补料单" });
    expect(link).toHaveAttribute("href", "/production/material-issues/new?type=replenishment&production_order_id=MO-7");
  });

  it("「刷新」会重新拉取该生产单的单据", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");
    expect(listCalls(calls)).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
  });
});

describe("MaterialIssuesPanel：新建草稿与 BOM 预估", () => {
  it("新建领料单：渲染草稿表格，并按 BOM 首项请求 issue-preview，预估列随之渲染", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");

    await openCreate();

    const preview = await screen.findByText("超出 BOM 用量");
    expect(preview).toBeVisible();
    const previewCall = lastTo(calls, "/issue-preview");
    expect(previewCall.method).toBe("POST");
    expect(bodyOf(previewCall)).toEqual({
      production_order_id: "MO-1",
      lines: [{ material_id: "m-1", quantity: "1" }],
    });

    // 草稿行：BOM 核定用量 / 当前库存 / 已领累计 / 未领用 都来自预估响应
    const row = draftRows()[0];
    expect(row).toHaveTextContent("面料A");
    expect(row).toHaveTextContent("5");
    expect(row).toHaveTextContent("12");
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("3");
    expect(within(row).getByRole("spinbutton")).toHaveValue(1);
  });

  it("草稿行的物料下拉列出的是该生产单的 BOM 明细（含规格与核定用量）", async () => {
    stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();

    await userEvent.click(within(draftRows()[0]).getByRole("combobox"));

    expect(await screen.findByRole("option", { name: "面料A / 150D（BOM 5 米）" })).toBeVisible();
    expect(screen.getByRole("option", { name: "拉链B / 3号（BOM 2 条）" })).toBeVisible();
  });

  it("没有 bomId 时回落到原料主数据，且只列启用的原料", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel({ bomId: null });
    await screen.findByTestId("empty-state");
    expect(calls.some((call) => call.url.endsWith("/materials"))).toBe(true);

    await openCreate();

    // 默认选中第一条可用原料：既排除包装箱也排除停用原料
    await waitFor(() => expect(lastTo(calls, "/issue-preview")).toBeTruthy());
    expect(bodyOf(lastTo(calls, "/issue-preview")).lines).toEqual([{ material_id: "m-9", quantity: "1" }]);
    const options = screen.queryAllByRole("option");
    expect(options.map((option) => option.textContent)).not.toContain("包装箱 / PK-8");
  });

  it("添加行默认选未用过的物料并重新预估；物料用尽后「添加行」禁用", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "添加行" }));

    expect(draftRows()).toHaveLength(2);
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(2));
    expect(bodyOf(lastTo(calls, "/issue-preview")).lines).toEqual([
      { material_id: "m-1", quantity: "1" },
      { material_id: "m-2", quantity: "1" },
    ]);
    // BOM 只有两项，都已登记：再加行只会产生重复物料
    expect(screen.getByRole("button", { name: "添加行" })).toBeDisabled();
  });

  it("修改数量会带上新数量重新预估", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    const input = within(draftRows()[0]).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "7");

    await waitFor(() => expect(bodyOf(lastTo(calls, "/issue-preview")).lines).toEqual([{ material_id: "m-1", quantity: "7" }]));
  });

  it("「取消」关闭草稿并回到列表", async () => {
    stubPanelApi({ movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" })]) });
    renderPanel();
    await screen.findByText("MI-001");
    await openCreate();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
    expect(newIssueButton()).toBeEnabled();
  });
});

describe("MaterialIssuesPanel：保存草稿的客户端校验", () => {
  it("行删光后保存被拦下，且不发任何请求", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();

    await userEvent.click(within(draftRows()[0]).getByRole("button", { name: "删除" }));
    expect(draftRows()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(await screen.findByText("领料单至少需要一条物料明细")).toBeVisible();
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(0);
  });

  it("数量为 0 时保存被拦下（服务端会判非法，先在前端挡住）", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]) });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();

    const input = within(draftRows()[0]).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(await screen.findByText("每一行都必须选择物料并填写大于 0 的数量")).toBeVisible();
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(0);
  });

  it("同一物料出现两行时保存被拦下（服务端 422，先在前端挡住）", async () => {
    const duplicated = movement({
      id: "mv-dupe",
      movementNo: "MI-003",
      lines: [
        { id: "l-1", materialId: "m-1", quantity: "3", remark: null },
        { id: "l-2", materialId: "m-1", quantity: "2", remark: null },
      ],
    });
    const calls = stubPanelApi({ movements: () => apiOk([duplicated]) });
    renderPanel();
    await screen.findByText("MI-003");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "编辑" }));
    expect(draftRows()).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(await screen.findByText("同一物料只能有一行：请合并数量后再保存")).toBeVisible();
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });
});

describe("MaterialIssuesPanel：保存与出库（含防重复提交）", () => {
  it("保存草稿成功后：POST 建单携带生产单与明细，草稿关闭、列表重新拉取、回调 onChanged", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([]), create: () => apiOk({ id: "mv-created" }) });
    const { onChanged } = renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements")).toHaveLength(1));
    const created = lastTo(calls, "/production/material-movements");
    expect(created.method).toBe("POST");
    expect(bodyOf(created)).toEqual({ production_order_id: "MO-1", lines: [{ material_id: "m-1", quantity: "1" }] });

    // 成功后回到列表态：草稿表格消失、单据重新拉取、上层被通知刷新
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull());
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("领料单已生成（草稿）")).toBeVisible();
  });

  it("保存草稿失败时：显示服务端消息且草稿保留（用户可改后重试）", async () => {
    stubPanelApi({ movements: () => apiOk([]), create: () => apiErr(422, "VALIDATION_ERROR", "物料 m-1 不在 BOM 中") });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();

    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(await screen.findByText("物料 m-1 不在 BOM 中")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeEnabled();
    expect(draftRows()).toHaveLength(1);
  });

  it("保存并出库：先建单再按类型过账（带幂等键），成功后回调 onChanged", async () => {
    const calls = stubPanelApi({
      movements: () => apiOk([]),
      create: () => apiOk({ id: "mv-created" }),
      actions: (url) => (url.endsWith("/production/material-movements/mv-created/post") ? apiOk({}) : undefined),
    });
    const { onChanged } = renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-created/post")).toHaveLength(1));
    const postCall = lastTo(calls, "/production/material-movements/mv-created/post");
    expect(postCall.method).toBe("POST");
    const postBody = bodyOf(postCall);
    expect(typeof postBody.idempotency_key).toBe("string");
    expect(postBody.idempotency_key).toMatch(/^web-issue-/);
    // 必须先建单后过账：建单请求早于过账请求
    expect(calls.indexOf(lastTo(calls, "/production/material-movements"))).toBeLessThan(calls.indexOf(postCall));
    expect(await screen.findByText("领料单已过账出库")).toBeVisible();
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull());
  });

  it("保存成功但过账失败：草稿保留并记住 id，重试走 PATCH 而不是再次建单", async () => {
    let postAttempts = 0;
    const calls = stubPanelApi({
      movements: () => apiOk([]),
      create: () => apiOk({ id: "mv-created" }),
      actions: (url) => {
        if (!url.endsWith("/production/material-movements/mv-created/post")) return undefined;
        postAttempts += 1;
        return postAttempts === 1 ? apiErr(422, "VALIDATION_ERROR", "该单据不是领料单") : apiOk({});
      },
    });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));

    // 草稿必须保留（否则用户填的内容全丢），且已经记住 id
    await waitFor(() => expect(screen.getByRole("button", { name: "保存并出库" })).toBeEnabled());
    expect(draftRows()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    expect(lastTo(calls, "/production/material-movements/mv-created").method).toBe("PATCH");
    // 只有第一次那一次建单，重试没有再 POST 建单
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(1);
    expect(await screen.findByText("领料单已过账出库")).toBeVisible();
  });

  // KNOWN_DEFECT：过账失败的用户提示永远看不到。
  //   期望：过账失败后用户能看到「已保存，但过账失败（可稍后在列表中过账）」，从而知道单已建、只差出库。
  //   实际：saveAndPost 的 catch 里 setError(该文案) 之后紧接着 await load()，
  //         而 load() 第一行是 setError("")（material-issues-panel.tsx:52），
  //         两次 setState 在同一个同步块内被批处理合并，最终 error 恒为空串，界面上不出现任何提示、也没有 toast。
  //         责任位置：apps/web/components/production/material-issues-panel.tsx:132（catch 内 setError 后立刻 load）与 :52（load 开头 setError("")）。
  //   若后续修复（例如 load 不再清空错误，或改为 notifyError），本用例应当改成断言提示可见。
  it("【KNOWN_DEFECT】保存成功但过账失败时，界面上看不到任何失败提示", async () => {
    const calls = stubPanelApi({
      movements: () => apiOk([]),
      create: () => apiOk({ id: "mv-created" }),
      actions: (url) => (url.endsWith("/production/material-movements/mv-created/post") ? apiErr(422, "VALIDATION_ERROR", "该单据不是领料单") : undefined),
    });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));
    // 失败后组件会重新拉列表：等它稳定下来再看用户到底能看到什么
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));

    expect(screen.queryByText(/已保存，但过账失败/)).toBeNull();
    expect(screen.queryByText("该单据不是领料单")).toBeNull();
    // 唯一的 toast 来自「建单成功」那一步；用户点的是「保存并出库」，却只看到「领料单已生成（草稿）」
    for (const toast of screen.queryAllByTestId("toast-item")) expect(toast).not.toHaveTextContent("失败");
    expect(screen.getAllByTestId("toast-item")).toHaveLength(1);
    // 唯一可见的结果：草稿被保留、按钮回到可点（用户只能自己猜发生了什么）
    expect(screen.getByRole("button", { name: "保存并出库" })).toBeEnabled();
  });

  it("保存中：按钮改文案并禁用，连点不会重复建单；此时点「保存并出库」被 busy 门禁挡住", async () => {
    const gate = deferred<Response>();
    const calls = stubPanelApi({ movements: () => apiOk([]), create: () => gate.promise });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();

    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    const pending = await screen.findByRole("button", { name: "保存中..." });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);

    // 保存中再点「保存并出库」：saveAndPost 开头的 if (busy) return 挡住，不会多建单
    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/post"))).toHaveLength(0);

    await act(async () => {
      gate.resolve(apiOk({ id: "mv-created" }));
    });
  });

  // KNOWN_DEFECT：过账进行中「保存草稿」没有被禁用，会重复建单。
  //   期望：busy === "post" 期间「保存草稿」也应禁用（与「保存并出库」对称），否则一个生产单会被建出两张领料单。
  //   实际：「保存草稿」只判断 busy === "save"（material-issues-panel.tsx:197），
  //         而 save() 不含 if (busy) return 守卫（:118-123），此时草稿 state 尚未带上 id（id 只在过账成功/失败后才写回），
  //         于是 saveDraft() 又发一次 POST /production/material-movements，产生重复单据。
  //   责任位置：apps/web/components/production/material-issues-panel.tsx:197（disabled 条件）与 :118（save 缺 busy 守卫）。
  //   若后续修复（禁用按钮或给 save 加守卫），本用例应改成断言只发出一次建单请求。
  it("【KNOWN_DEFECT】出库过账进行中仍能点「保存草稿」，导致重复建单", async () => {
    const postGate = deferred<Response>();
    const calls = stubPanelApi({
      movements: () => apiOk([]),
      create: () => apiOk({ id: "mv-created" }),
      actions: (url) => (url.endsWith("/production/material-movements/mv-created/post") ? postGate.promise : undefined),
    });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));
    await screen.findByRole("button", { name: "过账中..." });
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(1);

    const saveDraft = screen.getByRole("button", { name: "保存草稿" });
    expect(saveDraft).toBeEnabled();
    await userEvent.click(saveDraft);

    // 实际：第二次 POST 建单（同一生产单两张草稿）
    await waitFor(() => expect(callsTo(calls, "/production/material-movements")).toHaveLength(2));

    await act(async () => {
      postGate.resolve(apiOk({}));
    });
  });

  it("过账中：按钮改文案并禁用，连点只发一次过账", async () => {
    const gate = deferred<Response>();
    const calls = stubPanelApi({
      movements: () => apiOk([]),
      create: () => apiOk({ id: "mv-created" }),
      actions: (url) => (url.endsWith("/production/material-movements/mv-created/post") ? gate.promise : undefined),
    });
    renderPanel();
    await screen.findByTestId("empty-state");
    await openCreate();
    await waitFor(() => expect(callsTo(calls, "/issue-preview")).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "保存并出库" }));

    const pending = await screen.findByRole("button", { name: "过账中..." });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);

    expect(callsTo(calls, "/production/material-movements/mv-created/post")).toHaveLength(1);

    await act(async () => {
      gate.resolve(apiOk({}));
    });
  });
});

describe("MaterialIssuesPanel：列表行操作", () => {
  it("草稿行「过账出库」打到 /post（领料单），成功后回调 onChanged 并刷新列表", async () => {
    const calls = stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" })]),
      actions: (url) => (url.endsWith("/production/material-movements/mv-1/post") ? apiOk({}) : undefined),
    });
    const { onChanged } = renderPanel();
    await screen.findByText("MI-001");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "过账出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-1/post")).toHaveLength(1));
    const postCall = lastTo(calls, "/production/material-movements/mv-1/post");
    expect(postCall.method).toBe("POST");
    expect(bodyOf(postCall).idempotency_key).toMatch(/^web-issue-/);
    expect(callsTo(calls, "/post-replenishment")).toHaveLength(0);
    expect(await screen.findByText("领料单已过账出库")).toBeVisible();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
  });

  it("补料单草稿行走 /post-replenishment（打 /post 会被服务端判成「不是领料单」）", async () => {
    const calls = stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-2", movementNo: "MC-001", documentType: "replenishment" })]),
      actions: (url) => (url.endsWith("/production/material-movements/mv-2/post-replenishment") ? apiOk({}) : undefined),
    });
    renderPanel();
    await screen.findByText("MC-001");
    expect(movementRows()[0]).toHaveTextContent("补料单");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "过账出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-2/post-replenishment")).toHaveLength(1));
    expect(callsTo(calls, "/production/material-movements/mv-2/post")).toHaveLength(0);
    expect(await screen.findByText("补料单已过账出库")).toBeVisible();
  });

  it("过账失败时弹出错误提示，且不误报成功", async () => {
    stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" })]),
      actions: (url) => (url.endsWith("/production/material-movements/mv-1/post") ? apiErr(422, "VALIDATION_ERROR", "库存不足，无法出库") : undefined),
    });
    renderPanel();
    await screen.findByText("MI-001");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "过账出库" }));

    expect(await screen.findByText("库存不足，无法出库")).toBeVisible();
    expect(screen.queryByText("领料单已过账出库")).toBeNull();
  });

  it("草稿行「删除」发 DELETE 并回调 onChanged", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" })]) });
    const { onChanged } = renderPanel();
    await screen.findByText("MI-001");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
    expect(lastTo(calls, "/production/material-movements/mv-1").method).toBe("DELETE");
    expect(await screen.findByText("领料草稿已删除")).toBeVisible();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("行操作进行中：该行的编辑/过账/删除同时禁用，连点只发一次", async () => {
    const gate = deferred<Response>();
    const calls = stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001" })]),
      actions: (url) => (url.endsWith("/production/material-movements/mv-1/post") ? gate.promise : undefined),
    });
    renderPanel();
    await screen.findByText("MI-001");
    const row = movementRows()[0];

    await userEvent.click(within(row).getByRole("button", { name: "过账出库" }));

    await waitFor(() => expect(within(row).getByRole("button", { name: "过账出库" })).toBeDisabled());
    expect(within(row).getByRole("button", { name: "编辑" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "删除" })).toBeDisabled();
    await userEvent.click(within(row).getByRole("button", { name: "过账出库" }));
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));

    expect(callsTo(calls, "/production/material-movements/mv-1/post")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);

    await act(async () => {
      gate.resolve(apiOk({}));
    });
  });

  it("编辑草稿：数量改动走 PATCH，并原样带回每行备注（PATCH 整批替换明细）", async () => {
    const calls = stubPanelApi({
      movements: () => apiOk([movement({ id: "mv-1", movementNo: "MI-001", lines: [{ id: "l-1", materialId: "m-1", quantity: "3", remark: "首批染色" }] })]),
    });
    const { onChanged } = renderPanel();
    await screen.findByText("MI-001");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "编辑" }));
    const input = within(draftRows()[0]).getByRole("spinbutton");
    expect(input).toHaveValue(3);
    await userEvent.clear(input);
    await userEvent.type(input, "4");
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    const patchCall = calls.find((call) => call.method === "PATCH")!;
    expect(patchCall.url).toBe("/api/v1/production/material-movements/mv-1");
    expect(bodyOf(patchCall)).toEqual({
      production_order_id: "MO-1",
      lines: [{ material_id: "m-1", quantity: "4", remark: "首批染色" }],
    });
    // 编辑已存在的草稿不得再建新单
    expect(callsTo(calls, "/production/material-movements")).toHaveLength(0);
    expect(await screen.findByText("领料单草稿已保存")).toBeVisible();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("已过账行只提供「重新打开 / 冲销」，且都必须填原因", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([movement({ id: "mv-2", movementNo: "MI-002", status: "posted" })]) });
    renderPanel();
    await screen.findByText("MI-002");
    const row = movementRows()[0];

    expect(within(row).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "删除" })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "重新打开" }));

    // 原因必填：空着提交被挡下，且不发请求
    expect(await screen.findByTestId("action-dialog")).toBeVisible();
    expect(screen.getByRole("heading", { name: "重新打开领料单：MI-002" })).toBeVisible();
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写重新打开原因");
    expect(callsTo(calls, "/reopen")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "车间多领了");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-2/reopen")).toHaveLength(1));
    expect(bodyOf(lastTo(calls, "/reopen"))).toEqual({ reason: "车间多领了" });
    expect(await screen.findByText("领料单已重新打开为草稿")).toBeVisible();
  });

  it("冲销带原因与幂等键，成功后回调 onChanged", async () => {
    const calls = stubPanelApi({ movements: () => apiOk([movement({ id: "mv-2", movementNo: "MI-002", status: "posted" })]) });
    const { onChanged } = renderPanel();
    await screen.findByText("MI-002");

    await userEvent.click(within(movementRows()[0]).getByRole("button", { name: "冲销" }));
    expect(await screen.findByRole("heading", { name: "冲销领料单：MI-002" })).toBeVisible();
    await userEvent.type(screen.getByTestId("action-field-reason"), "发错料");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-2/reverse")).toHaveLength(1));
    const reverseBody = bodyOf(lastTo(calls, "/reverse"));
    expect(reverseBody.reason).toBe("发错料");
    expect(reverseBody.idempotency_key).toMatch(/^web-issue-/);
    expect(await screen.findByText("领料单已冲销")).toBeVisible();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("已冲销行不再提供任何操作按钮", async () => {
    stubPanelApi({ movements: () => apiOk([movement({ id: "mv-3", movementNo: "MI-003", status: "reversed" })]) });
    renderPanel();
    await screen.findByText("MI-003");

    const row = movementRows()[0];
    expect(row).toHaveTextContent("已冲销");
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });
});
