// MaterialSlipEditor（领料单 / 补料单全屏编辑页）的**真实行为**测试。
//
// 取代的遗留「源码正则」测试（那些文件用 readFileSync + 正则断言 JSX 的书写形式：
// 重构即误红、真实运行时缺陷一律漏过）：
//   - apps/web/lib/warehouse-issue-sheet.test.mjs
//     继承的断言意图：① 物料下拉必须来自**该生产单订单**的 BOM 明细而不是全部物料；
//                     ② 同一物料只能一行（都用完时禁用「添加行」、保存前先拦重复）；
//                     ③ 编辑已有草稿时锁定生产单；④ 补料单走 replenishments / post-replenishment。
//   - apps/web/lib/auto-open-pages.test.mjs
//     继承的断言意图：⑤ 深链 ?movement_id= 时编辑页**直接**按 id 拉取草稿并回填（不依赖自动弹窗）；
//                     ⑥ 深链 ?production_order_id= 预选生产单。
// 未继承（属渲染/样式细节，或属于仓库列表页）：CSS 省略号断言、「仓库页两个新建入口」、
// 「列表页再建入口」「回退草稿」——它们不在本组件的职责内。
//
// 纪律：不 readFileSync、不正则匹配源码、不断言 className；只断言**渲染结果 + 网络调用**。
// 注意：globals: false，vitest API 必须显式 import（见 apps/web/vitest.config.mts）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { StubbedCall } from "./helpers/api-stub";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";
import { Toaster } from "../components/ui/toaster";
import { MaterialSlipEditor } from "../components/production/material-slip-editor";

/** ?movement_id= / ?production_order_id= 的桩：每个用例的 beforeEach 会重置为空。 */
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => "/production/material-issues/new",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

// Link 在 jsdom 里没有 App Router 上下文；换成普通 <a>（Button asChild 会把 className 合进来）。
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href?: unknown; children?: ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

// ---------------------------------------------------------------- 测试数据

const orders = [
  // 可领料：厂内 + 生产中；bomId 两种写法（bom.id / bomId）都覆盖
  { id: "po-1", productionOrderNo: "MO-001", orderNo: "SO-001", executionMode: "in_house", status: "in_progress", bomId: "bom-1" },
  { id: "po-2", productionOrderNo: "MO-002", orderNo: "SO-002", executionMode: "in_house", status: "in_progress", bom: { id: "bom-2" } },
  // 不可领料：外协、以及厂内但非生产中
  { id: "po-3", productionOrderNo: "MO-003", orderNo: "SO-003", executionMode: "outsourced", status: "in_progress", bomId: "bom-3" },
  { id: "po-4", productionOrderNo: "MO-004", orderNo: "SO-004", executionMode: "in_house", status: "completed", bomId: "bom-4" },
];

const bomItemsByBomId: Record<string, unknown[]> = {
  "bom-1": [
    { materialId: "m-1", materialName: "面料A", model: "A-1", requiredQuantity: "10", unit: "米" },
    { materialId: "m-2", materialName: "面料B", model: null, specificationModel: "B-2", requiredQuantity: "4", unit: "张" },
  ],
  "bom-2": [{ materialId: "m-9", materialName: "里布C", model: null, specificationModel: null, requiredQuantity: "2", unit: "米" }],
};

const rawBalances = [
  { material_id: "m-1", unit_name: "米", quantity: "30" },
  { material_id: "m-1", unit_name: "卷", quantity: "2" },
  { material_id: "m-2", unit_name: "张", quantity: "5" },
];

/** issue-preview 的返回：索引与请求行一一对应。 */
const previewData = {
  lines: [
    { material_id: "m-1", material_code: "RM-001", model: "A-1", color: "米白", approved_usage: "12", bom_reference_quantity: "10", inventory_quantity: "30", available_before: "28", purchase_received_quantity: "50", purchase_outstanding_quantity: "6", cumulative_issued_after: "2", production_outstanding_quantity: "8" },
    { material_id: "m-2", material_code: "RM-002", model: "B-2", color: "藏青", approved_usage: "4", bom_reference_quantity: "4", inventory_quantity: "5", available_before: "5", purchase_received_quantity: "0", purchase_outstanding_quantity: "0", cumulative_issued_after: "0", production_outstanding_quantity: "4" },
    { material_id: "m-9", material_code: "RM-009", model: "C-9", color: "灰", approved_usage: "2", bom_reference_quantity: "2", inventory_quantity: "9", available_before: "9", purchase_received_quantity: "0", purchase_outstanding_quantity: "0", cumulative_issued_after: "0", production_outstanding_quantity: "2" },
  ],
  warnings: [] as string[],
};

const draftMovement = {
  id: "mv-1",
  movementNo: "MI-2026-0007",
  documentType: "issue",
  status: "draft",
  productionOrderId: "po-2",
  reason: null as string | null,
  lines: [{ materialId: "m-9", quantity: "3", remark: "首批" }],
};

// ---------------------------------------------------------------- 桩与工具

type StubOptions = {
  ordersResponse?: () => Response | Promise<Response>;
  bom?: Record<string, unknown[]>;
  preview?: (call: StubbedCall) => Response | Promise<Response>;
  create?: (call: StubbedCall) => Response | Promise<Response>;
  movement?: () => Response | Promise<Response>;
};

/** 按路径分发 GET/POST/PATCH 的 fetch 桩；未登记的请求返回 404（避免静默通过）。 */
function stub(options: StubOptions = {}) {
  return stubApi((url, call) => {
    if (url.endsWith("/production/orders")) return options.ordersResponse ? options.ordersResponse() : apiOk(orders);
    if (url.endsWith("/inventory/raw-material-balances")) return apiOk(rawBalances);
    if (url.includes("/boms/")) {
      const bomId = url.slice(url.indexOf("/boms/") + "/boms/".length);
      return apiOk({ items: (options.bom ?? bomItemsByBomId)[bomId] ?? [] });
    }
    if (url.endsWith("/issue-preview")) return options.preview ? options.preview(call) : apiOk(previewData);
    if (url.endsWith("/post") || url.endsWith("/post-replenishment")) return apiOk({});
    if (call.method === "POST" && (url.endsWith("/production/material-movements") || url.endsWith("/production/material-movements/replenishments"))) {
      return options.create ? options.create(call) : apiOk({ id: "mv-new" });
    }
    if (call.method === "PATCH" && /\/production\/material-movements\/[^/]+$/.test(url)) return apiOk({ id: "mv-1" });
    if (call.method === "GET" && /\/production\/material-movements\/[^/]+$/.test(url)) return options.movement ? options.movement() : apiOk(null);
    return apiErr(404, "NOT_FOUND", `测试桩未登记的请求：${call.method} ${url}`);
  });
}

type PreviewBody = { production_order_id: string; reason?: string; lines: Array<{ material_id: string; quantity: string; remark?: string }> };

const bodiesTo = (calls: StubbedCall[], suffix: string): PreviewBody[] =>
  callsTo(calls, suffix).map((call) => JSON.parse(String(call.body)) as PreviewBody);

const lastBody = (calls: StubbedCall[], suffix: string): PreviewBody | undefined => bodiesTo(calls, suffix).at(-1);

/** 创建单据的请求（领料或补料）——过账请求不在此列。 */
const creates = (calls: StubbedCall[]) =>
  calls.filter((call) => call.method === "POST" && (call.url.endsWith("/production/material-movements") || call.url.endsWith("/production/material-movements/replenishments")));

/** 过账请求（post / post-replenishment）。 */
const posts = (calls: StubbedCall[]) =>
  calls.filter((call) => call.method === "POST" && (call.url.endsWith("/post") || call.url.endsWith("/post-replenishment")));

/** 把组件渲染到「已加载完成」；加载失败/被拦截的用例直接 render，不走这里。 */
async function renderSlip(documentType: "issue" | "replenishment" = "issue") {
  const view = render(<><Toaster /><MaterialSlipEditor documentType={documentType} /></>);
  await screen.findByTestId("material-slip-lines");
  return view;
}

/** 按表头文字取某列所有数据行的可见文本（表头由组件自己渲染，不依赖列序号常量）。 */
function columnValues(headerName: string): string[] {
  const panel = screen.getByTestId("material-slip-lines");
  const headers = Array.from(panel.querySelectorAll("thead th")).map((node) => (node.textContent ?? "").trim());
  const columnIndex = headers.indexOf(headerName);
  if (columnIndex < 0) throw new Error(`表头缺少「${headerName}」列，实际列：${headers.join(" | ")}`);
  return Array.from(panel.querySelectorAll("tbody tr"))
    .filter((row) => row.querySelectorAll("td").length > 1)
    .map((row) => (row.querySelectorAll("td")[columnIndex]?.textContent ?? "").trim());
}

const quantityInput = (index: number) => screen.getByTestId(`material-slip-line-quantity-${index}`);
const deleteButtons = () => screen.getAllByRole("button", { name: "删除行" });
const orderSelect = () => screen.getByTestId("material-slip-order-select");

/** 可手动控制的 Promise：把组件稳定停在 busy 状态上做断言。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
});

// ---------------------------------------------------------------- 用例

describe("MaterialSlipEditor 领料单：加载与 BOM 数据流", () => {
  it("加载中先显示 LoadingState，加载完成后渲染明细表", async () => {
    stub();
    render(<><Toaster /><MaterialSlipEditor documentType="issue" /></>);

    expect(screen.getByTestId("loading-state")).toBeVisible();

    expect(await screen.findByTestId("material-slip-lines")).toBeVisible();
  });

  it("按生产单订单的 BOM 加载物料：第一行默认选中 BOM 首个物料，并立即请求预览", async () => {
    const calls = stub();
    await renderSlip();

    // 订单 / 原料余额 各读一次；BOM 只读当前生产单那一份（继承自遗留用例①）
    expect(callsTo(calls, "/production/orders")).toHaveLength(1);
    expect(callsTo(calls, "/inventory/raw-material-balances")).toHaveLength(1);
    expect(callsTo(calls, "/boms/bom-1")).toHaveLength(1);
    expect(callsTo(calls, "/boms/bom-2")).toHaveLength(0);
    // 不得再走「全部物料」接口（遗留用例①的核心：选项只能来自 BOM）
    expect(calls.some((call) => call.url.endsWith("/materials"))).toBe(false);

    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({ production_order_id: "po-1", lines: [{ material_id: "m-1", quantity: "1" }] });
    });

    expect(quantityInput(0)).toHaveValue(1);
    expect(deleteButtons()).toHaveLength(1);
  });

  it("预览列渲染核定用量、当前库存量等真实数值", async () => {
    stub();
    await renderSlip();

    await waitFor(() => expect(columnValues("核定用量")).toEqual(["12"]));
    expect(columnValues("物料代码")).toEqual(["RM-001"]);
    expect(columnValues("型号")).toEqual(["A-1"]);
    expect(columnValues("颜色")).toEqual(["米白"]);
    expect(columnValues("当前库存量")).toEqual(["30"]);
    expect(columnValues("采购入库数量")).toEqual(["50"]);
    expect(columnValues("采购未入库数量")).toEqual(["6"]);
    expect(columnValues("生产领用数量")).toEqual(["2"]);
    expect(columnValues("生产未领用数量")).toEqual(["8"]);
  });

  it("生产单下拉只列出「厂内生产中」的订单（外协/已完工不出现）", async () => {
    stub();
    await renderSlip();

    await userEvent.click(orderSelect());

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => (option.textContent ?? "").trim())).toEqual(["MO-001 / SO-001", "MO-002 / SO-002"]);
  });

  it("切换生产单：重新加载该订单的 BOM，并用新生产单重算预览", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(orderSelect());
    await userEvent.click(await screen.findByRole("option", { name: /MO-002/ }));

    await waitFor(() => expect(callsTo(calls, "/boms/bom-2")).toHaveLength(1));
    // 回归点：换单后预览必须带新单号、新 BOM 的首个物料，不能拿旧单算（源码注释里专门说明过）
    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({ production_order_id: "po-2", lines: [{ material_id: "m-9", quantity: "1" }] });
    });
    expect(quantityInput(0)).toHaveValue(1);
  });

  it("预览接口返回 warnings 时在页面上显示警告", async () => {
    stub({ preview: () => apiOk({ lines: previewData.lines, warnings: ["面料A 库存不足，请先补货"] }) });
    await renderSlip();

    expect(await screen.findByText("面料A 库存不足，请先补货")).toBeVisible();
  });

  it("预览接口失败时不整页报错：明细列回落到「-」，行仍可编辑", async () => {
    stub({ preview: () => apiErr(500, "INTERNAL", "预览失败") });
    await renderSlip();

    await waitFor(() => expect(columnValues("核定用量")).toEqual(["-"]));
    expect(columnValues("当前库存量")).toEqual(["-"]);
    expect(quantityInput(0)).toBeEnabled();
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("BOM 没有明细时给出提示，且无法保存（校验拦下、不发写请求）", async () => {
    const calls = stub({ bom: { "bom-1": [] } });
    await renderSlip();

    expect(screen.getByText("该生产单订单的 BOM 没有明细，无法选择物料：请先在订单 BOM 里维护用料。")).toBeVisible();

    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    expect(await screen.findByRole("alert")).toHaveTextContent("每一行都必须选择物料并填写大于 0 的数量");
    expect(creates(calls)).toHaveLength(0);
  });
});

describe("MaterialSlipEditor 领料单：行增删与数量输入", () => {
  it("添加行：自动选中还没用过的物料，并把两行一起送入预览", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-add-line"));

    expect(deleteButtons()).toHaveLength(2);
    expect(quantityInput(1)).toHaveValue(1);
    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({
        production_order_id: "po-1",
        lines: [{ material_id: "m-1", quantity: "1" }, { material_id: "m-2", quantity: "1" }],
      });
    });
  });

  it("BOM 里的物料都占用后「添加行」禁用（同一物料只能一行，继承自遗留用例②）", async () => {
    stub();
    await renderSlip();

    expect(screen.getByTestId("material-slip-add-line")).toBeEnabled();

    await userEvent.click(screen.getByTestId("material-slip-add-line"));

    expect(screen.getByTestId("material-slip-add-line")).toBeDisabled();
    expect(deleteButtons()).toHaveLength(2);
  });

  it("行内物料下拉只提供该生产单 BOM 的物料，选择后按新物料重算预览", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-line-material-0"));

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => (option.textContent ?? "").trim())).toEqual(["面料A / A-1 / 需 10米", "面料B / B-2 / 需 4张"]);

    await userEvent.click(screen.getByRole("option", { name: /面料B/ }));

    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({ production_order_id: "po-1", lines: [{ material_id: "m-2", quantity: "1" }] });
    });
  });

  it("删除行：行从表格消失；删掉最后一行回到空态且不再请求预览", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-add-line"));
    await userEvent.click(deleteButtons()[0]);

    expect(deleteButtons()).toHaveLength(1);
    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({ production_order_id: "po-1", lines: [{ material_id: "m-2", quantity: "1" }] });
    });

    const previewCountBefore = callsTo(calls, "/issue-preview").length;
    await userEvent.click(deleteButtons()[0]);

    expect(await screen.findByTestId("empty-state")).toHaveTextContent("还没有明细");
    expect(screen.queryAllByRole("button", { name: "删除行" })).toHaveLength(0);
    // 空明细不产生新请求（refreshPreview 提前返回）
    expect(callsTo(calls, "/issue-preview")).toHaveLength(previewCountBefore);
  });

  it("数量输入驱动重新预览，并原样进入保存请求", async () => {
    const calls = stub();
    await renderSlip();

    const input = quantityInput(0);
    await userEvent.clear(input);
    await userEvent.type(input, "2.5");

    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({ production_order_id: "po-1", lines: [{ material_id: "m-1", quantity: "2.5" }] });
    });

    await userEvent.type(screen.getByPlaceholderText("可选"), "首批");
    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(JSON.parse(String(creates(calls)[0].body))).toEqual({
      production_order_id: "po-1",
      lines: [{ material_id: "m-1", quantity: "2.5", remark: "首批" }],
    });
  });

  it("数量为 0 时保存被拦下：提示每一行都要大于 0，且不发任何写请求", async () => {
    const calls = stub();
    await renderSlip();

    const input = quantityInput(0);
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    expect(await screen.findByRole("alert")).toHaveTextContent("每一行都必须选择物料并填写大于 0 的数量");
    expect(creates(calls)).toHaveLength(0);
    expect(posts(calls)).toHaveLength(0);
  });

  it("手动把两行选成同一物料：保存被拦下且不发写请求", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-add-line"));
    await userEvent.click(screen.getByTestId("material-slip-line-material-1"));
    await userEvent.click(await screen.findByRole("option", { name: /面料A/ }));

    // KNOWN_GAP（非崩溃性缺陷）：行内下拉**没有**把已用物料禁用/去掉，
    // 因此重复行能被构造出来 —— 只靠「添加行」默认值与保存前 validate() 兜底。
    // 责任文件：apps/web/components/production/material-slip-editor.tsx:267（SelectContent 无条件列出全部 BOM 物料）。
    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")?.lines).toEqual([
        { material_id: "m-1", quantity: "1" },
        { material_id: "m-1", quantity: "1" },
      ]);
    });

    // 但保存前必须被拦下（遗留用例②的行为契约）
    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    expect(await screen.findByRole("alert")).toHaveTextContent("同一物料只能有一行：请合并数量后再保存");
    expect(creates(calls)).toHaveLength(0);
  });
});

describe("MaterialSlipEditor 领料单：保存草稿与保存并出库", () => {
  it("保存草稿：POST 创建领料单草稿，不触发过账", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0].url).toBe("/api/v1/production/material-movements");
    expect(creates(calls)[0].method).toBe("POST");
    expect(JSON.parse(String(creates(calls)[0].body))).toEqual({
      production_order_id: "po-1",
      lines: [{ material_id: "m-1", quantity: "1" }],
    });
    expect(posts(calls)).toHaveLength(0);
    expect(await screen.findByTestId("toast-item")).toHaveTextContent("领料单草稿已创建");
  });

  it("保存并出库：先创建、再过账，过账请求带幂等键", async () => {
    const calls = stub();
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-post"));

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(creates(calls)).toHaveLength(1);
    // 顺序：创建必须先于过账（过账用的是创建返回的 id）
    expect(calls.indexOf(creates(calls)[0])).toBeLessThan(calls.indexOf(posts(calls)[0]));
    expect(posts(calls)[0].url).toBe("/api/v1/production/material-movements/mv-new/post");
    expect(JSON.parse(String(posts(calls)[0].body))).toMatchObject({ idempotency_key: expect.stringContaining("web-slip-") });
    expect(await screen.findByTestId("toast-item")).toHaveTextContent("领料单已保存并出库过账");
  });

  it("保存中：两个按钮都禁用并改文案，连点不会发出第二次创建请求", async () => {
    const gate = deferred<Response>();
    const calls = stub({ create: () => gate.promise });
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    const busyDraft = await screen.findByTestId("material-slip-save-draft");
    expect(busyDraft).toBeDisabled();
    expect(busyDraft).toHaveTextContent("保存中...");
    expect(screen.getByTestId("material-slip-post")).toBeDisabled();

    // 连点：禁用态下不得再触发 save()
    await userEvent.click(busyDraft);
    await userEvent.click(screen.getByTestId("material-slip-post"));
    expect(creates(calls)).toHaveLength(1);

    gate.resolve(apiOk({ id: "mv-new" }));

    // 失败/成功后必须回到可点状态，否则用户无法重试
    await waitFor(() => expect(screen.getByTestId("material-slip-save-draft")).toBeEnabled());
    expect(posts(calls)).toHaveLength(0);
  });

  it("保存失败：显示错误 toast，按钮恢复可点且不跳转", async () => {
    const calls = stub({ create: () => apiErr(422, "VALIDATION_ERROR", "用料数量超出现有库存") });
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    expect(await screen.findByTestId("toast-item")).toHaveTextContent("用料数量超出现有库存");
    await waitFor(() => expect(screen.getByTestId("material-slip-save-draft")).toBeEnabled());
    expect(posts(calls)).toHaveLength(0);
  });

  it("未选生产单时保存被拦下（BOM 为空 → 行无物料也算未选择）", async () => {
    const calls = stub();
    await renderSlip();

    // 把唯一一行的物料清空：先选一个物料再改回占位是不可能的（Radix 无空选项），
    // 因此这里用「删除全部行」制造空明细来验证「请至少添加一行物料」分支。
    await userEvent.click(deleteButtons()[0]);
    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    expect(await screen.findByRole("alert")).toHaveTextContent("请至少添加一行物料");
    expect(creates(calls)).toHaveLength(0);
  });
});

describe("MaterialSlipEditor 领料单：深链与草稿编辑", () => {
  it("?production_order_id= 预选该生产单并加载它的 BOM（继承自遗留用例⑥）", async () => {
    mockSearchParams = new URLSearchParams("production_order_id=po-2");
    const calls = stub();
    await renderSlip();

    await waitFor(() => expect(lastBody(calls, "/issue-preview")?.production_order_id).toBe("po-2"));
    expect(callsTo(calls, "/boms/bom-2")).toHaveLength(1);
    expect(callsTo(calls, "/boms/bom-1")).toHaveLength(0);
  });

  it("?production_order_id= 指向不可领料的生产单：整页只显示原因，绝不悄悄换成别的生产单", async () => {
    mockSearchParams = new URLSearchParams("production_order_id=po-3");
    const calls = stub();
    render(<><Toaster /><MaterialSlipEditor documentType="issue" /></>);

    expect(await screen.findByTestId("error-state")).toHaveTextContent("该生产单不是「生产中」的厂内生产单，不能领料");
    // 不能回退到 po-1/po-2 去算预览或选物料
    expect(callsTo(calls, "/issue-preview")).toHaveLength(0);
    expect(calls.some((call) => call.url.includes("/boms/"))).toBe(false);
    expect(screen.queryByTestId("material-slip-lines")).toBeNull();
    expect(screen.queryByTestId("material-slip-save-draft")).toBeNull();
  });

  it("?movement_id= 按 id 拉取草稿并回填（标题/行/备注/生产单锁定）（继承自遗留用例⑤）", async () => {
    mockSearchParams = new URLSearchParams("movement_id=mv-1");
    const calls = stub({ movement: () => apiOk(draftMovement) });
    await renderSlip();

    expect(callsTo(calls, "/production/material-movements/mv-1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("新建领料单（继续编辑 MI-2026-0007）");

    // 草稿挂在 po-2 上：BOM 必须按草稿的生产单加载，行按草稿回填
    expect(callsTo(calls, "/boms/bom-2")).toHaveLength(1);
    expect(quantityInput(0)).toHaveValue(3);
    expect(screen.getByPlaceholderText("可选")).toHaveValue("首批");
    await waitFor(() => {
      expect(lastBody(calls, "/issue-preview")).toEqual({ production_order_id: "po-2", lines: [{ material_id: "m-9", quantity: "3", remark: "首批" }] });
    });

    // 编辑态锁定生产单（PATCH 不支持换单，继承自遗留用例③）
    expect(orderSelect()).toBeDisabled();
    expect(screen.getByText(/该草稿已绑定当前生产单/)).toBeVisible();
  });

  it("编辑草稿后保存走 PATCH 更新原单，不新建第二张单", async () => {
    mockSearchParams = new URLSearchParams("movement_id=mv-1");
    const calls = stub({ movement: () => apiOk(draftMovement) });
    await renderSlip();

    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-1").some((call) => call.method === "PATCH")).toBe(true));
    const patch = callsTo(calls, "/production/material-movements/mv-1").find((call) => call.method === "PATCH")!;
    expect(JSON.parse(String(patch.body))).toEqual({
      production_order_id: "po-2",
      lines: [{ material_id: "m-9", quantity: "3", remark: "首批" }],
    });
    expect(creates(calls)).toHaveLength(0);
    expect(await screen.findByTestId("toast-item")).toHaveTextContent("草稿已保存");
  });

  it("草稿已过账：整页只显示原因，不渲染可编辑表单", async () => {
    mockSearchParams = new URLSearchParams("movement_id=mv-1");
    stub({ movement: () => apiOk({ ...draftMovement, status: "posted" }) });
    render(<><Toaster /><MaterialSlipEditor documentType="issue" /></>);

    expect(await screen.findByTestId("error-state")).toHaveTextContent("只有草稿单据可以在这里编辑");
    expect(screen.queryByTestId("material-slip-lines")).toBeNull();
    expect(screen.queryByTestId("material-slip-post")).toBeNull();
  });

  it("把补料单草稿从领料编辑页打开：提示类型不一致，不渲染表单", async () => {
    mockSearchParams = new URLSearchParams("movement_id=mv-1");
    stub({ movement: () => apiOk({ ...draftMovement, documentType: "replenishment" }) });
    render(<><Toaster /><MaterialSlipEditor documentType="issue" /></>);

    expect(await screen.findByTestId("error-state")).toHaveTextContent("该单据类型与当前页面不一致（replenishment）");
    expect(screen.queryByTestId("material-slip-lines")).toBeNull();
  });
});

describe("MaterialSlipEditor 补料单", () => {
  it("补料单不请求 issue-preview，库存按原料余额展示，且列集合与领料单不同", async () => {
    const calls = stub();
    await renderSlip("replenishment");

    expect(callsTo(calls, "/issue-preview")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("新建补料单");
    expect(screen.getByRole("columnheader", { name: "补领数量" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "采购入库数量" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "生产未领用数量" })).toBeNull();
    // 同一物料的多条余额合并展示（m-1：30 米 + 2 卷）
    expect(columnValues("当前库存量")).toEqual(["30 米、2 卷"]);
    // 核定用量列仍在，但补料单没有预览数据时回落为「-」
    expect(columnValues("核定用量")).toEqual(["-"]);
  });

  it("补料没填原因时保存被拦下，填了才发创建请求（补料接口）", async () => {
    const calls = stub();
    await renderSlip("replenishment");

    await userEvent.click(screen.getByTestId("material-slip-save-draft"));
    expect(await screen.findByRole("alert")).toHaveTextContent("补料必须填写补料原因（坏片/生产失误等）");
    expect(creates(calls)).toHaveLength(0);

    await userEvent.type(screen.getByPlaceholderText("例如：伞布原始坏片"), "坏片补料");
    await userEvent.click(screen.getByTestId("material-slip-save-draft"));

    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0].url).toBe("/api/v1/production/material-movements/replenishments");
    expect(JSON.parse(String(creates(calls)[0].body))).toEqual({
      production_order_id: "po-1",
      reason: "坏片补料",
      lines: [{ material_id: "m-1", quantity: "1" }],
    });
  });

  it("补料单保存并出库走 post-replenishment（走错接口服务端会 422）", async () => {
    const calls = stub();
    await renderSlip("replenishment");

    await userEvent.type(screen.getByPlaceholderText("例如：伞布原始坏片"), "坏片补料");
    await userEvent.click(screen.getByTestId("material-slip-post"));

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(creates(calls)[0].url).toBe("/api/v1/production/material-movements/replenishments");
    expect(posts(calls)[0].url).toBe("/api/v1/production/material-movements/mv-new/post-replenishment");
    expect(await screen.findByTestId("toast-item")).toHaveTextContent("补料单已保存并出库过账");
  });
});

describe("MaterialSlipEditor：加载失败与新建入口", () => {
  it("生产单加载失败：显示错误态与「重新加载」，不渲染表单", async () => {
    stub({ ordersResponse: () => apiErr(500, "INTERNAL", "生产单加载失败") });
    render(<><Toaster /><MaterialSlipEditor documentType="issue" /></>);

    expect(await screen.findByTestId("error-state")).toHaveTextContent("生产单加载失败");
    expect(screen.getByTestId("error-state-retry")).toBeVisible();
    expect(screen.queryByTestId("material-slip-lines")).toBeNull();
  });

  it("页面标题与两个返回入口指向单据列表 / 仓库", async () => {
    stub();
    await renderSlip();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("新建领料单");
    expect(screen.getByRole("link", { name: "返回单据列表" })).toHaveAttribute("href", "/production/material-issues");
    expect(screen.getByRole("link", { name: "返回仓库" })).toHaveAttribute("href", "/warehouse");
  });
});
