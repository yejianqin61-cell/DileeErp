// 采购 → BOM表 页面（app/procurement/boms/page.tsx）的**行为**测试：BOM 表里的「新建物料」。
//
// 背景（用户 2026-09-16：「BOM表的新建物料按钮怎么不见了」）：拆成枢纽页时，这一页把
// BomWorkbench 的 onCreateMaterial 接成了空函数 —— 按钮在、点了没反应；生产侧干脆不传。
// 现在三处入口都挂共享的 MaterialCreateDialog，本文件覆盖「采购 → BOM表」这条：
//   点「新建物料」→ 弹窗填表 → POST /materials → 新物料进物料池并回填当前行 → 保存BOM表带上它。
//
// 纪律：真实渲染 + 真实点击 + 真实 fetch 桩；不 mock 模块。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BomsPage from "../app/procurement/boms/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  salesOrders: "/api/v1/sales-orders",
  boms: "/api/v1/boms",
  materials: "/api/v1/materials",
  units: "/api/v1/units",
} as const;

const bomWithOneItem = {
  id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", status: "draft", version: 1, updatedAt: "2026-09-16T02:00:00.000Z",
  items: [{ id: "bi-1", materialId: "m-1", materialName: "面料A", model: "", specificationModel: "150D", color: "本白", requiredQuantity: "3", unit: "米", unitId: "u-1", materialSnapshot: {} }],
};

function stubBomsPage() {
  return stubApi((url, call) => {
    // 按**前缀**匹配：这一页取的是 `/sales-orders?status=confirmed&page=1&page_size=200`
    // （2026-10-13 修：原来取的是不带状态、默认 20 张的 `/sales-orders`，再在页面上过滤已确认 ——
    // 订单一多那一页就空了，连「新建BOM表」按钮都看不到）。
    if (url.startsWith(EP.salesOrders)) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
    if (url === EP.boms) return apiOk([{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
    if (url === EP.materials && call.method === "POST") return apiOk({ id: "m-9", materialCode: "M-009", name: "伞骨", specificationModel: "60cm", color: "银色", defaultUnitId: "u-1", materialType: "raw_material", isActive: true });
    if (url === EP.materials) return apiOk([{ id: "m-1", materialCode: "M-001", name: "面料A", defaultUnitId: "u-1", materialType: "raw_material", isActive: true }]);
    if (url === EP.units) return apiOk([{ id: "u-1", name: "米", isActive: true }]);
    if (url === `${EP.boms}/bom-1` && call.method === "GET") return apiOk(bomWithOneItem);
    if (url === `${EP.boms}/bom-1/items` && call.method === "PUT") return apiOk(bomWithOneItem);
    return apiOk([]);
  });
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const dialog = () => within(screen.getByTestId("action-dialog"));

async function openBom() {
  render(<><BomsPage /><Toaster /></>);
  await screen.findByTestId("page-procurement-boms");
  await userEvent.click(await screen.findByRole("button", { name: "编辑BOM表" }));
  await screen.findByDisplayValue("3");
}

describe("采购 → BOM表：新建物料按钮真的能用", () => {
  it("点「新建物料」打开共享弹窗，建完回填当前行并随保存发出 material_id", async () => {
    const calls = stubBomsPage();
    await openBom();

    await userEvent.click(screen.getByRole("button", { name: "新建物料" }));
    expect(await screen.findByTestId("action-dialog")).toBeVisible();

    // 物料名称的输入框要**在弹窗里找**：BOM 行上那个物料下拉的可访问名也叫「物料名称」
    // （2026-10-13 换成可搜索下拉后它带上了 aria-label），全局 `getByLabelText(/物料名称/)` 会撞两个。
    await userEvent.type(dialog().getByLabelText(/物料名称/), "伞骨");
    await userEvent.click(dialog().getByTestId("action-field-default_unit_id"));
    await userEvent.click(await screen.findByRole("option", { name: "米" }));
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    // 1) 新物料先落进物料池（BOM 行的物料下拉靠 options 渲染名字）
    await waitFor(() => expect(callsTo(calls, "/materials").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/materials").find((call) => call.method === "POST")!)).toMatchObject({ name: "伞骨", default_unit_id: "u-1" });
    // 弹窗关闭，且那一行显示的是新物料（而不是空白下拉）
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
    expect(await screen.findByText("M-009 / 伞骨")).toBeVisible();
    // 物料的规格型号/颜色按主数据带进行里
    expect(screen.getByDisplayValue("60cm")).toBeVisible();
    expect(screen.getByDisplayValue("银色")).toBeVisible();

    // 2) 保存 BOM：发出去的明细里是新物料
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await waitFor(() => expect(callsTo(calls, "/boms/bom-1/items").filter((call) => call.method === "PUT")).toHaveLength(1));
    const items = bodyOf(callsTo(calls, "/boms/bom-1/items").find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ material_id: "m-9", material_name: "伞骨", specification_model: "60cm", color: "银色" });
  });

  it("物料建失败时弹窗保持打开、不动 BOM 行、也不发出保存请求", async () => {
    const calls = stubApi((url, call) => {
      if (url.startsWith(EP.salesOrders)) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
      if (url === EP.boms) return apiOk([{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
      if (url === EP.materials && call.method === "POST") return apiErr(409, "MATERIAL_DUPLICATE", "同名同规格同颜色的物料已存在");
      if (url === EP.materials) return apiOk([{ id: "m-1", materialCode: "M-001", name: "面料A", defaultUnitId: "u-1", materialType: "raw_material", isActive: true }]);
      if (url === EP.units) return apiOk([{ id: "u-1", name: "米", isActive: true }]);
      if (url === `${EP.boms}/bom-1` && call.method === "GET") return apiOk(bomWithOneItem);
      return apiOk([]);
    });
    await openBom();

    await userEvent.click(screen.getByRole("button", { name: "新建物料" }));
    await screen.findByTestId("action-dialog");
    await userEvent.type(dialog().getByLabelText(/物料名称/), "面料A");
    await userEvent.click(dialog().getByTestId("action-field-default_unit_id"));
    await userEvent.click(await screen.findByRole("option", { name: "米" }));
    await userEvent.click(dialog().getByTestId("action-dialog-submit"));

    // 失败原因留在弹窗里，用户不用重填
    expect(await screen.findByRole("alert")).toHaveTextContent("同名同规格同颜色的物料已存在");
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    expect(screen.getByDisplayValue("面料A")).toBeVisible();
    // BOM 行没被改动，也没有任何 BOM 写请求
    expect(callsTo(calls, "/boms/bom-1/items")).toEqual([]);
  });
});

/**
 * 用户 2026-10-13：「采购模块，BOM表，没有新建 BOM 表的地方。只要有销售单事实的单子，
 * 就要允许也在采购中创建保存编辑 BOM 表。」
 *
 * 根因是**取数**：这一页原来取 `/sales-orders`（不带状态、默认只取最近 20 张）再在页面上
 * 按「已确认」过滤 —— 订单一多 / 最近动过的单恰好都是草稿，整页就空（连按钮都没有），
 * 更早的已确认单也永远轮不到。现在与生产页一致：服务端按已确认筛、一次 200 张。
 */
describe("采购 → BOM表：已确认销售单列全（2026-10-13）", () => {
  it("按 status=confirmed&page_size=200 取销售单，不再「最近 20 张里挑已确认的」", async () => {
    const calls = stubBomsPage();
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");

    // `callsTo` 是**后缀**匹配，而这条请求带查询串 —— 这里按前缀自己筛。
    const salesOrderCalls = calls.filter((call) => call.url.startsWith("/api/v1/sales-orders"));
    expect(salesOrderCalls).toHaveLength(1);
    expect(salesOrderCalls[0].url).toContain("status=confirmed");
    expect(salesOrderCalls[0].url).toContain("page_size=200");
    // 服务端给的每一张单都有入口（不是被前端再筛一遍）
    expect(await screen.findByRole("button", { name: "编辑BOM表" })).toBeVisible();
  });

  it("一张已确认单都没有时，说清「还有 N 张草稿没确认」而不是只写一句「暂无」", async () => {
    stubApi((url, call) => {
      if (url.startsWith(`${EP.salesOrders}?status=draft`)) return Response.json({ data: [], meta: { total: 7 } });
      if (url.startsWith(EP.salesOrders)) return apiOk([]);
      if (url === EP.boms) return apiOk([]);
      if (url === EP.materials) return apiOk([]);
      if (url === EP.units) return apiOk([]);
      return apiOk([]);
    });
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");

    expect(await screen.findByText(/还有 7 张销售单是草稿/)).toBeVisible();
    expect(screen.getByText(/请先到【销售】确认/)).toBeVisible();
  });
});

/**
 * 删除 BOM 表（2026-11-05）。
 *
 * 用户原话：「想修改销售单，但是销售单显示 bom 表已经建立，但是 bom 其实也没有填入内容，
 * 这时候怎么办？可不可以增加一个 Bom 表的删除键？」—— 空 BOM 被当成下游事实、BOM 又不可删，
 * 是一条死路。契约见 `docs/design/bom-delete-and-empty-shell-release-2026-11-05.md` §4：
 *   - `GET /boms/:id/delete-preview` 给 `deletable` / `blocked_reason` / `reason_required`；
 *   - 空壳一键删（不填原因）；有明细/有计划必填原因；被采购单/生产单引用则拒绝并说明下一步。
 *
 * 这里钉的是**交互**：不静默删、不拿 salesOrderId 当删除目标、需要时原因真的发出去。
 */
const deletePreview = (overrides: Record<string, unknown> = {}) => ({
  bom_id: "bom-1", order_no: "SO-1", version: 1, status: "draft",
  item_count: 0, purchase_plan: null, purchase_order_count: 0, production_order_count: 0,
  deletable: true, blocked_reason: null, reason_required: false,
  ...overrides,
});

describe("采购 → BOM表：删除 BOM（2026-11-05）", () => {
  it("空 BOM 一键删：弹窗里没有原因框，确认后发 DELETE（不带 body）并刷新列表", async () => {
    let deletedBom = false;
    const calls = stubApi((url, call) => {
      if (url.startsWith(EP.salesOrders)) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
      if (url === EP.boms && call.method === "GET") return apiOk(deletedBom ? [] : [{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
      if (url === `${EP.boms}/bom-1/delete-preview` && call.method === "GET") return apiOk(deletePreview());
      if (url === `${EP.boms}/bom-1` && call.method === "DELETE") {
        deletedBom = true;
        return apiOk({ id: "bom-1", order_no: "SO-1", version: 1, deleted: true, item_count: 0 });
      }
      return apiOk([]);
    });
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");

    // 这一行已有 BOM：两个入口都要在（编辑 + 删除）
    expect(await screen.findByRole("button", { name: "编辑BOM表" })).toBeVisible();
    await userEvent.click(await screen.findByTestId("bom-delete-SO-1"));

    // 影响面写清楚（明细 / 采购单 / 生产单），且**没有**原因框：空壳没有内容需要解释
    const dlg = await screen.findByTestId("action-dialog");
    expect(within(dlg).getByText(/明细 0 行；采购单 0 张；生产单 0 张/)).toBeVisible();
    expect(within(dlg).getByText(/销售单不再被它挡住，可以继续修改/)).toBeVisible();
    expect(within(dlg).queryByLabelText(/删除原因/)).toBeNull();

    await userEvent.click(within(dlg).getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, "/boms/bom-1").filter((call) => call.method === "DELETE")).toHaveLength(1));
    // 不需要原因 → DELETE 不带 body（服务端按 reason_required=false 校验）
    expect(callsTo(calls, "/boms/bom-1").find((call) => call.method === "DELETE")!.body).toBeNull();

    expect(await screen.findByText("BOM 表已删除，销售单现在可以修改了")).toBeVisible();
    // 删除后重新拉列表（GET /boms 第二次）：那一行回到「新建BOM表」、删除入口消失
    await waitFor(() => expect(callsTo(calls, "/boms").filter((call) => call.method === "GET")).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "新建BOM表" })).toBeVisible();
    expect(screen.queryByTestId("bom-delete-SO-1")).toBeNull();
  });

  it("有明细的 BOM 必须填原因：不填被拦且不发 DELETE，填了才把 reason 发出去", async () => {
    const calls = stubApi((url, call) => {
      if (url.startsWith(EP.salesOrders)) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
      if (url === EP.boms && call.method === "GET") return apiOk([{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
      if (url === `${EP.boms}/bom-1/delete-preview` && call.method === "GET") return apiOk(deletePreview({ item_count: 2, reason_required: true }));
      if (url === `${EP.boms}/bom-1` && call.method === "DELETE") return apiOk({ id: "bom-1", order_no: "SO-1", version: 1, deleted: true, item_count: 2 });
      return apiOk([]);
    });
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");
    await userEvent.click(await screen.findByTestId("bom-delete-SO-1"));

    const dlg = await screen.findByTestId("action-dialog");
    expect(within(dlg).getByText(/明细 2 行/)).toBeVisible();
    const reason = within(dlg).getByLabelText(/删除原因/);

    // 不填就提交：ActionDialog 自己的必填校验拦住（连服务端都不打），弹窗不关
    await userEvent.click(within(dlg).getByTestId("action-dialog-submit"));
    expect(await within(dlg).findByTestId("action-dialog-error")).toHaveTextContent("请填写删除原因");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(screen.getByTestId("action-dialog")).toBeVisible();

    await userEvent.type(reason, "BOM 建错单，需重新建一张");
    await userEvent.click(within(dlg).getByTestId("action-dialog-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    const del = calls.find((call) => call.method === "DELETE")!;
    expect(del.url).toBe(`${EP.boms}/bom-1`);
    expect(bodyOf(del)).toEqual({ reason: "BOM 建错单，需重新建一张" });
  });

  it("预览 deletable=false 时直接显示 blocked_reason：不弹确认框，也不发 DELETE", async () => {
    const blockedReason = "这张 BOM 已被 2 张采购单引用：请先在采购计划里「退回采购计划」或取消这些采购单，再删 BOM";
    const calls = stubApi((url, call) => {
      if (url.startsWith(EP.salesOrders)) return apiOk([{ id: "so-1", orderNo: "SO-1", status: "confirmed" }]);
      if (url === EP.boms && call.method === "GET") return apiOk([{ id: "bom-1", salesOrderId: "so-1", orderNo: "SO-1", status: "draft" }]);
      if (url === `${EP.boms}/bom-1/delete-preview` && call.method === "GET") return apiOk(deletePreview({ purchase_order_count: 2, deletable: false, blocked_reason: blockedReason, reason_required: true }));
      return apiOk([]);
    });
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");
    await userEvent.click(await screen.findByTestId("bom-delete-SO-1"));

    // 服务端的「为什么不能删、下一步去哪」要原样出现（不是一句笼统的「删除失败」）
    expect(await screen.findByText(blockedReason)).toBeVisible();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("孤立 BOM 行用真实 bom_id 删除，不能把行 id（salesOrderId）当 BOM id", async () => {
    const calls = stubApi((url, call) => {
      if (url.startsWith(`${EP.salesOrders}?status=draft`)) return apiOk([]);
      // 父销售单已被软删：`/sales-orders` 列表里没有它，BOM 只从 `/boms` 的 orphaned 行补进来
      if (url.startsWith(EP.salesOrders)) return apiOk([]);
      if (url === EP.boms && call.method === "GET") return apiOk([{ id: "bom-orphan", salesOrderId: "so-gone", orderNo: "SO-GONE", status: "draft", orphaned: true }]);
      if (url === `${EP.boms}/bom-orphan/delete-preview` && call.method === "GET") return apiOk(deletePreview({ bom_id: "bom-orphan", order_no: "SO-GONE" }));
      if (url === `${EP.boms}/bom-orphan` && call.method === "DELETE") return apiOk({ id: "bom-orphan", order_no: "SO-GONE", version: 1, deleted: true, item_count: 0 });
      return apiOk([]);
    });
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");

    expect(await screen.findByText("SO-GONE")).toBeVisible();
    await userEvent.click(await screen.findByTestId("bom-delete-SO-GONE"));
    await screen.findByTestId("action-dialog");
    await userEvent.click(within(screen.getByTestId("action-dialog")).getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    const del = calls.find((call) => call.method === "DELETE")!;
    expect(del.url).toBe(`${EP.boms}/bom-orphan`);
    // 行 id 是 salesOrderId（so-gone）—— 拿它当删除目标会 404，绝不能出现在 URL 里
    expect(del.url).not.toContain("so-gone");
  });
});

/**
 * 搜索（2026-11-11，用户：「需要在生产和采购模块的BOM表页面加上搜索功能」）。
 *
 * 这一页的行由两段拼成（已确认销售单 + 孤立 BOM），所以搜索也必须**同时**作用在两段上：
 * 只筛 `/sales-orders` 那一段的话，孤立 BOM 会在任何查询下都留在表里，看着像搜索坏了。
 *
 * 断言的是用户能看见的三件事：命中几行、计数条怎么说、没有命中时说的是不是「换个关键词」
 * 而不是「暂无已确认销售单」（后者会让用户以为单子没了）。
 */
describe("采购 → BOM表：搜索（2026-11-11）", () => {
  function stubSearchable() {
    return stubApi((url) => {
      if (url.startsWith(`${EP.salesOrders}?status=draft`)) return apiOk([]);
      if (url.startsWith(EP.salesOrders)) return apiOk([
        { id: "so-1", orderNo: "SO-2026-001", status: "confirmed" },
        { id: "so-2", orderNo: "SO-2026-002", status: "confirmed" },
        { id: "so-3", orderNo: "SO-2026-003", status: "confirmed" },
      ]);
      // 孤立 BOM：父销售单已被软删，只从 /boms 的 orphaned 行补进列表（状态是**BOM** 的 draft）
      if (url === EP.boms) return apiOk([
        { id: "bom-1", salesOrderId: "so-1", orderNo: "SO-2026-001", status: "draft" },
        { id: "bom-gone", salesOrderId: "so-gone", orderNo: "SO-GONE", status: "draft", orphaned: true },
      ]);
      if (url === EP.materials) return apiOk([]);
      if (url === EP.units) return apiOk([]);
      return apiOk([]);
    });
  }

  const search = () => screen.getByTestId("bom-search");
  const count = () => screen.getByTestId("bom-count");
  // 空态时 DataTable 整个不渲染（连 data-testid="data-table" 都没有），只能按行节点数数。
  const rowCount = () => screen.queryAllByTestId("data-table-row").length;

  async function openBoms() {
    render(<><BomsPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-boms");
    // 等到两段数据都到位：在册 3 行 + 孤立 1 行
    await waitFor(() => expect(rowCount()).toBe(4));
  }

  it("按订单号过滤，并同步计数「共 N 条，当前列出 M 条」", async () => {
    stubSearchable();
    await openBoms();

    expect(count()).toHaveTextContent("共 4 条，当前列出 4 条");

    await userEvent.type(search(), "SO-2026-002");
    expect(rowCount()).toBe(1);
    expect(screen.getByText("SO-2026-002")).toBeVisible();
    expect(count()).toHaveTextContent("共 4 条，当前列出 1 条");
  });

  it("空格分词取交集（AND）：两个词分别落在同一行的不同片段上也能命中", async () => {
    stubSearchable();
    await openBoms();

    // "SO" 命中全部 4 行，"002" 只命中 SO-2026-002 —— 交集必须是 1 行，而不是 4 行（OR）
    await userEvent.type(search(), "SO 002");
    expect(rowCount()).toBe(1);
    expect(screen.getByText("SO-2026-002")).toBeVisible();
  });

  it("状态既能用后端原值搜，也能用界面上显示的中文搜", async () => {
    stubSearchable();
    await openBoms();

    // 在册行来自 /sales-orders，状态是**销售单**状态 confirmed，单元格经 displayText 显示「已确认」；
    // 孤立行来自 /boms，状态是 BOM 的 draft，显示「草稿」。
    await userEvent.type(search(), "已确认");
    expect(rowCount()).toBe(3);
    expect(screen.queryByText("SO-GONE")).toBeNull();

    await userEvent.clear(search());
    await userEvent.type(search(), "草稿");
    expect(rowCount()).toBe(1);
    expect(screen.getByText("SO-GONE")).toBeVisible();

    // 原值同样可搜（导出件、接口文档里写的是 draft / confirmed）
    await userEvent.clear(search());
    await userEvent.type(search(), "confirmed");
    expect(rowCount()).toBe(3);
  });

  it("孤立行能被「孤立」二字搜出来（它是那一行上唯一能看见的额外提示）", async () => {
    stubSearchable();
    await openBoms();

    await userEvent.type(search(), "孤立");
    expect(rowCount()).toBe(1);
    expect(screen.getByText("SO-GONE")).toBeVisible();
  });

  it("无匹配时说清是「没有匹配…」并给出总数，而不是「暂无已确认销售单」", async () => {
    stubSearchable();
    await openBoms();

    await userEvent.type(search(), "不存在的订单");

    expect(screen.queryAllByTestId("data-table-row")).toHaveLength(0);
    expect(screen.getByText(/没有匹配“不存在的订单”的 BOM 表/)).toBeVisible();
    expect(screen.getByText(/共 4 条，换个关键词或清空搜索框/)).toBeVisible();
    expect(screen.queryByText(/暂无已确认销售单/)).toBeNull();
    expect(count()).toHaveTextContent("共 4 条，当前列出 0 条");
  });

  it("清空搜索框后回到全量（不是「再点一次搜索」才回来）", async () => {
    stubSearchable();
    await openBoms();

    await userEvent.type(search(), "SO-2026-003");
    expect(rowCount()).toBe(1);

    await userEvent.clear(search());
    expect(rowCount()).toBe(4);
    expect(count()).toHaveTextContent("共 4 条，当前列出 4 条");
  });
});
