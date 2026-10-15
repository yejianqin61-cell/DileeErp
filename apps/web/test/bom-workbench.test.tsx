// BOM 工作区（采购与生产共用组件）的行为测试。
//
// 覆盖本轮整改的关键契约：
//   1. 保存时带上打开时的 `updatedAt`（乐观锁令牌）——没有它，两个模块同时编辑就会互相覆盖；
//   2. 服务端返回 422 BOM_UPDATE_CONFLICT 时：显示冲突提示、本地改动保留、不提示"已保存"；
//   3. 冲突后「重新加载最新版本」会重新 GET，并显示服务端的最新明细；
//   4. 没有创建物料入口（生产模块）时只给提示，不渲染「新建物料」按钮。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BomWorkbench } from "../components/bom/bom-workbench";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const OPENED_AT = "2026-09-14T02:00:00.000Z";
const POLLUTED_AT = "2026-09-14T02:05:00.000Z";

const materials = [
  { id: "m-1", materialCode: "M-001", name: "面料A", materialType: "raw_material", isActive: true },
  { id: "m-2", materialCode: "M-002", name: "面料B", materialType: "raw_material", isActive: true },
];
const units = [{ id: "u-1", name: "米", isActive: true }];

const bomWith = (updatedAt: string, quantity = "2") => ({
  id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", status: "draft", version: 1, updatedAt,
  items: [{ id: "bi-1", materialId: "m-1", materialName: "面料A", model: "", requiredQuantity: quantity, unit: "米", unitId: "u-1", materialSnapshot: {} }],
});

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;

/**
 * 物料那一格的**触发器**。
 *
 * 2026-10-13 起它是 `SearchableSelect`：`data-testid` 落在**根 div** 上（那个原语自己的约定，
 * 与 Radix `Select` 把 testid 放在 trigger 按钮上不同），所以 `getByTestId("bom-material-0")`
 * 拿到的是外层容器 —— 点它不会展开（点了没反应的那种坑），要进到里面找 `combobox`。
 * 收起态那个 button 与展开态那个搜索框都显式声明了 `role="combobox"`，两种形态下都能用它找到控件。
 */
const materialTrigger = async (index = 0) => within(await screen.findByTestId(`bom-material-${index}`)).getByRole("combobox");

function renderWorkbench(options: { onSaved?: () => void; onCreateMaterial?: (apply: (material: (typeof materials)[number]) => void) => void } = {}) {
  return render(<>
    <BomWorkbench bomId="bom-1" title="SO-1" materials={materials} units={units} onClose={() => undefined} onSaved={options.onSaved} onCreateMaterial={options.onCreateMaterial} />
    <Toaster />
  </>);
}

describe("BOM 工作区：乐观锁令牌", () => {
  it("保存时回传打开时的 updatedAt，落到 PUT 请求体里", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(POLLUTED_AT));
      return apiOk({});
    });
    const onSaved = vi.fn();
    renderWorkbench({ onSaved });

    await screen.findByDisplayValue("2");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("/api/v1/boms/bom-1/items");
    expect(bodyOf(put!).expected_updated_at).toBe(OPENED_AT);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText("BOM表已保存")).toBeVisible();
  });

  it("保存时把人工改过的数量原样发出（不被主数据回填覆盖）", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(POLLUTED_AT));
      return apiOk({});
    });
    renderWorkbench();

    const quantity = await screen.findByDisplayValue("2");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "7.5");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const items = bodyOf(calls.find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items[0].required_quantity).toBe("7.5");
    expect(items[0].material_id).toBe("m-1");
  });
});

describe("BOM 工作区：并发冲突", () => {
  it("服务端返回 BOM_UPDATE_CONFLICT 时给出冲突提示，保留本地改动，且不提示已保存", async () => {
    stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiErr(422, "BOM_UPDATE_CONFLICT", "BOM 已被他人（采购或生产）修改，本次保存没有写入；请重新加载最新版本后再改一次");
      return apiOk({});
    });
    renderWorkbench();

    const quantity = await screen.findByDisplayValue("2");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "9");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const conflict = await screen.findByTestId("bom-conflict");
    expect(conflict).toHaveTextContent("已被他人（采购或生产）修改");
    // 本地改动必须还在屏幕上：用户刚录的内容不能被清掉
    expect(screen.getByDisplayValue("9")).toBeVisible();
    expect(screen.queryByText("BOM表已保存")).toBeNull();
  });

  it("冲突后「重新加载最新版本」会重新拉取，显示服务端的最新明细并清掉提示", async () => {
    let served = bomWith(OPENED_AT);
    stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(served);
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiErr(422, "BOM_UPDATE_CONFLICT", "BOM 已被他人（采购或生产）修改");
      return apiOk({});
    });
    renderWorkbench();

    await screen.findByDisplayValue("2");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await screen.findByTestId("bom-conflict");

    // 另一个模块在这期间把数量改成了 4
    served = bomWith(POLLUTED_AT, "4");
    await userEvent.click(screen.getByRole("button", { name: "重新加载最新版本（放弃本次修改）" }));

    await waitFor(() => expect(screen.queryByTestId("bom-conflict")).toBeNull());
    expect(screen.getByDisplayValue("4")).toBeVisible();
  });
});

describe("BOM 工作区：新建物料入口按模块开放", () => {
  it("没有传入 onCreateMaterial 时（生产模块）不渲染「新建物料」，并说明物料池归采购", async () => {
    stubApi((url, call) => (url.endsWith("/boms/bom-1") && call.method === "GET" ? apiOk(bomWith(OPENED_AT)) : apiOk({})));
    renderWorkbench();

    await screen.findByDisplayValue("2");
    expect(screen.queryByRole("button", { name: "新建物料" })).toBeNull();
    expect(screen.getByText(/物料池由【采购 → 物料清单】维护/)).toBeVisible();
  });

  it("传入 onCreateMaterial 时（采购模块）按钮出现，新物料回填到当前行并存进保存请求", async () => {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(bomWith(OPENED_AT));
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(bomWith(POLLUTED_AT));
      return apiOk({});
    });
    let apply: ((material: (typeof materials)[number]) => void) | undefined;
    renderWorkbench({ onCreateMaterial: (callback) => { apply = callback; } });

    await screen.findByDisplayValue("2");
    await userEvent.click(screen.getByRole("button", { name: "新建物料" }));
    expect(apply).toBeTypeOf("function");
    // 采购页此时会弹出「新建物料」对话框并把新物料加进物料池，这里直接模拟创建成功后的回填
    apply?.({ id: "m-9", materialCode: "M-009", name: "伞骨", materialType: "raw_material", isActive: true });

    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    const items = bodyOf(calls.find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].material_id).toBe("m-9");
    expect(items[0].material_name).toBe("伞骨");
  });
});

// 2026-10-08（用户）：「1.BOM表页面，物料名称一长，后面的column就被压缩很窄。这很不好。我要求，
// 扩大BOM表悬浮居中页面的占页面大小，并且固定物料名称这一列的宽度。一旦字数超出，就省略显示，
// 鼠标hover时显示全部文字。」
//
// "列不再被压缩"靠的是 `table-layout: fixed` + 每列显式宽度，"省略"靠的是三家 CSS 属性 ——
// 那部分没有 jsdom 能测的东西，守卫在 `lib/bom-table.test.mjs`（钉 CSS 规则）与真实 Chromium 实测里。
// 这里钉的是它们依赖的两样**代码里的**契约：列的类名（CSS 规则挂在这些类上）、
// 以及触发器的 title（被省略掉的字要有地方看，且必须是屏幕上正在显示的那串字）。
describe("BOM 表：物料名称列（固定列宽 / 省略 / hover 全文）", () => {
  const LONG_NAME = "超细纤维防风防水涂层复合单面摇粒绒面料（加厚款 320g）";
  const longMaterial = { id: "m-long", materialCode: "M-20261008", name: LONG_NAME, materialType: "raw_material", isActive: true };
  const otherMaterial = { id: "m-2", materialCode: "M-002", name: "面料B", materialType: "raw_material", isActive: true };
  const item = (overrides: Record<string, unknown> = {}) => ({ id: "bi-1", materialId: "m-long", materialName: LONG_NAME, model: "", requiredQuantity: "2", unit: "米", unitId: "u-1", materialSnapshot: {}, ...overrides });

  function renderWith(rows: Array<Record<string, unknown>>, materialPool = [longMaterial, otherMaterial]) {
    stubApi((url, call) => (url.endsWith("/boms/bom-1") && call.method === "GET"
      ? apiOk({ id: "bom-1", orderNo: "SO-1", status: "draft", version: 1, updatedAt: OPENED_AT, items: rows })
      : apiOk({})));
    return render(<BomWorkbench bomId="bom-1" title="SO-1" materials={materialPool} units={units} onClose={() => undefined} />);
  }

  it("表头每一列都挂着与 CSS 列宽规则一一对应的类（类名一改，CSS 静默失效）", async () => {
    renderWith([item()]);
    const pairs: Array<[string, string]> = [
      ["序号", "bom-col-index"], ["物料名称", "bom-col-material"], ["型号", "bom-col-model"],
      ["规格型号", "bom-col-spec"], ["颜色", "bom-col-color"], ["数量", "bom-col-quantity"],
      ["单位", "bom-col-unit"], ["供应商", "bom-col-supplier"], ["操作", "bom-col-action"],
    ];
    for (const [header, className] of pairs) {
      expect((await screen.findByRole("columnheader", { name: header })).className).toContain(className);
    }
    expect(screen.getByTestId("bom-material-0").closest("td")?.className).toContain("bom-col-material");
  });

  it("title 是完整物料名（省略号只发生在屏幕上，不会进 title）", async () => {
    renderWith([item()]);
    const trigger = await materialTrigger();
    expect(trigger).toHaveAttribute("title", `M-20261008 / ${LONG_NAME}`);
    // hover 出来的必须与眼睛看到的是同一份字符串：触发器里显示的正是下拉选项的 label
    expect(trigger.textContent).toContain(`M-20261008 / ${LONG_NAME}`);
  });

  it("换了物料，title 跟着换（不是只在首次渲染时算一次）", async () => {
    renderWith([item()]);
    await userEvent.click(await materialTrigger());
    await userEvent.click(await screen.findByText("M-002 / 面料B"));
    // 选完下拉自己收起，触发器重新渲染：要重新取一次（不是拿旧节点）
    await waitFor(() => expect(within(screen.getByTestId("bom-material-0")).getByRole("combobox")).toHaveAttribute("title", "M-002 / 面料B"));
  });

  it("行里还没选物料时不给 title（空提示比没有提示更糟）", async () => {
    renderWith([item({ materialId: "", materialName: "" })]);
    expect(await materialTrigger()).not.toHaveAttribute("title");
  });
});

// 2026-10-08（用户）：「1.采购计划要下单需要填写单价，但是BOM表没办法填写单价，检查一下这条链路。
// 尤其是前端。」用户选定：BOM 行上手填「参考单价」（含币种），新建采购计划时预填到计划行（仍可改）。
//
// 这一列回答的是"这个部件通常多少钱"，与左边的供应商配对：**备查 + 预填**，
// 不参与任何金额计算（成本/毛利/应付都取采购单上的实际单价）。
describe("BOM 表：参考单价列", () => {
  const CURRENCIES = [{ key: "CNY", label: "人民币", isActive: true }, { key: "USD", label: "美元", isActive: true }];
  const row = (overrides: Record<string, unknown> = {}) => ({ id: "bi-1", materialId: "m-1", materialName: "面料A", model: "", requiredQuantity: "2", unit: "米", unitId: "u-1", materialSnapshot: {}, ...overrides });

  function renderWith(rows: Array<Record<string, unknown>>, options: { showReferencePrice?: boolean } = {}) {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk({ id: "bom-1", orderNo: "SO-1", status: "draft", version: 1, updatedAt: OPENED_AT, items: rows });
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk({ id: "bom-1", orderNo: "SO-1", status: "draft", version: 1, updatedAt: OPENED_AT, items: rows });
      if (url.endsWith("/dictionaries/currency/items")) return apiOk(CURRENCIES);
      return apiOk({});
    });
    render(<BomWorkbench bomId="bom-1" title="SO-1" materials={materials} units={units} showReferencePrice={options.showReferencePrice} onClose={() => undefined} />);
    return calls;
  }

  const putBody = (calls: StubbedCall[]) => bodyOf(calls.find((call) => call.method === "PUT")!);

  it("列头是「参考单价」，并把服务端带出的 4 位小数显示成好读的形式（12.5000 → 12.5）", async () => {
    renderWith([row({ referenceUnitPrice: "12.5000", referenceCurrency: "USD" })]);
    expect((await screen.findByRole("columnheader", { name: "参考单价" })).className).toContain("bom-col-price");
    expect(await screen.findByTestId("bom-price-0-input")).toHaveValue(12.5);
    expect(screen.getByTestId("bom-price-currency-0")).toHaveTextContent("USD");
  });

  it("填价 + 选币种 → 保存请求体带 reference_unit_price / reference_currency", async () => {
    const calls = renderWith([row({ referenceUnitPrice: "12.5000", referenceCurrency: "CNY" })]);
    const price = await screen.findByTestId("bom-price-0-input");
    await userEvent.clear(price);
    await userEvent.type(price, "8.25");
    await userEvent.click(screen.getByTestId("bom-price-currency-0"));
    await userEvent.click(await screen.findByText("USD"));
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const items = putBody(calls).items as Array<Record<string, unknown>>;
    expect(items[0].reference_unit_price).toBe("8.25");
    expect(items[0].reference_currency).toBe("USD");
  });

  it("清空价格 → 请求体里根本没有这个键（服务端存 NULL＝没填，不是 0）", async () => {
    const calls = renderWith([row({ referenceUnitPrice: "12.5000", referenceCurrency: "CNY" })]);
    await userEvent.clear(await screen.findByTestId("bom-price-0-input"));
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    const items = putBody(calls).items as Array<Record<string, unknown>>;
    expect("reference_unit_price" in items[0]).toBe(false);
    expect("reference_currency" in items[0]).toBe(false);
  });

  it("负数不发请求，并指出是第几行（服务端会拒整张表，先说清楚）", async () => {
    const calls = renderWith([row(), row({ id: "bi-2", materialId: "m-2" })]);
    const second = (await screen.findAllByTestId(/-input$/))[1];
    await userEvent.clear(second);
    await userEvent.type(second, "-3");
    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));

    expect(await screen.findByText(/第 2 行的参考单价不能是负数/)).toBeVisible();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("提示语把这条链路说清楚：填了会预填到采购计划的单价", async () => {
    renderWith([row()]);
    expect(await screen.findByTestId("bom-price-hint")).toHaveTextContent(/新建采购计划时会自动预填到计划行的单价/);
  });

  it("生产侧不显示这一列（showReferencePrice=false），但行上已有的价照旧回传、不会被抹掉", async () => {
    // 与「默认供应商」同一条道理：价是采购的知识，生产保存 BOM 不该把采购填过的价清掉。
    const calls = renderWith([row({ referenceUnitPrice: "7.0000", referenceCurrency: "USD" })], { showReferencePrice: false });
    await screen.findByRole("button", { name: "保存BOM表" });

    expect(screen.queryByRole("columnheader", { name: "参考单价" })).toBeNull();
    expect(screen.queryByTestId("bom-price-cell-0")).toBeNull();
    expect(screen.queryByTestId("bom-price-hint")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const items = putBody(calls).items as Array<Record<string, unknown>>;
    // 前端去掉尾零显示 7，服务端仍按 DECIMAL(18,4) 存 7.0000
    expect(items[0].reference_unit_price).toBe("7");
    expect(items[0].reference_currency).toBe("USD");
  });
});

// 2026-10-13（用户）：「建立BOM表的页面，生产和采购都是，在添加行，选择物料的时候，
// 要支持搜索功能，搜索物料清单里面的。」
//
// 改前物料那一格是 Radix `Select`（只能滚）：物料池是**全量**下发的（`GET /materials` 无分页），
// 几百条里找一个伞骨不现实。换成 `SearchableSelect` 之后钉四件事：
//   ① 「添加行」之后那一格能打开搜索框，并按关键字把候选收窄（不是只多一个框、却还在滚全量）；
//   ② 搜出来选中之后，值照旧进保存请求体（换下拉实现不能把值弄丢）；
//   ③ 生产侧的入口（不显示供应商与参考单价）用的是**同一个组件**，所以同样能搜；
//   ④ 搜不到时给出去哪儿维护物料池的指路，而不是一句"没有匹配项"。
describe("BOM 表：物料名称列支持搜索（2026-10-13）", () => {
  const pool = [
    { id: "m-1", materialCode: "M-001", name: "伞骨", materialType: "raw_material", isActive: true },
    { id: "m-2", materialCode: "M-002", name: "伞布", materialType: "raw_material", isActive: true },
    { id: "m-3", materialCode: "M-003", name: "手柄", materialType: "raw_material", isActive: true },
  ];
  const emptyBom = { id: "bom-1", orderNo: "SO-1", status: "draft", version: 1, updatedAt: OPENED_AT, items: [] };

  function renderWith(options: { showSupplier?: boolean; showReferencePrice?: boolean } = {}) {
    const calls = stubApi((url, call) => {
      if (url.endsWith("/boms/bom-1") && call.method === "GET") return apiOk(emptyBom);
      if (url.endsWith("/boms/bom-1/items") && call.method === "PUT") return apiOk(emptyBom);
      if (url.endsWith("/dictionaries/currency/items")) return apiOk([]);
      return apiOk({});
    });
    render(<BomWorkbench bomId="bom-1" title="SO-1" materials={pool} units={units} onClose={() => undefined} showSupplier={options.showSupplier} showReferencePrice={options.showReferencePrice} />);
    return calls;
  }

  it("点「添加行」后，那一格能按关键字把物料清单收窄到命中的那几条", async () => {
    renderWith();
    await userEvent.click(await screen.findByRole("button", { name: "添加行" }));

    await userEvent.click(await materialTrigger());
    // 展开态是**搜索框**，不是一个只能滚的长列表
    const search = await screen.findByTestId("searchable-select-search");
    await userEvent.type(search, "伞布");

    expect(await screen.findByText("M-002 / 伞布")).toBeVisible();
    // 不命中的那两条不再出现在候选里（草稿行默认选的伞骨也在其中）
    expect(screen.queryByText("M-001 / 伞骨")).toBeNull();
    expect(screen.queryByText("M-003 / 手柄")).toBeNull();
  });

  it("搜出来选中之后，保存请求体里是那条物料的 id 与名称（换下拉实现不能弄丢值）", async () => {
    const calls = renderWith();
    await userEvent.click(await screen.findByRole("button", { name: "添加行" }));
    await userEvent.click(await materialTrigger());
    await userEvent.type(await screen.findByTestId("searchable-select-search"), "M-003");
    await userEvent.click(await screen.findByText("M-003 / 手柄"));

    await userEvent.click(screen.getByRole("button", { name: "保存BOM表" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const items = bodyOf(calls.find((call) => call.method === "PUT")!).items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ material_id: "m-3", material_name: "手柄" });
  });

  it("生产侧入口（不显示供应商与参考单价）是同一个组件：一样能搜", async () => {
    renderWith({ showSupplier: false, showReferencePrice: false });
    await userEvent.click(await screen.findByRole("button", { name: "添加行" }));

    await userEvent.click(await materialTrigger());
    await userEvent.type(await screen.findByTestId("searchable-select-search"), "手柄");

    expect(await screen.findByText("M-003 / 手柄")).toBeVisible();
  });

  it("搜不到时指路到物料清单，而不是只写一句「无匹配项」", async () => {
    renderWith();
    await userEvent.click(await screen.findByRole("button", { name: "添加行" }));
    await userEvent.click(await materialTrigger());
    await userEvent.type(await screen.findByTestId("searchable-select-search"), "找不到的物料");

    expect(await screen.findByText(/到【采购 → 物料清单】维护物料池/)).toBeVisible();
  });
});
