// 物料清单页（采购 → 物料清单，app/procurement/materials/page.tsx）的**列宽 / 超长省略 / hover 看全文**
// 行为测试。
//
// 用户 2026-10-08：「物料清单太宽了，表格所有列宽限定长度，超过就省略显示，鼠标hover才显示所有文字。
// 尽量保证所有column一次性展示。」
//
// jsdom 不排版，所以「一屏放得下」「省略号真的出现」由真实 Chromium 量（数字见 globals.css 的注释与
// docs/design/materials-table-column-widths-2026-10-08.md）。这里钉住的是**排版依赖的那些契约**：
//   1. 十列都有显式宽度、总和 100%（这是「表宽 = 容器宽、不再横向滚动」的充分条件）；
//   2. 文本格带 `cell-ellipsis` 且 `title` 是这一格的全文（悬停看到的那串字必须与显示的一致）；
//   3. 「图片 / 操作」两个控件格**不**带省略 —— 它们的按钮要靠换行而不是 nowrap 裁切；
//   4. 表上挂着让这些 CSS 生效的类（`data-table-fixed` + `materials-page-table`）；
//   5. 批量导入结果的两张小表同样固定列宽（整句中文提示原本能把小表顶出面板）。
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

import MaterialsPage from "../app/procurement/materials/page";

const EP = { materials: "/api/v1/materials", units: "/api/v1/units", imp: "/api/v1/materials/import" } as const;

const LONG_NAME = "加厚双面哑光涤纶织带（红蓝撞色定制款）烫金logo工艺";
const LONG_SPEC = "3cm × 91m 双面哑光 / 耐洗 60 次不掉色";
const LONG_COLOR = "深藏青蓝拼米白";
const IMAGE = { id: "img-1", width: 1600, height: 1200, byteSize: 2048, sha256: "sha-abc", updatedAt: "2026-10-08T02:00:00.000Z" };

/** 两个物料：一个短文本 + 有图，一个长文本 + 停用（短长两种内容下行宽必须一模一样）。 */
const rows = [
  { id: "m-1", materialCode: "MAT-20261008-0001", name: "涤纶布", specificationModel: "150D", color: "米白", defaultUnitId: "u-1", materialType: "raw_material", isActive: true, image: IMAGE, created_by_name: "张三", createdAt: "2026-10-08T00:30:00.000Z", updated_by_name: "李四", updatedAt: "2026-10-08T06:05:00.000Z" },
  { id: "m-2", materialCode: "MAT-20261008-0002", name: LONG_NAME, specificationModel: LONG_SPEC, color: LONG_COLOR, defaultUnitId: "u-2", materialType: "raw_material", isActive: false, image: null, created_by_name: "王五", createdAt: "2026-10-08T01:00:00.000Z", updated_by_name: "赵六", updatedAt: "2026-10-08T07:00:00.000Z" },
];

const units = [{ id: "u-1", name: "米", isActive: true }, { id: "u-2", name: "平方米", isActive: true }];

const importResult = {
  status: "partial", total: 2, imported: 1, errorCount: 1, headerRow: 1,
  errors: [{ row: 4, field: "默认单位", reason: "默认单位「包」在单位表里找不到：请先在【采购 → 物料清单 → 新建物料】的「默认单位」旁点「新增类目」建出这个单位，再重新上传整份清单（已导入的行不会重复导入）" }],
  missingColumns: [], ignoredColumns: [], ignoredTrailingRows: 0, hints: [],
  created: [{ row: 2, material_code: "MAT-20261008-0009", name: LONG_NAME, auto_code: true }],
};

const HEADERS = ["物料编码", "物料名称", "规格型号", "颜色", "默认单位", "图片", "状态", "创建人", "最后修改人", "操作"];
/** 带省略号 + title 的五个文本列（顺序与 HEADERS 一致）。 */
const TEXT_COLUMNS = [0, 1, 2, 3, 4];

function stub() {
  return stubApi((url: string, call: StubbedCall) => {
    if (call.method === "GET" && url.endsWith(EP.materials)) return apiOk(rows);
    if (call.method === "GET" && url.endsWith(EP.units)) return apiOk(units);
    if (call.method === "POST" && url.endsWith(EP.imp)) return apiOk(importResult);
    return apiOk([]);
  });
}

/** 主表：表头第一格是「物料编码」的那张（导入结果没渲染时页面上只有它一张）。 */
async function open() {
  render(<MaterialsPage />);
  await screen.findByTestId("page-procurement-materials");
  await screen.findByTestId("material-image-pick-m-1");
  const table = Array.from(document.querySelectorAll("table")).find((candidate) => candidate.querySelector("thead th")?.textContent === "物料编码");
  if (!table) throw new Error("没找到物料清单主表");
  return table;
}

const cellsOf = (table: HTMLTableElement, rowIndex: number) => Array.from(table.querySelectorAll("tbody tr")[rowIndex].querySelectorAll("td"));

describe("物料清单：列宽 / 省略 / hover 看全文", () => {
  it("十列都有显式宽度、总和 100%，并且表挂在固定布局上", async () => {
    stub();
    const table = await open();

    expect(table.classList.contains("data-table-fixed")).toBe(true);
    expect(table.classList.contains("materials-page-table")).toBe(true);
    const headers = Array.from(table.querySelectorAll("thead th")) as HTMLElement[];
    expect(headers.map((header) => header.textContent)).toEqual(HEADERS);
    const widths = headers.map((header) => header.style.width);
    expect(widths).toEqual(["12%", "14%", "11%", "7%", "7%", "15%", "5%", "8%", "8%", "13%"]);
    expect(widths.reduce((sum, width) => sum + Number.parseFloat(width), 0)).toBe(100);
  });

  it("每一格沿用本列的宽度（固定布局的前提：列宽只由列定义决定，与内容无关）", async () => {
    stub();
    const table = await open();
    const widths = (Array.from(table.querySelectorAll("thead th")) as HTMLElement[]).map((header) => header.style.width);

    // 长文本那一行与短文本那一行：内容完全不同，十列宽度逐列相同 ——
    // 这正是「物料名称一长，后面的 column 就被挤窄」的根治点。
    for (const rowIndex of [0, 1]) {
      const cells = cellsOf(table, rowIndex) as HTMLElement[];
      expect(cells.map((cell) => cell.style.width)).toEqual(widths);
    }
  });

  it("文本格：省略号 + title 就是这一格的全文", async () => {
    stub();
    const table = await open();
    const cells = cellsOf(table, 1) as HTMLElement[];

    // 顺序：物料编码 / 物料名称 / 规格型号 / 颜色 / 默认单位
    const expected = ["MAT-20261008-0002", LONG_NAME, LONG_SPEC, LONG_COLOR, "平方米"];
    expect(cells).toHaveLength(HEADERS.length);
    for (const index of TEXT_COLUMNS) {
      expect(cells[index].classList.contains("cell-ellipsis")).toBe(true);
      expect(cells[index].textContent).toBe(expected[index]);
      expect(cells[index].getAttribute("title")).toBe(expected[index]);
    }
  });

  it("图片 / 操作两格不许省略：按钮靠换行，靠 nowrap 裁切会让按钮直接消失", async () => {
    stub();
    const table = await open();
    const cells = cellsOf(table, 0) as HTMLElement[];

    expect(cells[5].classList.contains("cell-ellipsis")).toBe(false);
    expect(cells[5].getAttribute("title")).toBeNull();
    expect(within(cells[5]).getByTestId("material-image-pick-m-1")).toBeVisible();
    expect(cells[9].classList.contains("cell-ellipsis")).toBe(false);
    expect(within(cells[9]).getByRole("button", { name: "编辑" })).toBeVisible();
  });

  it("创建人 / 最后修改人：两段文字 + 完整 title（被裁掉的时间要能看到）", async () => {
    stub();
    const table = await open();
    const cells = cellsOf(table, 1) as HTMLElement[];

    for (const [index, actor] of [[7, "王五"], [8, "赵六"]] as Array<[number, string]>) {
      const cell = cells[index];
      const content = cell.querySelector(".audit-actor-cell");
      expect(cell.classList.contains("cell-ellipsis")).toBe(false);
      expect(content?.querySelector(".audit-actor-name")?.textContent).toBe(actor);
      expect(content?.querySelector(".audit-actor-time")).toBeTruthy();
      // 时间随当年/跨年两种格式变，所以只钉「姓名 + 空格 + 时间」
      expect(content?.getAttribute("title")).toMatch(new RegExp(`^${actor} \\S`));
    }
  });

  it("批量导入结果的两张小表：同样固定列宽（整句中文提示原本能把小表顶出面板）", async () => {
    stub();
    await open();

    await userEvent.upload(screen.getByTestId("material-import-file"), new File(["xlsx-bytes"], "物料清单.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const result = await screen.findByTestId("material-import-result");

    const tables = Array.from(result.querySelectorAll("table"));
    expect(tables).toHaveLength(2);
    const expected = [["12%", "18%", "70%"], ["14%", "30%", "18%", "38%"]];
    tables.forEach((candidate, index) => {
      expect(candidate.classList.contains("data-table-fixed")).toBe(true);
      expect(Array.from(candidate.querySelectorAll("thead th")).map((header) => (header as HTMLElement).style.width)).toEqual(expected[index]);
    });
    // 长句（原因 / 物料名称）要有省略号 + hover 全文
    const ellipsisTitles = Array.from(result.querySelectorAll("tbody td.cell-ellipsis")).map((cell) => cell.getAttribute("title"));
    expect(ellipsisTitles).toEqual(expect.arrayContaining([importResult.errors[0].reason, LONG_NAME]));
  });
});
