// 仓库 → 原料仓储情况页的行为测试。
//
// 覆盖两件客户明确要求的事：
//   1. 「规格型号」列必须出现在库存汇总表（同名不同规格的原料是常态，只给名称无法确认是哪一种）；
//   2. 模糊搜索：按空格分词、所有词都要命中，同时过滤「库存汇总」与「原料入库单」两张表。
//
// 搜索是纯本地过滤（不重新请求），因此这里同时断言 fetch 调用次数不变——
// 否则「输入一个字符打一次接口」这种回归不会被发现。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RawMaterialStoragePage from "../app/warehouse/raw-material-storage/page";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.current }));

const EP = {
  materials: "/api/v1/materials",
  units: "/api/v1/units",
  inspections: "/api/v1/incoming-inspections",
  inbounds: "/api/v1/raw-material-inbounds",
  balances: "/api/v1/inventory/raw-material-balances",
} as const;

const materialA = { id: "m-1", materialCode: "M-001", name: "涤纶布", defaultUnitId: "u-1", specificationModel: "150D", color: "本白" };
const materialB = { id: "m-2", materialCode: "M-002", name: "松紧带", defaultUnitId: "u-2", specificationModel: "5mm", color: "黑", };
const materials = [materialA, materialB];
const units = [{ id: "u-1", name: "米" }, { id: "u-2", name: "条" }];
const inboundA = { id: "ib-1", inboundNo: "IN-001", materialId: "m-1", unitId: "u-1", orderNo: "SO-1", quantity: "10.0000", status: "draft", purchase_order_no: "PO-1", receipt_no: "GR-1", batch_sequence: 1, inspection_status: "accepted", remark: "上午到货" };
const inboundB = { id: "ib-2", inboundNo: "IN-002", materialId: "m-2", unitId: "u-2", orderNo: "SO-2", quantity: "200.0000", status: "posted", purchase_order_no: "PO-2", receipt_no: "GR-2", batch_sequence: 2, inspection_status: "accepted", remark: null };
/**
 * 双击详情用的两张入库单：列表接口本来就把这些字段一起带回来了
 * （物料/单位/供应商/质检单、`inventoryFacts` / `payableSources` / 结算金额 / 批次 / 审计姓名）。
 * 草稿单没有下游事实，过账单才有 —— 与线上一致。
 */
const detailInboundA = {
  ...inboundA,
  incomingInspectionId: "insp-1",
  inventoryCategory: "raw_material",
  material_code: "M-001",
  material_name: "涤纶布",
  material_specification: "150D",
  material_color: "本白",
  unit_name: "米",
  supplier_name: "苏州织造一厂",
  inspection_no: "QCS-1",
  inspected_quantity: "9.0000",
  settlementUnitPrice: "12.5000",
  settlementTotalAmount: "125.0000",
  payableSources: [],
  inventoryFacts: [],
  created_by_name: "张三",
  updated_by_name: "李四",
  createdAt: "2026-11-04T06:00:00.000Z",
  updatedAt: "2026-11-04T06:10:00.000Z",
};
const detailInboundB = {
  ...inboundB,
  incomingInspectionId: "insp-2",
  inventoryCategory: "raw_material",
  material_code: "M-002",
  material_name: "松紧带",
  material_specification: "5mm",
  material_color: "黑",
  unit_name: "条",
  supplier_name: "苏州织造一厂",
  inspection_no: "QCS-2",
  inspected_quantity: "200.0000",
  payableSources: [{ id: "ps-2", status: "received", amount: "2500.0000", currency: "CNY", supplierPayableEntry: { id: "pe-2", payableNo: "AP-2026-0001", status: "draft" } }],
  inventoryFacts: [{ id: "if-2", quantityDelta: "200.0000", sourceType: "raw_material_inbound", createdAt: "2026-11-04T08:30:00.000Z" }],
  created_by_name: "张三",
  updated_by_name: "李四",
  createdAt: "2026-11-04T08:00:00.000Z",
  updatedAt: "2026-11-04T08:30:00.000Z",
};
const inspectionA = { id: "insp-1", orderNo: "QCS-1", inspectedQuantity: "9.0000", status: "accepted" };
const inspectionB = { id: "insp-2", orderNo: "QCS-2", inspectedQuantity: "200.0000", status: "accepted" };
const balances = [{ id: "b-1", material_id: "m-1", unit_id: "u-1", unit_name: "米", order_no: null, quantity: "120.0000" }];

function stub(data: { materials?: unknown; units?: unknown; inspections?: unknown; inbounds?: unknown; balances?: unknown } = {}) {
  return stubApi((url) => {
    if (url.startsWith(EP.balances)) return apiOk(data.balances ?? balances);
    if (url.startsWith(EP.materials)) return apiOk(data.materials ?? materials);
    if (url.startsWith(EP.units)) return apiOk(data.units ?? units);
    if (url.startsWith(EP.inspections)) return apiOk(data.inspections ?? []);
    if (url.startsWith(EP.inbounds)) return apiOk(data.inbounds ?? [inboundA, inboundB]);
    return apiOk([]);
  });
}

async function open() {
  render(<RawMaterialStoragePage />);
  await screen.findByTestId("page-warehouse-raw-material-storage");
}

function panel(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

const search = (value: string) => fireEvent.change(screen.getByTestId("raw-material-search"), { target: { value } });

describe("原料仓储情况：规格型号列", () => {
  it("库存汇总表有「规格型号」列，并显示物料主数据的规格型号", async () => {
    stub();
    await open();
    const table = panel("库存汇总");
    expect(table.getByRole("columnheader", { name: "规格型号" })).toBeInTheDocument();
    // 物料列是「编码 / 名称」一格；规格型号是独立的一格
    expect(table.getByText("M-001 / 涤纶布")).toBeInTheDocument();
    expect(table.getByText("150D")).toBeInTheDocument();
    expect(table.getByText("M-002 / 松紧带")).toBeInTheDocument();
    expect(table.getByText("5mm")).toBeInTheDocument();
  });

  it("没有库存记录的物料也会补 0 行并带出规格型号", async () => {
    stub();
    await open();
    const table = panel("库存汇总");
    // m-2 没有余额记录，由 mergeMaterialBalances 补 0 行（待入库 0 / 已过账库存 0 / 合计 0）；
    // m-1 有 1 张草稿入库单 10 与已过账库存 120.0000，因此待入库 10、合计 130。
    const rows = table.getAllByTestId("data-table-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "M-001 / 涤纶布150D米10120.0000130",
      "M-002 / 松紧带5mm条000",
    ]);
  });
});

describe("原料仓储情况：模糊搜索", () => {
  it("按规格型号过滤库存汇总（同时按物料编码 / 名称 / 颜色 / 单位匹配）", async () => {
    stub();
    await open();
    for (const query of ["150D", "涤纶", "M-001", "本白", "米"]) {
      search(query);
      const rows = panel("库存汇总").getAllByTestId("data-table-row");
      expect(rows, `查询 ${query} 应只剩涤纶布一行`).toHaveLength(1);
      expect(within(rows[0]).getByText("150D")).toBeInTheDocument();
      expect(panel("库存汇总").getByText("筛选后 1 / 2 条")).toBeInTheDocument();
    }
  });

  it("多词是 AND 语义：'涤纶 150D' 命中，'涤纶 5mm' 落空", async () => {
    stub();
    await open();
    search("涤纶 150D");
    expect(panel("库存汇总").getAllByTestId("data-table-row")).toHaveLength(1);
    search("涤纶 5mm");
    expect(panel("库存汇总").getByText("没有匹配的原料库存")).toBeInTheDocument();
  });

  it("同时过滤原料入库单：按单号，也按该入库单物料的名称/规格", async () => {
    stub();
    await open();
    search("IN-002");
    expect(panel("原料入库单").getAllByTestId("data-table-row")).toHaveLength(1);
    expect(panel("原料入库单").getByText("IN-002")).toBeInTheDocument();

    // 入库单本身不带物料名，靠 materialId 映射补齐后才能按「松紧带 / 5mm」命中
    search("5mm");
    expect(panel("原料入库单").getAllByTestId("data-table-row")).toHaveLength(1);
    expect(panel("原料入库单").getByText("IN-002")).toBeInTheDocument();
    expect(panel("原料入库单").getByText("筛选后 1 / 2 条")).toBeInTheDocument();
  });

  it("搜索「上午到货」按备注命中入库单", async () => {
    stub();
    await open();
    search("上午到货");
    const rows = panel("原料入库单").getAllByTestId("data-table-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("IN-001")).toBeInTheDocument();
  });

  it("搜索是纯本地过滤：输入过程中不再发请求", async () => {
    const calls = stub();
    await open();
    const before = calls.length;
    search("150D");
    search("松紧");
    search("IN-001");
    expect(calls).toHaveLength(before);
  });

  it("「清除搜索」恢复全部行，两张表一起回来", async () => {
    stub();
    await open();
    search("150D");
    expect(panel("库存汇总").getAllByTestId("data-table-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    await waitFor(() => expect(panel("库存汇总").getAllByTestId("data-table-row")).toHaveLength(2));
    expect(panel("原料入库单").getAllByTestId("data-table-row")).toHaveLength(2);
    expect((screen.getByTestId("raw-material-search") as HTMLInputElement).value).toBe("");
  });

  it("筛空时入库单也回落到「没有匹配的原料入库单」，而不是「暂无原料入库单」", async () => {
    stub();
    await open();
    search("不存在的关键词");
    expect(panel("库存汇总").getByText("没有匹配的原料库存")).toBeInTheDocument();
    expect(panel("原料入库单").getByText("没有匹配的原料入库单")).toBeInTheDocument();
    expect(screen.queryByText("暂无原料入库单")).toBeNull();
  });

  it("没有搜索词时仍显示原本的「暂无」空态", async () => {
    stub({ inbounds: [] });
    await open();
    expect(panel("原料入库单").getByText("暂无原料入库单")).toBeInTheDocument();
  });
});

/**
 * 2026-10-16 排查：「原料入库单过账了（入库成功），但库存汇总里看不到那个物料」。
 *
 * 这一页的库存汇总数据来自 `GET /api/v1/inventory/raw-material-balances`。生产机上它要穿过 nginx
 * （`.deploy-run-118/nginx-dilee.conf` 的 `location /api/`），而那份 nginx 配置**没有**放宽请求行：
 * 默认 `large_client_header_buffers 4 8k`，**一条请求行最多 8192 字节**，超了直接回 414，
 * 请求根本到不了 API。而这一页原来把**全部物料 id** 拼进了查询串（每个 UUID 37 字节）——
 * 物料一多（≈220 个以上）URL 就过线，库存汇总整表空白，但下面那张原料入库单照样显示「入库成功」。
 *
 * 这两条就是钉这个口径：① 请求行不许过线；② 取数失败不许冒充「没有库存」。
 */
const NGINX_REQUEST_LINE_LIMIT = 8192;
/** nginx 的请求行 = 方法 + 空格 + URL + 空格 + HTTP 版本。 */
const requestLineLength = (url: string) => "GET ".length + url.length + " HTTP/1.1".length;

describe("原料仓储情况：库存汇总的取数不能被代理打回", () => {
  // ⚠️ id 必须是 **UUID 形状**（36 字符）才复现得出来：线上物料 id 是 UUID，
  // 用 `m-1` 这样的短桩算出来的 URL 只有实际的三分之一，测试会假绿。
  const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const manyMaterials = Array.from({ length: 300 }, (_, index) => ({ id: uuid(index), materialCode: `M-${index}`, name: `物料${index}`, defaultUnitId: "u-1", specificationModel: "-", color: null }));

  it("物料有 300 个时，每一条请求的请求行都在 nginx 的 8k 之内", async () => {
    const calls = stub({ materials: manyMaterials });
    await open();
    const longest = calls.map((call) => requestLineLength(call.url)).sort((a, b) => b - a)[0] ?? 0;
    expect(longest, `最长请求行 ${longest} 字节（nginx 上限 ${NGINX_REQUEST_LINE_LIMIT}）`).toBeLessThanOrEqual(NGINX_REQUEST_LINE_LIMIT);
  });

  it("物料有 300 个时，库存汇总仍然收下全部物料（每个物料都有行）", async () => {
    stub({ materials: manyMaterials });
    await open();
    // 表格本身分页（DataTable 每页 20 行），所以看「收下了几条」这个数，而不是当前页的行数。
    expect(screen.getByText(/当前原料汇总条目：300/)).toBeInTheDocument();
  });

  it("库存取数失败时，库存汇总要说清是「没取到」，不能显示「暂无原料库存」", async () => {
    stubApi((url) => {
      // nginx 414：URL 过长的真实表现（本机无法复现代理，这里按它的等价结果打桩）
      if (url.startsWith(EP.balances)) return apiErr(414, "REQUEST_ERROR", "请求失败（HTTP 414）");
      if (url.startsWith(EP.materials)) return apiOk(materials);
      if (url.startsWith(EP.units)) return apiOk(units);
      if (url.startsWith(EP.inspections)) return apiOk([]);
      if (url.startsWith(EP.inbounds)) return apiOk([inboundB]);
      return apiOk([]);
    });
    render(<RawMaterialStoragePage />);
    await screen.findByTestId("page-warehouse-raw-material-storage");

    // 入库单那张表照旧可用（过账后的行仍然看得到）
    expect(panel("原料入库单").getByText("IN-002")).toBeInTheDocument();
    // 库存那张说清原因，而不是假装「没有库存」
    expect(panel("库存汇总").getByText(/请求失败（HTTP 414）/)).toBeInTheDocument();
    expect(panel("库存汇总").queryByText("暂无原料库存")).toBeNull();
  });
});

describe("原料仓储情况：既有动作不受搜索影响", () => {
  it("草稿入库单仍可过账，且请求打到正确的端点", async () => {
    const calls: StubbedCall[] = stub();
    await open();
    search("IN-001");
    fireEvent.click(panel("原料入库单").getByRole("button", { name: "过账" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/raw-material-inbounds/ib-1/post"))).toHaveLength(1));
  });

  it("搜索框不改变「当前原料汇总条目」的总数，只额外给出筛选后条数", async () => {
    stub();
    await open();
    search("150D");
    expect(screen.getByText("当前原料汇总条目：2（筛选后 1）")).toBeInTheDocument();
  });
});

/**
 * 2026-11-04 用户要求：「原料入库单模块，双击单据条目也要支持查看详情。居中悬浮窗口，复用就行」。
 *
 * 这里钉三件事：
 *   ① 双击入库单行弹出**居中**详情（复用全站那一个 `RecordDetailDialog`，testId 与别处同款命名）；
 *   ② 详情补上列表十列里**看不到**的字段：结算单价 / 结算总价 / 质检数量 / 备注 / 创建人 / 最后修改人；
 *   ③ 两张下游事实表：应付来源（这张单进了多少应付、财务接收没有）与库存流水（库存到底加了多少）。
 *
 * 数据来源是列表行本身（`GET /raw-material-inbounds` 已 include 下游事实），不打 `:id` 接口 ——
 * 因此这里也断言「双击不开新请求」，防止以后有人顺手加一个详情请求又把列表/详情做成两份口径。
 */
describe("原料仓储情况：双击原料入库单查看详情", () => {
  const lines = { inspections: [inspectionA, inspectionB], inbounds: [detailInboundA, detailInboundB] };

  async function openDetail(inboundNo: string) {
    stub(lines);
    await open();
    const rows = panel("原料入库单").getAllByTestId("data-table-row");
    const row = rows.find((candidate) => candidate.textContent?.includes(inboundNo));
    if (!row) throw new Error(`找不到入库单行：${inboundNo}`);
    fireEvent.doubleClick(row);
    return screen.getByTestId("raw-material-inbound-detail");
  }

  it("双击草稿入库单：弹窗补齐列表看不到的字段、结算金额与操作人", async () => {
    const calls = stub(lines);
    await open();
    const before = calls.length;
    fireEvent.doubleClick(panel("原料入库单").getAllByTestId("data-table-row")[0]);
    const dialog = screen.getByTestId("raw-material-inbound-detail");

    // 双击不重新请求：详情就是这一行（列表接口已带全字段）
    expect(calls).toHaveLength(before);

    expect(dialog).toHaveTextContent("原料入库单详情：IN-001");
    const fields = within(dialog).getByTestId("raw-material-inbound-detail-fields");
    for (const text of [
      "IN-001", "待入库登记", "accepted", "M-001 / 涤纶布", "150D", "本白", "米",
      "10.0000", "raw_material", "SO-1", "PO-1", "GR-1", "第 1 批", "苏州织造一厂",
      "QCS-1", "9.0000", "12.5000", "125.0000", "上午到货",
      "张三", "李四"
    ]) expect(fields, `详情字段缺少「${text}」`).toHaveTextContent(text);
  });

  it("过账入库单的详情里能看到应付来源与库存流水", async () => {
    const dialog = await openDetail("IN-002");
    expect(within(dialog).getByRole("heading", { name: "应付来源（1 条）" })).toBeInTheDocument();
    // 金额 + 币种、来源状态、已生成的应付单：三个都在同一行里
    expect(dialog).toHaveTextContent(/2500\.0000\sCNY/);
    expect(dialog).toHaveTextContent("已接收");
    expect(dialog).toHaveTextContent("AP-2026-0001（草稿）");
    expect(within(dialog).getByRole("heading", { name: "库存流水（1 条）" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("200.0000");
    expect(dialog).toHaveTextContent("原料入库过账");
  });

  it("草稿单详情里说清「还没过账所以没有应付来源」，不是一句空白", async () => {
    const dialog = await openDetail("IN-001");
    expect(within(dialog).getByRole("heading", { name: "应付来源（0 条）" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("草稿入库单还没过账");
  });

  it("详情里的动作与列表同一批回调：草稿给「过账」，点完弹窗关闭且请求打到 /post", async () => {
    const calls: StubbedCall[] = stub(lines);
    await open();
    fireEvent.doubleClick(panel("原料入库单").getAllByTestId("data-table-row")[0]);
    const dialog = screen.getByTestId("raw-material-inbound-detail");
    expect(within(dialog).queryByRole("button", { name: "冲销" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "过账" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/raw-material-inbounds/ib-1/post"))).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId("raw-material-inbound-detail")).toBeNull());
  });

  it("已过账单的详情给「冲销」而不是「过账」", async () => {
    const dialog = await openDetail("IN-002");
    expect(within(dialog).getByRole("button", { name: "冲销" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "过账" })).toBeNull();
  });
});
