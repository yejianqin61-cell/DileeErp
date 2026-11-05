// 销售单整页编辑器（components/sales/sales-order-editor.tsx）的真实行为测试。
//
// 用户 2026-09-16：「针对销售模块，在新建销售单的时候，要细化口径…按照这个模板来进行设计字段和
// 设计可导出的 excel」。字段太多（37 个标量 + 一张明细表），所以新建销售单从弹窗改成整页编辑器。
//
// 本文件钉住四件事：
//   1. 37 个细化字段真的渲染出来了（少一个就是「界面填不了、库里永远空」）；
//   2. 保存时**每个细化键都发出去**（空串 = 清除这一格）——只发填了的键会让「清空」永远保存不上；
//   3. 明细按行提交、空行不提交、必填缺了逐行报错并拦住保存；
//   4. 明细数量与单头数量不一致时页面提示（不拦），与后端同一口径。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SalesOrderEditor, orderNoImpactText, savedOrderMessage } from "../components/sales/sales-order-editor";
import { SPEC_MATERIAL_FIELDS, SPEC_SCALAR_KEYS } from "../lib/sales-order-spec";

const routerPush = vi.fn();
/** `useSearchParams` 的返回值由测试改（返单/复制用例要挂 URL 参数；默认空）。 */
const searchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParamsState.current,
}));

/**
 * 行图上传的 mock（2026-11-04）。
 *
 * 为什么必须 mock 这一层：`uploadSalesOrderImage` 内部会走 `browserImagePipeline()`（`createImageBitmap` +
 * `<canvas>`），jsdom 里没有这两个 API —— 不 mock 的话测的就不是界面行为，而是"jsdom 能不能编码 WebP"。
 * 压缩管线的真实行为在 `lib/material-image.test.mjs` 里用注入的假管线测（node:test）。
 *
 * `uploadMaterialImage` 也要 mock：它是「这张图要不要同时写入物料清单？」确认后的第二个请求。
 */
const uploadSalesOrderImageMock = vi.hoisted(() => vi.fn());
const uploadMaterialImageMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/material-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/material-image")>();
  return { ...actual, uploadSalesOrderImage: uploadSalesOrderImageMock, uploadMaterialImage: uploadMaterialImageMock };
});

const imageSummary = (id: string, sha256: string) => ({ id, width: 1600, height: 1200, byteSize: 9000, sha256, updatedAt: "2026-11-04T00:00:00.000Z" });

beforeEach(() => {
  uploadSalesOrderImageMock.mockResolvedValue(imageSummary("img-1", "sha-img-1"));
  uploadMaterialImageMock.mockResolvedValue(imageSummary("mat-img-1", "sha-mat-1"));
});

afterEach(() => {
  searchParamsState.current = new URLSearchParams();
});

const customer = { id: "customer-1", customerCode: "C001", name: "家百纳", isActive: true, currency: "USD", contacts: [{ id: "contact-1", name: "田中", phone: "090-1234", isDefault: true }] };
const units = [{ id: "unit-1", name: "支" }, { id: "unit-2", name: "打" }];
const currencyItems = { data: [{ key: "USD", label: "美元" }, { key: "CNY", label: "人民币" }] };

type Call = { url: string; method: string; body: unknown };

/** 极简 fetch 桩：按 URL 分派，记录所有调用。 */
function stubApi(handlers: Array<[string, (init: RequestInit) => unknown]> = []) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: init.body ? JSON.parse(String(init.body)) : undefined });
    for (const [fragment, handler] of handlers) if (url.includes(fragment)) return { ok: true, status: 200, json: async () => handler(init) };
    if (url.includes("/customers")) return { ok: true, status: 200, json: async () => ({ data: [customer], meta: {} }) };
    if (url.includes("/units")) return { ok: true, status: 200, json: async () => ({ data: units, meta: {} }) };
    if (url.includes("/dictionaries/currency/items")) return { ok: true, status: 200, json: async () => currencyItems };
    return { ok: true, status: 200, json: async () => ({ data: {}, meta: {} }) };
  });
  return calls;
}

const field = (testid: string) => screen.getByTestId(testid);
const specField = (key: string) => screen.getByTestId(`sales-spec-${key}`);

async function fillBase() {
  fireEvent.change(field("sales-base-order_no"), { target: { value: "DL260134" } });
  fireEvent.change(field("sales-base-product_name"), { target: { value: "50cm*5K 三折手开碳纤维伞" } });
  fireEvent.change(field("sales-base-quantity"), { target: { value: "1960" } });
  fireEvent.change(field("sales-base-order_date"), { target: { value: "2026-06-18" } });
  // 客户/单位/币种是 Radix 下拉：测试里直接改它们比较笨重，这里用「必须选」的校验来暴露问题，
  // 选中的动作放在下面专门的一个用例里验证。
}

describe("销售单整页编辑器", () => {
  it("37 个细化字段全部渲染（材料 18 + 工艺 9 + 布量 5 + 表头 5）", async () => {
    stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    for (const key of SPEC_SCALAR_KEYS) expect(specField(key), `缺字段 ${key}`).toBeTruthy();
    // 抽查几个来自两张不同样本的字段：样本1 独有 / 样本2 独有
    expect(specField("handle_strap_spec")).toBeTruthy();
    expect(specField("wood_ear_spec")).toBeTruthy();
    expect(specField("qc_requirement")).toBeTruthy();
    expect(screen.getByText("布量（Y/DZ）")).toBeVisible();
    expect(screen.getByText("细分明细")).toBeVisible();
  });

  it("保存：每个细化键都发出去（空串 = 清除这一格），明细按行提交且空行不提交", async () => {
    const calls = stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    fireEvent.change(specField("rib_spec"), { target: { value: "50cm*5K三折手开双碳纤骨" } });
    fireEvent.change(specField("qc_requirement"), { target: { value: "所有材料和成品都要质检报告" } });

    // 明细：第一行填全，再加一行填一半（缺品番/品名 → 应被拦下）
    fireEvent.change(field("sales-detail-0-group_name"), { target: { value: "伞布明细" } });
    fireEvent.change(field("sales-detail-0-name"), { target: { value: "27621 流水花扇PKGY" } });
    fireEvent.change(field("sales-detail-0-color"), { target: { value: "PKGY" } });
    fireEvent.change(field("sales-detail-0-quantity"), { target: { value: "1960" } });
    fireEvent.change(field("sales-detail-0-unit"), { target: { value: "pcs" } });
    fireEvent.click(field("sales-detail-add"));

    await userEvent.click(field("sales-order-save"));
    const saved = calls.find((call) => call.method === "POST" && call.url.includes("/sales-orders"));
    expect(saved, "应当发出创建请求").toBeTruthy();
    const body = saved!.body as Record<string, unknown>;

    // 37 个细化键一个都不能少：少一个就是「界面填了、库里没存」
    for (const key of SPEC_SCALAR_KEYS) expect(key in body, `载荷缺 ${key}`).toBe(true);
    expect(body.rib_spec).toBe("50cm*5K三折手开双碳纤骨");
    expect(body.qc_requirement).toBe("所有材料和成品都要质检报告");
    // 没填的细化字段要发空串（后端据此清空这一格），不能省略键——否则「清空」永远保存不上。
    expect(body.handle_spec).toBe("");
    expect(body.spec_details).toEqual([{ group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "1960", unit: "pcs", sort_order: 0 }]);
    // 2026-09-30 拆页后回列表页（而不是一级卡片页）：销售存完单要继续处理下一张单。
    expect(routerPush).toHaveBeenCalledWith("/sales/orders");
  });

  it("明细必填缺失时逐行报错并拦住保存（不发请求）", async () => {
    const calls = stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    // 只填分组名不填品番/品名
    fireEvent.change(field("sales-detail-0-group_name"), { target: { value: "伞头配色" } });

    await userEvent.click(field("sales-order-save"));

    expect(await screen.findByTestId("sales-detail-errors")).toBeVisible();
    expect(screen.getByTestId("sales-detail-errors").textContent).toContain("第 1 行：品番/品名不能为空");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("明细合计与单头数量不一致时页面提示，但不拦保存", async () => {
    stubApi([["/sales-orders", () => ({ data: { id: "order-1", orderNo: "DL260134" }, meta: {} })]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    fireEvent.change(field("sales-detail-0-group_name"), { target: { value: "伞布明细" } });
    fireEvent.change(field("sales-detail-0-name"), { target: { value: "27621 流水花扇PKGY" } });
    fireEvent.change(field("sales-detail-0-quantity"), { target: { value: "100" } });
    fireEvent.change(field("sales-detail-0-unit"), { target: { value: "pcs" } });

    const notice = await screen.findByTestId("sales-quantity-notice");
    expect(notice.textContent).toContain("明细数量合计 100 与单头数量 1960支 不一致");
    expect(field("sales-order-save")).not.toBeDisabled();
  });

  it("编辑既有销售单：回填细化字段与明细，已确认的单子改要填原因", async () => {
    // ⚠️ 形状必须与**真实接口一致**：`GET /sales-orders/:id` 直接把 Prisma 整行转 JSON 出去，
    // 所以细化字段是 schema 里的 **camelCase 列名**（`ribSpec` / `fabricUsageCanopy`），
    // 不是请求侧的 snake_case 键名。之前这里写的是 snake_case，于是「回填」这条路
    // 一直在测一个不存在的接口形状（见「材料明细保存后再打开就没了」）。
    const order = {
      id: "order-1", orderNo: "DL260134", status: "confirmed", orderDate: "2026-06-18T00:00:00.000Z", deliveryDate: null,
      productName: "折叠伞", productSpec: "旧规格", quantity: "1960.0000", unit: "支", currency: "USD",
      customer: { id: "customer-1" }, contact: null,
      ribSpec: "旧伞骨", factory: "JBN", attentionNote: "都需使用防水线", qcRequirement: "所有材料和成品都要质检报告",
      fabricUsageCanopy: "1.2",
      created_by_name: "张三", updated_by_name: "李四", createdAt: "2026-09-01T02:30:00.000Z", updatedAt: "2026-09-02T06:05:00.000Z",
      specDetails: [{ groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: "1960.0000", unit: "pcs" }],
    };
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: order, meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);

    await waitFor(() => expect((field("sales-spec-rib_spec") as HTMLTextAreaElement).value).toBe("旧伞骨"));
    expect((field("sales-spec-factory") as HTMLInputElement).value).toBe("JBN");
    // 用户 2026-09-20：「材料明细，我是写了，然后还保存了，但是再打开就又没有了」——
    // 四个区各抽查一格，防止「只修好其中一个区」。
    expect((field("sales-spec-attention_note") as HTMLTextAreaElement).value).toBe("都需使用防水线");
    expect((field("sales-spec-qc_requirement") as HTMLTextAreaElement).value).toBe("所有材料和成品都要质检报告");
    expect((field("sales-spec-fabric_usage_canopy") as HTMLInputElement).value).toBe("1.2");
    expect((field("sales-detail-0-name") as HTMLInputElement).value).toBe("27621 流水花扇PKGY");
    // 审计四行（上一轮的全站治理）：编辑页也要能看到创建人 / 最后修改人
    const audit = screen.getByTestId("sales-order-audit").textContent ?? "";
    expect(audit).toContain("创建人 张三");
    expect(audit).toContain("最后修改人 李四");

    // 已确认单：不填原因会被拦下
    await userEvent.click(field("sales-order-save"));
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    fireEvent.change(field("sales-change-reason"), { target: { value: "客户改了伞骨" } });
    await userEvent.click(field("sales-order-save"));
    const patched = calls.find((call) => call.method === "PATCH" && call.url.includes("/sales-orders/order-1"));
    expect(patched).toBeTruthy();
    const body = patched!.body as Record<string, unknown>;
    expect(body.reason).toBe("客户改了伞骨");
    expect(body.rib_spec).toBe("旧伞骨");
    expect("order_no" in body).toBe(false);
    expect("customer_id" in body).toBe(false);
  });
});

/* ------------------------------------------------ 材料明细：填空或引用物料（2026-09-24） */

/**
 * 用户原话：「在编辑销售单的时候，每个部件，既支持填空，也支持从现有的物料清单中引用。
 * 同时要体现对应的物料的图片」。
 *
 * 四条：① 18 个部件各有一个引用选择器；② 选中就把物料的名称/规格/颜色填进格子（工艺单印的是文字）
 * 并显示缩略图；③ 取消引用**不动文字**（用户想留着那些字）；④ 保存时 `material_refs` 是整块替换。
 */
describe("销售单编辑器：材料明细引用物料", () => {
  const material = (extra: Record<string, unknown> = {}) => ({
    id: "m-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑",
    image: { sha256: "sha-1", updatedAt: "2026-09-24T00:00:00.000Z" }, isActive: true, ...extra,
  });

  function stubWithMaterials(materials: unknown[]) {
    return stubApi([["/materials", () => ({ data: materials, meta: {} })]]);
  }

  it("18 个材料栏位各有一个「从物料清单引用…」选择器", async () => {
    stubWithMaterials([material()]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    for (const [key] of SPEC_MATERIAL_FIELDS) expect(field(`sales-material-ref-${key}`), `缺引用选择器 ${key}`).toBeTruthy();
    // 工艺要求栏位不该有选择器（它们不是「部件」）。
    expect(screen.queryByTestId("sales-material-ref-qc_requirement")).toBeNull();
  });

  /**
   * 用户 2026-09-26：「材料明细，引用的下拉列表也支持搜索」。
   *
   * 为什么这条重要：物料池动辄几百条，改造前是一个平铺的 Radix Select ——
   * 要靠肉眼在一长串「MAT-x / 名称 规格 颜色」里翻到要的那一根伞骨。这里钉住四件事：
   *   ① 打开就是搜索框（而不是一屏选项）；② 按**编码**能搜到；③ 按**规格/颜色**也能搜到；
   *   ④ 搜不到时给出可读的空态（不是一片空白，让人以为物料池坏了）。
   */
  it("引用下拉支持搜索：按编码/规格/颜色过滤，搜不到时给可读空态", async () => {
    stubWithMaterials([
      material(),
      material({ id: "m-2", materialCode: "MAT-2", name: "伞布", specificationModel: "190T", color: "藏青" }),
      material({ id: "m-3", materialCode: "MAT-3", name: "伞头", specificationModel: "直柄", color: "银灰" }),
    ]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    const root = screen.getByTestId("sales-material-ref-rib_spec");
    await userEvent.click(within(root).getByRole("combobox"));
    const search = await screen.findByTestId("searchable-select-search");
    expect(screen.getAllByTestId("searchable-select-option")).toHaveLength(3);

    // 按编码搜
    await userEvent.type(search, "MAT-3");
    expect(screen.getAllByTestId("searchable-select-option").map((option) => option.textContent)).toEqual(["MAT-3 / 伞头 直柄 银灰"]);

    // 按规格搜（不只是名称与编码）
    await userEvent.clear(search);
    await userEvent.type(search, "190T");
    expect(screen.getAllByTestId("searchable-select-option").map((option) => option.textContent)).toEqual(["MAT-2 / 伞布 190T 藏青"]);

    // 按颜色搜
    await userEvent.clear(search);
    await userEvent.type(search, "藏青");
    expect(screen.getAllByTestId("searchable-select-option").map((option) => option.textContent)).toEqual(["MAT-2 / 伞布 190T 藏青"]);

    // 搜不到：可读空态，而不是一片空白
    await userEvent.clear(search);
    await userEvent.type(search, "不存在的物料");
    expect(screen.queryAllByTestId("searchable-select-option")).toHaveLength(0);
    expect(screen.getByText("没有匹配的物料（可到【采购 → 物料清单】新建）")).toBeVisible();
  });

  it("选中物料：把名称/规格/颜色填进格子、显示缩略图，保存时发出 material_refs", async () => {    const calls = stubWithMaterials([material(), material({ id: "m-2", materialCode: "MAT-2", name: "伞布", specificationModel: "190T", color: "藏青", image: null })]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();

    await pickMaterialRef("rib_spec", "MAT-1");
    // 选中就把物料文字填进格子（工艺单印的是文字）
    expect((field("sales-spec-rib_spec") as HTMLTextAreaElement).value).toBe("伞骨 50cm 黑");
    expect((field("material-image-thumb-m-1") as HTMLImageElement).getAttribute("src")).toBe("/api/v1/materials/m-1/image?v=sha-1");

    // 第二个部件引用一个**没有图**的物料：要明说，别让人以为是导出坏了
    await pickMaterialRef("canopy_spec", "MAT-2");
    expect(field("sales-material-ref-no-image-canopy_spec")).toHaveTextContent("该物料还没有图片");

    await userEvent.click(field("sales-order-save"));
    const saved = calls.find((call) => call.method === "POST" && call.url.includes("/sales-orders"));
    expect((saved!.body as Record<string, unknown>).material_refs).toEqual([
      { spec_key: "rib_spec", material_id: "m-1" },
      { spec_key: "canopy_spec", material_id: "m-2" },
    ]);
  });

  it("取消引用：文字留着、缩略图消失、载荷里不再有这一格", async () => {
    const calls = stubWithMaterials([material()]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await fillBase();
    await pickMaterialRef("rib_spec", "MAT-1");

    await userEvent.click(field("sales-material-ref-clear-rib_spec"));
    // 清除引用不动已经写好的文字
    expect((field("sales-spec-rib_spec") as HTMLTextAreaElement).value).toBe("伞骨 50cm 黑");
    expect(screen.queryByTestId("material-image-thumb-m-1")).toBeNull();

    await userEvent.click(field("sales-order-save"));
    const saved = calls.find((call) => call.method === "POST" && call.url.includes("/sales-orders"));
    expect((saved!.body as Record<string, unknown>).material_refs).toEqual([]);
  });

  it("编辑既有销售单：materialRefs（列名形状）回填成引用与缩略图，并原样再发出去", async () => {
    const order = {
      id: "order-1", orderNo: "DL260134", status: "draft", orderDate: "2026-06-18T00:00:00.000Z", deliveryDate: null,
      productName: "折叠伞", quantity: "1960", unit: "支", currency: "USD", customer: { id: "customer-1" }, contact: null,
      ribSpec: "伞骨 50cm 黑", specDetails: [],
      materialRefs: [{ specKey: "rib_spec", material: { id: "m-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: { sha256: "sha-1" } } }],
    };
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: order, meta: {} })], ["/materials", () => ({ data: [material()], meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);

    await waitFor(() => expect(field("sales-material-ref-clear-rib_spec")).toBeTruthy());
    expect((field("material-image-thumb-m-1") as HTMLImageElement).getAttribute("src")).toBe("/api/v1/materials/m-1/image?v=sha-1");

    await userEvent.click(field("sales-order-save"));
    const patched = calls.find((call) => call.method === "PATCH" && call.url.includes("/sales-orders/order-1"));
    expect((patched!.body as Record<string, unknown>).material_refs).toEqual([{ spec_key: "rib_spec", material_id: "m-1" }]);
  });

  it("物料清单拉不到时整页照样能用（引用是锦上添花，填字才是主干）", async () => {
    stubApi([["/materials", () => ({ data: { unexpected: "shape" }, meta: {} })]]);
    render(<SalesOrderEditor />);

    await screen.findByText("材料明细");
    expect(field("sales-spec-rib_spec")).toBeTruthy();
    expect(field("sales-material-ref-rib_spec")).toBeTruthy();
  });
});

/* ------------------------------------------------ 细分明细：自定义列名（2026-09-30） */

/**
 * 用户原话：「细分明细那边，可以改成自定义字段名称。」
 *
 * 四条：① 打开既有单能把改过的列名显示在表头；② 「修改列名」能一次改完 6 格，表头跟着变；
 * ③ 保存时把列名发出（只发改过的，空 = 恢复默认）；④ 清空一格 = 那一列回到默认名。
 */
describe("销售单编辑器：细分明细的自定义列名", () => {
  const orderWithLabels = (labels: Record<string, string>) => ({
    id: "order-1", orderNo: "DL260134", status: "draft", orderDate: "2026-06-18T00:00:00.000Z", deliveryDate: null,
    productName: "折叠伞", quantity: "1960", unit: "支", currency: "USD", customer: { id: "customer-1" }, contact: null,
    specDetails: [{ groupName: "伞头配色", name: "Hawái", color: "配色按图片", barcode: "489", quantity: "167", unit: "打" }],
    specDetailLabels: labels,
  });

  const headText = (key: string) => field(`sales-detail-head-${key}`).textContent;

  it("打开既有单：改过的列名显示在表头，没改的仍用默认名", async () => {
    stubApi([["/sales-orders/order-1", () => ({ data: orderWithLabels({ name: "伞头英文名", quantity: "数量/打" }), meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(headText("name")).toBe("伞头英文名"));

    expect(headText("quantity")).toBe("数量/打");
    expect(headText("group_name")).toBe("分组名");
    expect(headText("color")).toBe("颜色/配色");
    // 行内输入框的可访问名也跟着列名走（读屏用户看到的与表头一致）
    expect(field("sales-detail-0-name").getAttribute("aria-label")).toBe("伞头英文名");
  });

  it("「修改列名」：预填当前列名，改完表头立即变；保存时只发改过的列名", async () => {
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: orderWithLabels({ name: "伞头英文名" }), meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(headText("name")).toBe("伞头英文名"));

    await userEvent.click(field("sales-detail-labels"));
    // 6 个明细列各一格，且预填当前值（弹窗里就能看出哪几列已经改过）
    for (const key of ["group_name", "name", "color", "barcode", "quantity", "unit"]) expect(field(`action-field-${key}`)).toBeTruthy();
    expect((field("action-field-name") as HTMLInputElement).value).toBe("伞头英文名");

    await userEvent.clear(field("action-field-quantity"));
    await userEvent.type(field("action-field-quantity"), "数量/打");
    await userEvent.click(field("action-dialog-submit"));

    await waitFor(() => expect(headText("quantity")).toBe("数量/打"));
    expect(headText("color")).toBe("颜色/配色"); // 没填的格子仍是默认名

    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patched = calls.find((call) => call.method === "PATCH");
    expect((patched!.body as Record<string, unknown>).spec_detail_labels).toEqual({ name: "伞头英文名", quantity: "数量/打" });
  });

  it("清空某一列 = 那一列回到默认名，且不再出现在载荷里", async () => {
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: orderWithLabels({ name: "伞头英文名", color: "配色" }), meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(headText("name")).toBe("伞头英文名"));

    await userEvent.click(field("sales-detail-labels"));
    await userEvent.clear(field("action-field-name"));
    await userEvent.click(field("action-dialog-submit"));

    await waitFor(() => expect(headText("name")).toBe("品番/品名"));
    expect(headText("color")).toBe("配色"); // 没被清空的那一列留着

    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    // 只发非空项：后端据此把 name 的覆盖删掉 —— 这正是「恢复默认」的表达方式
    expect((calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>).spec_detail_labels).toEqual({ color: "配色" });
  });

  it("列名超过 20 字：保存前当场拦下，不发请求", async () => {
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: orderWithLabels({}), meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(headText("name")).toBe("品番/品名"));

    await userEvent.click(field("sales-detail-labels"));
    await userEvent.type(field("action-field-name"), "名".repeat(21));
    await userEvent.click(field("action-dialog-submit"));
    await waitFor(() => expect(headText("name")).toBe("名".repeat(21)));

    await userEvent.click(field("sales-order-save"));
    expect(await screen.findByText(/超过 20 字/)).toBeVisible();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

/* ------------------------------------------------ 订单号改号（2026-09-30） */

/**
 * 用户原话：「创建销售单，订单号写错了要支持编辑和修改。要做好全链条订单号的联动调整」。
 *
 * 界面上它不是"改一格"：一次改号会在同一个事务里改掉全库 38 张表里属于这张单的行
 * （另加别的单上的返单来源引用与本单的版本快照）。所以保存路径分成两段 ——
 * 先拉影响面弹确认（原因必填），确认后才 PATCH。
 *
 * 老口径的坑（本轮修掉的）：这一格一直可编辑，但 `save()` 里 `delete payload.order_no`，
 * 于是"改完点保存 → 提示已保存 → 号还是旧的"。第 2 个用例是它的回归守卫。
 */
describe("销售单编辑器：改订单号（全链联动）", () => {
  const order = {
    id: "order-1", orderNo: "DL26001", status: "draft", orderDate: "2026-06-18T00:00:00.000Z", deliveryDate: null,
    productName: "折叠伞", quantity: "1960.0000", unit: "支", currency: "USD",
    customer: { id: "customer-1" }, contact: null, specDetails: [], materialRefs: [],
  };
  const impactBody = (extra: Record<string, unknown> = {}) => ({
    data: {
      sales_order_id: "order-1", current_order_no: "DL26001", next_order_no: "DL260001", changed: true,
      conflict: null, reason_required: true,
      targets: [{ key: "PurchaseOrder", label: "采购单", count: 3 }, { key: "Bom", label: "BOM 表", count: 1 }],
      total: 4, version_snapshots: 1, reorder_references: 1, ...extra,
    },
    meta: {},
  });
  /** 打开编辑页并把订单号改成 DL260001。 */
  async function openAndRetype() {
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect((field("sales-base-order_no") as HTMLInputElement).value).toBe("DL26001"));
    fireEvent.change(field("sales-base-order_no"), { target: { value: "DL260001" } });
  }

  it("改号：先弹影响确认（此时不落库），原因必填，确认后 PATCH 才带上新号", async () => {
    const calls = stubApi([
      ["/order-no-impact", () => impactBody()],
      ["/sales-orders/order-1", (init) => (init.method === "PATCH"
        ? { data: { id: "order-1", orderNo: "DL260001", order_no_changed: true, previous_order_no: "DL26001" }, meta: {} }
        : { data: order, meta: {} })],
    ]);
    await openAndRetype();
    await userEvent.click(field("sales-order-save"));

    // 第一步：只拉影响面，一个写请求都不该发出去
    await waitFor(() => expect(calls.some((call) => call.url.includes("/order-no-impact"))).toBe(true));
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    const dialog = await screen.findByTestId("action-dialog");
    expect(dialog.textContent).toContain("DL26001 → DL260001");
    expect(dialog.textContent).toContain("将同步更新 2 类下游单据共 4 条");
    expect(dialog.textContent).toContain("采购单 3");
    expect(dialog.textContent).toContain("历史版本快照 1 条");
    expect(dialog.textContent).toContain("返单来源 1 条");

    // 原因必填：不填点提交被拦下，仍然不发请求
    await userEvent.click(field("action-dialog-submit"));
    expect((await screen.findByTestId("action-dialog-error")).textContent).toContain("请填写改号原因");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    // 填了原因才落库，并且新号真的发出去了（老口径是 delete payload.order_no）
    fireEvent.change(field("action-field-reason"), { target: { value: "单号手误" } });
    await userEvent.click(field("action-dialog-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patched = calls.find((call) => call.method === "PATCH")!;
    expect((patched.body as Record<string, unknown>).order_no).toBe("DL260001");
    expect((patched.body as Record<string, unknown>).reason).toBe("单号手误");
  });

  it("改号：没改号就不拉影响面、也不发 order_no（老口径的回归守卫）", async () => {
    const calls = stubApi([
      ["/order-no-impact", () => impactBody()],
      ["/sales-orders/order-1", (init) => (init.method === "PATCH" ? { data: { id: "order-1", orderNo: "DL26001" }, meta: {} } : { data: order, meta: {} })],
    ]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect((field("sales-base-order_no") as HTMLInputElement).value).toBe("DL26001"));

    fireEvent.change(field("sales-base-product_name"), { target: { value: "折叠伞（改规格）" } });
    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));

    expect(calls.some((call) => call.url.includes("/order-no-impact")), "没改号就别去打扰影响面接口").toBe(false);
    const body = calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>;
    expect("order_no" in body).toBe(false);
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("改号：影响面已经算出新号被占用，就当场说出来（不必等到保存失败）", async () => {
    stubApi([
      ["/order-no-impact", () => impactBody({ conflict: { order_no: "DL260001", order_id: "so-9", status: "closed", deleted: false, message: "订单号 DL260001 已被另一张销售单占用（closed）" } })],
      ["/sales-orders/order-1", () => ({ data: order, meta: {} })],
    ]);
    await openAndRetype();
    await userEvent.click(field("sales-order-save"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(dialog.textContent).toContain("已被另一张销售单占用");
  });

  it("改号：后端拒绝时弹窗不关闭，把原因留在弹窗里（别把用户填的一堆字段丢在页面上）", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/order-no-impact")) return { ok: true, status: 200, json: async () => impactBody({ conflict: null }) };
      if (method === "PATCH") return { ok: false, status: 409, json: async () => ({ error: { code: "ORDER_NO_CONFLICT", message: "订单号 DL260001 已被另一张销售单占用", details: [] } }) };
      // 其余下拉数据源必须与 stubApi 的默认一致：/customers 回的不是数组的话，load() 会整个抛错，
      // 表单根本填不上（那样这个用例测的就不是"后端拒绝"了）。
      if (url.includes("/customers")) return { ok: true, status: 200, json: async () => ({ data: [customer], meta: {} }) };
      if (url.includes("/units")) return { ok: true, status: 200, json: async () => ({ data: units, meta: {} }) };
      if (url.includes("/dictionaries/currency/items")) return { ok: true, status: 200, json: async () => currencyItems };
      return { ok: true, status: 200, json: async () => ({ data: order, meta: {} }) };
    });
    await openAndRetype();
    await userEvent.click(field("sales-order-save"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(field("action-field-reason"), { target: { value: "单号手误" } });
    await userEvent.click(field("action-dialog-submit"));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect((await screen.findByTestId("action-dialog-error")).textContent).toContain("已被另一张销售单占用");
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });
});

describe("改号影响面文案", () => {
  const base = { sales_order_id: "so-1", current_order_no: "DL26001", next_order_no: "DL260001", changed: true, conflict: null, reason_required: true, targets: [], total: 0, version_snapshots: 0, reorder_references: 0 };

  it("有下游：把「几类、共几条、按类明细」说全，并交代旧号只留在审计里", () => {
    const text = orderNoImpactText({ ...base, targets: [{ key: "PurchaseOrder", label: "采购单", count: 3 }, { key: "Bom", label: "BOM 表", count: 1 }], total: 4, version_snapshots: 2, reorder_references: 1 });
    expect(text).toContain("订单号 DL26001 → DL260001");
    expect(text).toContain("将同步更新 2 类下游单据共 4 条（采购单 3、BOM 表 1）");
    expect(text).toContain("历史版本快照 2 条");
    expect(text).toContain("返单来源 1 条");
    expect(text).toContain("旧单号只留在审计里");
  });

  it("没有下游：明说「只改销售单本身」，不编一个 0 条的影响面", () => {
    expect(orderNoImpactText(base)).toContain("这一单还没有下游单据，改号只改销售单本身");
  });

  it("冲突优先说：冲突时不再报下游条数（先说能不能改）", () => {
    // 2026-10-08 起唯一性是「未删除行上唯一」：冲突只可能来自**未删除**的另一张单（软删单占过的号已释放）。
    const text = orderNoImpactText({ ...base, targets: [{ key: "Bom", label: "BOM 表", count: 1 }], total: 1, conflict: { order_no: "DL260001", order_id: "so-9", status: "confirmed", deleted: false, message: "订单号 DL260001 已被另一张销售单占用（confirmed）" } });
    expect(text).toContain("已被另一张销售单占用");
    expect(text).not.toContain("将同步更新");
  });
});

describe("保存成功提示文案", () => {
  // 2026-11-05：保存核心字段时后端可能顺手清掉「空壳 BOM」（0 明细、无计划/采购/生产）。
  // 这件事必须出现在提示里 —— 用户点的是「保存」，却少了一张 BOM 表，静默处理会让人以为表凭空消失。
  it("普通保存只报保存成功", () => {
    expect(savedOrderMessage({ id: "so-1", orderNo: "SO-1" }, true)).toBe("销售单已保存");
    expect(savedOrderMessage({ id: "so-1", orderNo: "SO-1" }, false)).toBe("销售单已创建（SO-1）");
  });

  it("改了订单号：报告改号，不再报清理 BOM（两件事同时发生时改号更重要）", () => {
    const message = savedOrderMessage({ id: "so-1", orderNo: "SO-2", order_no_changed: true, released_empty_boms: [{ bom_id: "bom-1", version: 1 }] }, true);
    expect(message).toContain("订单号已改为 SO-2");
    expect(message).not.toContain("空 BOM");
  });

  it("自动清理了空壳 BOM：说清「几张、为什么它们可以直接清」", () => {
    const message = savedOrderMessage({ id: "so-1", orderNo: "SO-1", released_empty_boms: [{ bom_id: "bom-1", version: 1 }] }, true);
    expect(message).toContain("销售单已保存");
    expect(message).toContain("已自动清理 1 张未填内容的空 BOM");
    expect(message).toContain("没有明细");
  });
});

/** Radix Select 的选择动作：点开触发器，再点选项。 */
async function pickSelect(testid: string, optionText: string) {
  const trigger = screen.getByTestId(testid);
  await userEvent.click(trigger);
  const option = await screen.findByRole("option", { name: new RegExp(optionText) });
  await userEvent.click(option);
}

/**
 * 材料明细的**引用下拉**（`ui/searchable-select`，用户 2026-09-26 要求「支持搜索」）：
 * 点开触发点 → 在搜索框里输入关键词 → 点中过滤后的那一项。
 *
 * 为什么不能沿用 `pickSelect`：SearchableSelect 收起态是一个 `button`、展开态换成搜索框，
 * testid 在**根 div** 上（点击根 div 不展开）—— 这是两个原语，交互不一样。
 * 关键词一律用「物料编码」：它同时验证了「搜索命中的是 label 而不是只有名称」。
 */
async function pickMaterialRef(key: string, query: string) {
  const root = screen.getByTestId(`sales-material-ref-${key}`);
  const trigger = within(root).getByRole("combobox");
  await userEvent.click(trigger);
  const search = await screen.findByTestId("searchable-select-search");
  await userEvent.type(search, query);
  const option = (await screen.findAllByTestId("searchable-select-option"))[0];
  await userEvent.click(option);
}

// within 在本文件里没用到，但保留导入会被 lint 判为未使用——这里显式引用一次避免误解。
void within;

/* ------------------------------------------------ 行级图片：一条物料最多 3 张（2026-11-05） */

/**
 * 上一轮（2026-11-04）交付的是「每个位置 1 张」；用户 2026-11-05：「一条物料支持导入 3 张图片，现在只有 1 张」。
 *
 * 这一组钉住编辑器这一半：
 *   ① 18 格 / 细分明细等位置都能**逐张**上传、换图、删除，最多 3 张；满 3 张禁用并说明原因；
 *   ② 缩略图走**销售单图片接口**（`/api/v1/sales-orders/:id/images/:imageId?v=sha`）；
 *   ③ 保存载荷：`slot_images[].image_ids` / `spec_details[].image_ids` / `material_extras[].image_ids`；
 *   ④ 没有单 id（新建/返单/复制）时控件禁用并说明「先保存销售单，再上传图片」；
 *   ⑤ 「是否同时写入物料清单」只在**这一行第 1 张**、且引用的物料在物料清单里没有图时问一次；
 *   ⑥ 编辑既有单（三关系列名）与复制（images/image_ids 请求键）两条回填路都认，缩略图用**来源单 id**。
 *
 * 压缩与网络在 `lib/material-image.test.mjs` 里测（注入假管线）；这里 mock 掉那两个上传函数，
 * 测的是界面行为与载荷。
 */
describe("销售单编辑器：行级图片（每条物料最多 3 张）", () => {
  const rowImageFile = (name = "row.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

  /** 编辑态的一张单（保存校验需要的必填项都齐）。 */
  const editOrder = (extra: Record<string, unknown> = {}) => ({
    id: "order-1", orderNo: "DL260134", status: "draft", orderDate: "2026-11-04T00:00:00.000Z", deliveryDate: null,
    productName: "折叠伞", quantity: "1960", unit: "支", currency: "USD",
    customer: { id: "customer-1" }, contact: null, specDetails: [], materialRefs: [], slotImages: [], materialExtras: [],
    ...extra,
  });

  /** 详情形状的一格多张图：**一行 = 一张**，`slotIndex` 决定是第几张（后端 orderBy [specKey, slotIndex]）。 */
  const detailSlotImages = (specKey: string, ids: string[]) => ids.map((id, slotIndex) => ({
    specKey, slotIndex, imageId: id, image: { id, width: 800, height: 600, byteSize: 51234, sha256: `sha-${id}` },
  }));

  /** 详情形状的一行多张图：三个关系（image/image2/image3）+ 三个标量（imageId/imageId2/imageId3）。 */
  const detailRowImages = (ids: string[]) => {
    const [first, second, third] = ids;
    return {
      ...(first ? { imageId: first, image: { id: first, width: 400, height: 300, byteSize: 900, sha256: `sha-${first}` } } : {}),
      ...(second ? { imageId2: second, image2: { id: second, width: 400, height: 300, byteSize: 900, sha256: `sha-${second}` } } : {}),
      ...(third ? { imageId3: third, image3: { id: third, width: 400, height: 300, byteSize: 900, sha256: `sha-${third}` } } : {}),
    };
  };

  /** 让连续几次上传依次回 img-1 / img-2 / img-3（同一行要能凑出 3 张不同的图）。 */
  function queueUploads() {
    let sequence = 0;
    uploadSalesOrderImageMock.mockImplementation(async () => {
      sequence += 1;
      return imageSummary(`img-${sequence}`, `sha-img-${sequence}`);
    });
  }

  /** 把文件塞进那个藏起来的 `<input type=file>`（与物料图片面板测试同一手法）。 */
  function uploadVia(testId: string, file = rowImageFile()) {
    fireEvent.change(field(`${testId}-input`), { target: { files: [file] } });
  }

  it("18 格传 3 张：缩略图并排、满 3 张禁用，保存载荷 slot_images[].image_ids 三项", async () => {
    queueUploads();
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: editOrder(), meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await screen.findByText("材料明细");

    // 编辑既有单：有单 id，控件可用
    expect(field("sales-material-image-canopy_spec-pick")).not.toBeDisabled();
    uploadVia("sales-material-image-canopy_spec");
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1"));
    expect(field("sales-material-image-canopy_spec-pick")).toHaveTextContent("再加一张");

    uploadVia("sales-material-image-canopy_spec");
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-1")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-2?v=sha-img-2"));

    uploadVia("sales-material-image-canopy_spec");
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-2")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-3?v=sha-img-3"));
    expect(uploadSalesOrderImageMock).toHaveBeenCalledTimes(3);

    // 满 3 张：按钮禁用并说清原因（不是静默没反应）
    expect(field("sales-material-image-canopy_spec-pick")).toBeDisabled();
    expect(field("sales-material-image-canopy_spec-pick")).toHaveAttribute("title", "已满 3 张");
    expect(field("sales-material-image-canopy_spec-full")).toHaveTextContent("已满 3 张");

    fireEvent.change(field("sales-spec-canopy_spec"), { target: { value: "190T 黑" } });
    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.slot_images).toEqual([{ spec_key: "canopy_spec", image_ids: ["img-1", "img-2", "img-3"] }]);
  });

  it("第 2 张可换图、任意一张可删：换图不改位置，删掉后后面的顶上", async () => {
    queueUploads();
    const calls = stubApi([["/sales-orders/order-1", () => ({ data: editOrder(), meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await screen.findByText("材料明细");

    uploadVia("sales-material-image-canopy_spec");
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-0")).toBeTruthy());
    uploadVia("sales-material-image-canopy_spec");
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-1")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-2?v=sha-img-2"));

    // 点第 2 张缩略图 = 换这一张（上传回执 img-3 替换 img-2，位置仍是第 2 张）
    await userEvent.click(field("sales-material-image-canopy_spec-thumb-1"));
    uploadVia("sales-material-image-canopy_spec");
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-1")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-3?v=sha-img-3"));
    expect(field("sales-material-image-canopy_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1");

    // 删第 1 张：原来的第 2 张（现在是 img-3）顶上成为第 1 张
    await userEvent.click(field("sales-material-image-canopy_spec-remove-0"));
    expect(screen.queryByTestId("sales-material-image-canopy_spec-thumb-1")).toBeNull();
    expect(field("sales-material-image-canopy_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-3?v=sha-img-3");

    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.slot_images).toEqual([{ spec_key: "canopy_spec", image_ids: ["img-3"] }]);
  });

  it("行图优先于物料图：删光这一格的行图就退回物料兜底图", async () => {
    const material = { id: "m-1", materialCode: "MAT-1", name: "伞布", specificationModel: "190T", color: "黑", image: { sha256: "sha-mat-1" } };
    const calls = stubApi([[
      "/sales-orders/order-1",
      () => ({ data: editOrder({
        materialRefs: [{ specKey: "canopy_spec", material }],
        slotImages: detailSlotImages("canopy_spec", ["img-1"]),
      }), meta: {} }),
    ], ["/materials", () => ({ data: [material], meta: {} })]]);
    render(<SalesOrderEditor orderId="order-1" />);

    // 行图优先：显示行图，不显示物料图
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1"));
    expect(screen.queryByTestId("material-image-thumb-m-1")).toBeNull();

    await userEvent.click(field("sales-material-image-canopy_spec-remove-0"));
    // 删光行图：物料图作为兜底回来，按钮回到「上传图片」
    expect(field("material-image-thumb-m-1")).toHaveAttribute("src", "/api/v1/materials/m-1/image?v=sha-mat-1");
    expect(field("sales-material-image-canopy_spec-pick")).toHaveTextContent("上传图片");

    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect((calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>).slot_images).toEqual([]);
  });

  it("新建单（没有单 id）：图片控件禁用，并提示「先保存销售单，再上传图片」", async () => {
    stubApi();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    expect(field("sales-material-image-rib_spec-pick")).toBeDisabled();
    expect(field("sales-material-image-rib_spec-pick")).toHaveAttribute("title", "先保存销售单，再上传图片");
    expect(field("sales-material-images-unsaved-hint")).toHaveTextContent("先保存销售单，再上传图片");
    // 细分明细同一条口径（图片按销售单隔离，没有单就没有归属）
    expect(field("sales-detail-image-0-pick")).toBeDisabled();
    expect(field("sales-detail-images-unsaved-hint")).toHaveTextContent("先保存销售单，再上传图片");
  });

  it("第 1 张且引用的物料没有图：弹确认；选「同时写入物料清单」把同一张图写进物料清单", async () => {
    const material = { id: "m-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null };
    stubApi([
      ["/sales-orders/order-1", () => ({ data: editOrder({ materialRefs: [{ specKey: "rib_spec", material }] }), meta: {} })],
      ["/materials", () => ({ data: [material], meta: {} })],
    ]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(field("sales-material-ref-clear-rib_spec")).toBeTruthy());

    const file = rowImageFile("伞骨.png");
    uploadVia("sales-material-image-rib_spec", file);

    const dialog = await screen.findByTestId("action-dialog");
    expect(dialog.textContent).toContain("物料清单里还没有图片");
    expect(dialog.textContent).toContain("同时写入物料清单");
    // 确认前：只挂了行图，物料图还没动
    expect(uploadMaterialImageMock).not.toHaveBeenCalled();

    await userEvent.click(field("action-dialog-submit"));
    await waitFor(() => expect(uploadMaterialImageMock).toHaveBeenCalledTimes(1));
    expect(uploadMaterialImageMock.mock.calls[0][0]).toBe("m-1");
    // 同一张原图（不是重新选一次），文件名不变
    expect((uploadMaterialImageMock.mock.calls[0][1] as File).name).toBe("伞骨.png");
    // 行图留着（写物料清单是额外的好处，不是交换）
    expect(field("sales-material-image-rib_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1");
    // 物料池里那个物料现在有图了：删掉行图就该退回这张物料图（不必刷新页面）
    await userEvent.click(field("sales-material-image-rib_spec-remove-0"));
    await waitFor(() => expect(field("material-image-thumb-m-1")).toHaveAttribute("src", "/api/v1/materials/m-1/image?v=sha-mat-1"));
  });

  it("确认弹窗选「取消」= 只用于本单；之后再传第 2、3 张**不再**弹（只问第 1 张）", async () => {
    queueUploads();
    const material = { id: "m-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null };
    stubApi([
      ["/sales-orders/order-1", () => ({ data: editOrder({ materialRefs: [{ specKey: "rib_spec", material }] }), meta: {} })],
      ["/materials", () => ({ data: [material], meta: {} })],
    ]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(field("sales-material-ref-clear-rib_spec")).toBeTruthy());

    uploadVia("sales-material-image-rib_spec");
    await screen.findByTestId("action-dialog");
    await userEvent.click(field("action-dialog-cancel"));
    expect(uploadMaterialImageMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    expect(field("sales-material-image-rib_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1");

    // 第 2 张：不再问（物料清单本身只有一张图，3 张都问会变成打扰）
    uploadVia("sales-material-image-rib_spec");
    await waitFor(() => expect(field("sales-material-image-rib_spec-thumb-1")).toBeTruthy());
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    await waitFor(() => expect(uploadSalesOrderImageMock).toHaveBeenCalledTimes(2));
    expect(uploadMaterialImageMock).not.toHaveBeenCalled();
  });

  it("写物料清单失败：只提示原因，不回滚已经挂上的行图", async () => {
    const material = { id: "m-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null };
    uploadMaterialImageMock.mockRejectedValue(new Error("没有修改物料清单的权限"));
    stubApi([
      ["/sales-orders/order-1", () => ({ data: editOrder({ materialRefs: [{ specKey: "rib_spec", material }] }), meta: {} })],
      ["/materials", () => ({ data: [material], meta: {} })],
    ]);
    render(<SalesOrderEditor orderId="order-1" />);
    await waitFor(() => expect(field("sales-material-ref-clear-rib_spec")).toBeTruthy());

    uploadVia("sales-material-image-rib_spec");
    await screen.findByTestId("action-dialog");
    await userEvent.click(field("action-dialog-submit"));

    await waitFor(() => expect(uploadMaterialImageMock).toHaveBeenCalledTimes(1));
    // 弹窗关掉、行图还在 —— 失败的只是"下次引用能直接带图"，不该让用户白传一次
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
    expect(field("sales-material-image-rib_spec-thumb-0")).toBeTruthy();
    // 物料池里那个物料**仍然**没有图（失败不伪造成功：它没有图片兜底，所以界面上不该冒出物料缩略图）
    expect(screen.queryByTestId("material-image-thumb-m-1")).toBeNull();
  });

  it("细分明细：每行也能传 3 张，「图片」列固定插在品番/品名之后，保存进 spec_details[].image_ids", async () => {
    queueUploads();
    const calls = stubApi([[
      "/sales-orders/order-1",
      () => ({ data: editOrder({
        specDetails: [{ groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: "1960", unit: "pcs", sortOrder: 0 }],
      }), meta: {} }),
    ]]);
    render(<SalesOrderEditor orderId="order-1" />);
    await screen.findByText("材料明细");

    // 「图片」列不参与 detailLabels（那是用户可改名的 6 列），列名固定
    expect(field("sales-detail-head-image")).toHaveTextContent("图片");

    uploadVia("sales-detail-image-0");
    await waitFor(() => expect(field("sales-detail-image-0-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1"));
    uploadVia("sales-detail-image-0");
    await waitFor(() => expect(field("sales-detail-image-0-thumb-1")).toBeTruthy());
    uploadVia("sales-detail-image-0");
    await waitFor(() => expect(field("sales-detail-image-0-thumb-2")).toBeTruthy());
    expect(field("sales-detail-image-0-pick")).toBeDisabled();
    expect(field("sales-detail-image-0-pick")).toHaveAttribute("title", "已满 3 张");

    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>;
    expect((body.spec_details as Array<Record<string, unknown>>)[0].image_ids).toEqual(["img-1", "img-2", "img-3"]);
    expect((body.spec_details as Array<Record<string, unknown>>)[0].name).toBe("27621 流水花扇PKGY");
  });

  it("编辑既有单回填：18 格按 slotIndex 聚合、行按三关系回填（各 3 张），保存时原样发回", async () => {
    const calls = stubApi([[
      "/sales-orders/order-1",
      () => ({ data: editOrder({
        slotImages: detailSlotImages("canopy_spec", ["img-1", "img-2", "img-3"]),
        specDetails: [{ groupName: "伞布明细", name: "花色A", color: null, barcode: null, quantity: "10", unit: "pcs", sortOrder: 0, ...detailRowImages(["img-4", "img-5", "img-6"]) }],
        materialExtras: [{ id: "e-1", label: "弹簧", content: "5cm", sortOrder: 0, specKey: null, material: null, ...detailRowImages(["img-7", "img-8", "img-9"]) }],
      }), meta: {} }),
    ]]);
    render(<SalesOrderEditor orderId="order-1" />);

    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-2")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-3?v=sha-img-3"));
    expect(field("sales-material-image-canopy_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-1?v=sha-img-1");
    expect(field("sales-material-image-canopy_spec-thumb-1")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-2?v=sha-img-2");
    expect(field("sales-detail-image-0-thumb-2")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-6?v=sha-img-6");
    expect(field("sales-material-extra-image-0-thumb-2")).toHaveAttribute("src", "/api/v1/sales-orders/order-1/images/img-9?v=sha-img-9");
    // 满 3 张的格/行按钮禁用
    expect(field("sales-material-image-canopy_spec-pick")).toHaveAttribute("title", "已满 3 张");

    await userEvent.click(field("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = calls.find((call) => call.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.slot_images).toEqual([{ spec_key: "canopy_spec", image_ids: ["img-1", "img-2", "img-3"] }]);
    expect((body.spec_details as Array<Record<string, unknown>>)[0].image_ids).toEqual(["img-4", "img-5", "img-6"]);
    expect((body.material_extras as Array<Record<string, unknown>>)[0].image_ids).toEqual(["img-7", "img-8", "img-9"]);
  });

  it("复制回填（images/image_ids 请求键形状）：缩略图用**来源单 id**，保存时把 image_ids 交回后端逐张克隆", async () => {
    searchParamsState.current = new URLSearchParams({ copy_from_id: "source-1" });
    const calls = stubApi([[
      "/copy-snapshot",
      () => ({ data: {
        source_order_no: "DL260001-1", source_order_id: "source-1", customer_id: "customer-1", contact_id: null,
        copy: {
          product_name: "折叠伞", unit: "支", currency: "USD",
          slot_images: [{ spec_key: "canopy_spec", image_ids: ["img-7", "img-8"], images: [
            { id: "img-7", width: 800, height: 600, byteSize: 1000, sha256: "sha-7" },
            { id: "img-8", width: 800, height: 600, byteSize: 1000, sha256: "sha-8" },
          ] }],
          spec_details: [{ group_name: "伞布明细", name: "花色A", quantity: "10", unit: "pcs", image_ids: ["img-9"], images: [{ id: "img-9", width: 400, height: 300, byteSize: 900, sha256: "sha-9" }] }],
        },
        must_fill: ["order_no", "order_date", "quantity", "delivery_date"],
      }, meta: {} }),
    ]]);
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    // 图还挂在来源单上：缩略图必须用来源单 id 去读（用新单的 id 会 404 / 显示裂图）
    await waitFor(() => expect(field("sales-material-image-canopy_spec-thumb-1")).toHaveAttribute("src", "/api/v1/sales-orders/source-1/images/img-8?v=sha-8"));
    expect(field("sales-material-image-canopy_spec-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/source-1/images/img-7?v=sha-7");
    expect(field("sales-detail-image-0-thumb-0")).toHaveAttribute("src", "/api/v1/sales-orders/source-1/images/img-9?v=sha-9");
    // 新单还没保存：不能往来源单上直接传图（那是别人的单）
    expect(field("sales-material-image-canopy_spec-pick")).toBeDisabled();

    fireEvent.change(field("sales-base-order_no"), { target: { value: "DL260300-2" } });
    fireEvent.change(field("sales-base-order_date"), { target: { value: "2026-11-05" } });
    fireEvent.change(field("sales-base-quantity"), { target: { value: "2500" } });
    await userEvent.click(field("sales-order-save"));

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const body = calls.find((call) => call.method === "POST")!.body as Record<string, unknown>;
    expect(body.slot_images).toEqual([{ spec_key: "canopy_spec", image_ids: ["img-7", "img-8"] }]);
    expect((body.spec_details as Array<Record<string, unknown>>)[0].image_ids).toEqual(["img-9"]);
  });
});
