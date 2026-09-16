// 池子搜索的**行为**测试（用户 2026-09-16：「供应商池，要支持搜索」「所有池子，都要支持搜索」）。
//
// 覆盖本轮补上搜索框的三个池子：供应商池（/procurement/suppliers）、物料清单/物料池
// （/procurement/materials）、客户池（销售页 /sales，/customers 复用同一个页面）。
// 其余池子（工序池、加工地点池、单位池、部门池、岗位池、银行账户池）本来就有搜索框，
// 本轮只把它们统一到同一套匹配语义（多词 AND），语义本身由 lib/fuzzy-search.test.mjs 推演。
//
// 纪律：真实渲染页面 + 真实输入 + 断言渲染出的行，不 mock 模块、不读源码。
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SuppliersPage from "../app/procurement/suppliers/page";
import MaterialsPage from "../app/procurement/materials/page";
import SalesPage from "../app/sales/page";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  suppliers: "/api/v1/suppliers",
  materials: "/api/v1/materials",
  units: "/api/v1/units",
  customers: "/api/v1/customers?page_size=200",
  salesOrders: "/api/v1/sales-orders?page_size=200",
  currencies: "/api/v1/dictionaries/currency/items",
} as const;

/** 表格里的数据行；没有数据时 DataTable 会整块换成空态（连表头都没有），所以用 query。 */
const rowsOf = () => screen.queryAllByRole("row").slice(1);
const textsIn = (row: HTMLElement) => within(row).queryAllByRole("cell").map((cell) => cell.textContent ?? "").join(" | ");

// ------------------------------------------------------------------ 供应商池

const suppliers = [
  { id: "s-1", supplierCode: "S-001", name: "香港迪礼贸易", contactName: "陈小姐", phone: "13800000001", remark: "面料主供", isActive: true },
  { id: "s-2", supplierCode: "S-002", name: "宁波辅料厂", contactName: "王先生", phone: "13900000002", remark: null, isActive: true },
  { id: "s-3", supplierCode: "S-003", name: "已停用供应商", contactName: null, phone: null, remark: null, isActive: false },
];

async function openSuppliers() {
  stubApi((url) => (url === EP.suppliers ? apiOk(suppliers) : apiOk([])));
  render(<SuppliersPage />);
  await screen.findByTestId("page-procurement-suppliers");
  await screen.findByText("香港迪礼贸易");
}

describe("供应商池：搜索", () => {
  it("默认列出全部供应商，并在标题上给出启用/停用与当前条数", async () => {
    await openSuppliers();

    expect(rowsOf()).toHaveLength(3);
    expect(screen.getByTestId("supplier-count")).toHaveTextContent("共 3 个供应商（启用 2 个 / 停用 1 个），当前列出 3 条");
  });

  it("按名称 / 编码 / 联系人 / 电话都能搜到，搜索后只剩命中的行", async () => {
    await openSuppliers();
    const box = screen.getByTestId("supplier-search");

    for (const [keyword, hit] of [["宁波", "宁波辅料厂"], ["s-003", "已停用供应商"], ["王先生", "宁波辅料厂"], ["13800000001", "香港迪礼贸易"]]) {
      await userEvent.clear(box);
      await userEvent.type(box, keyword);
      expect(rowsOf()).toHaveLength(1);
      expect(screen.getByText(hit)).toBeVisible();
    }
  });

  it("多个词用空格分隔是 AND 语义：词可以分别落在不同字段上", async () => {
    await openSuppliers();
    const box = screen.getByTestId("supplier-search");

    // 「迪礼 陈小姐」= 名称里有「迪礼」且联系人里有「陈小姐」
    await userEvent.type(box, "迪礼 陈小姐");
    expect(rowsOf()).toHaveLength(1);
    expect(screen.getByText("香港迪礼贸易")).toBeVisible();

    // 加一个不存在的词就整体不命中（说明不是 OR）
    await userEvent.type(box, " 不存在");
    expect(rowsOf()).toHaveLength(0);
    expect(screen.getByText(/没有匹配/)).toBeVisible();
    expect(screen.getByTestId("supplier-count")).toHaveTextContent("当前列出 0 条");
  });

  it("搜不到时点名关键词并说明总数，清空后恢复全部", async () => {
    await openSuppliers();
    const box = screen.getByTestId("supplier-search");

    await userEvent.type(box, "不存在的供应商");
    expect(screen.getByText(/没有匹配“不存在的供应商”的供应商/)).toBeVisible();
    // 计数与空态说明里都写着「共 3 个供应商」，所以按 testid 取计数那一处
    expect(screen.getByTestId("supplier-count")).toHaveTextContent("共 3 个供应商");

    await userEvent.clear(box);
    expect(rowsOf()).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ 物料池（物料清单）

const materials = [
  { id: "m-1", materialCode: "M-001", name: "涤纶布", specificationModel: "150D", color: "本白", defaultUnitId: "u-1", materialType: "raw_material", isActive: true },
  { id: "m-2", materialCode: "M-002", name: "松紧带", specificationModel: null, color: null, defaultUnitId: "u-2", materialType: "raw_material", isActive: true },
  { id: "m-3", materialCode: "M-003", name: "成品连衣裙", specificationModel: "长款", color: "藏青", defaultUnitId: "u-2", materialType: "finished_product", isActive: false },
];
const units = [
  { id: "u-1", name: "米", isActive: true },
  { id: "u-2", name: "条", isActive: true },
];

async function openMaterials() {
  stubApi((url) => (url === EP.materials ? apiOk(materials) : url === EP.units ? apiOk(units) : apiOk([])));
  render(<MaterialsPage />);
  await screen.findByTestId("page-procurement-materials");
  await screen.findByText("涤纶布");
}

describe("物料池（物料清单）：搜索", () => {
  it("默认列出全部物料并给出计数", async () => {
    await openMaterials();

    expect(rowsOf()).toHaveLength(3);
    expect(screen.getByTestId("material-count")).toHaveTextContent("共 3 个物料（启用 2 个），当前列出 3 条");
  });

  it("编码 / 名称 / 规格型号 / 颜色 / 单位名 / 物料类型都能搜到", async () => {
    await openMaterials();
    const box = screen.getByTestId("material-search");

    // 注意「条」不在这里测：两个物料都用「条」做单位，命中的行数是 2 —— 单位名单独有一条用例。
    for (const [keyword, hit] of [["m-002", "松紧带"], ["涤纶", "涤纶布"], ["150d", "涤纶布"], ["藏青", "成品连衣裙"], ["成品", "成品连衣裙"]]) {
      await userEvent.clear(box);
      await userEvent.type(box, keyword);
      expect(rowsOf(), `关键词 ${keyword} 应命中 ${hit}`).toHaveLength(1);
      expect(screen.getByText(hit)).toBeVisible();
    }
  });

  it("多词 AND：名称 + 规格型号一起收窄", async () => {
    await openMaterials();
    const box = screen.getByTestId("material-search");

    await userEvent.type(box, "涤纶 150D");
    expect(rowsOf()).toHaveLength(1);
    expect(screen.getByText("涤纶布")).toBeVisible();

    await userEvent.clear(box);
    await userEvent.type(box, "涤纶 长款");
    expect(rowsOf()).toHaveLength(0);
    expect(screen.getByText(/没有匹配/)).toBeVisible();
  });

  it("搜索词命中「单位名」而不是 id（人搜的是米/条，不是 UUID）", async () => {
    await openMaterials();
    const box = screen.getByTestId("material-search");

    await userEvent.type(box, "米");
    expect(rowsOf()).toHaveLength(1);
    expect(textsIn(rowsOf()[0])).toContain("米");
  });
});

// ------------------------------------------------------------------ 客户池（销售页）

const customers = [
  { id: "c-1", customerCode: "C-001", name: "香港迪礼国际贸易有限公司", countryRegion: "中国香港", address: "九龙弥敦道 1 号", paymentTerms: "T/T 30 天", currency: "USD", remark: null, isActive: true, contacts: [{ id: "ct-1", name: "李经理", position: "采购", phone: "13700000001", email: "li@example.com", isDefault: true, isActive: true }] },
  { id: "c-2", customerCode: "C-002", name: "宁波服饰有限公司", countryRegion: "中国", address: "宁波市鄞州区", paymentTerms: null, currency: "CNY", remark: null, isActive: true, contacts: [] },
  { id: "c-3", customerCode: "C-003", name: "已停用客户", countryRegion: "美国", address: null, paymentTerms: null, currency: "USD", remark: null, isActive: false, contacts: [] },
];

async function openCustomers() {
  stubApi((url) => {
    if (url === EP.customers) return apiOk(customers);
    if (url === EP.salesOrders) return apiOk([]);
    if (url === EP.units) return apiOk(units);
    if (url === EP.currencies) return apiOk([{ key: "USD", label: "美元", sortOrder: 10 }]);
    return apiOk([]);
  });
  render(<SalesPage />);
  await screen.findByText("客户池");
  await screen.findByText("香港迪礼国际贸易有限公司");
}

describe("客户池：搜索", () => {
  it("默认列出全部客户并给出计数", async () => {
    await openCustomers();

    expect(screen.getByTestId("customer-count")).toHaveTextContent("共 3 个客户（启用 2 个），当前列出 3 条");
  });

  it("编码 / 名称 / 联系人 / 电话 / 国家地区都能搜到", async () => {
    await openCustomers();
    const box = screen.getByTestId("customer-search");

    for (const [keyword, hit] of [["c-002", "宁波服饰有限公司"], ["迪礼", "香港迪礼国际贸易有限公司"], ["李经理", "香港迪礼国际贸易有限公司"], ["13700000001", "香港迪礼国际贸易有限公司"], ["美国", "已停用客户"]]) {
      await userEvent.clear(box);
      await userEvent.type(box, keyword);
      expect(screen.getByText(hit), `关键词 ${keyword} 应命中 ${hit}`).toBeVisible();
    }
  });

  it("多词 AND 与空态：'迪礼 李经理' 命中，'迪礼 宁波' 不命中", async () => {
    await openCustomers();
    const box = screen.getByTestId("customer-search");

    await userEvent.type(box, "迪礼 李经理");
    expect(screen.getByText("香港迪礼国际贸易有限公司")).toBeVisible();
    expect(screen.queryByText("宁波服饰有限公司")).toBeNull();

    await userEvent.clear(box);
    await userEvent.type(box, "迪礼 宁波");
    expect(screen.queryByText("香港迪礼国际贸易有限公司")).toBeNull();
    expect(screen.getByText(/没有匹配/)).toBeVisible();
  });
});

// 三个页面的搜索框都必须存在（缺一个就红）——与 lib/pool-search-guard.test.mjs 的源码守卫互为补强：
// 那条保证「写了 fuzzyMatch」，这条保证「用户真的能用」。
describe("三个池子的搜索框都在 DOM 里", () => {
  it("供应商池 / 物料池 / 客户池", async () => {
    await openSuppliers();
    expect(screen.getByTestId("supplier-search")).toBeVisible();

    await openMaterials();
    expect(screen.getByTestId("material-search")).toBeVisible();

    await openCustomers();
    expect(screen.getByTestId("customer-search")).toBeVisible();
  });
});

// 兜底：本文件用到的桩分支都不该落到「未匹配」的空数组上（写错 URL 会静默变成空页面）。
describe("桩自检", () => {
  it("供应商桩只服务 /suppliers", async () => {
    const calls: StubbedCall[] = [];
    stubApi((url) => { calls.push({ url, method: "GET", body: null }); return url === EP.suppliers ? apiOk(suppliers) : apiOk([]); });
    render(<SuppliersPage />);
    await screen.findByTestId("page-procurement-suppliers");
    expect(calls.map((call) => call.url)).toEqual([EP.suppliers]);
  });
});
