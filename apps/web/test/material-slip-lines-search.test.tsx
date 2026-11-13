// 领料单 / 补料单明细表（MaterialSlipLinesTable）的**关键字搜索**行为测试。
//
// 用户 2026-11-13：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上
// 搜索功能。因为现在单子多了，查找比较麻烦。」这张表出现在领料单详情弹窗里，一张单领十几种料时，
// 核对「这批到底领没领伞骨」同样是肉眼在一串名字里找。
//
// 这里钉住三件事：
//   1) 输入关键词 → 明细行收窄；两张版式（领料单 / 补料单）都能搜；
//   2) 没命中 → 「没有匹配」空态 + 本单总行数，而不是空表格；
//   3) 清除 → 恢复全部行。
// 另外钉住一条**不能错位**的约束：行号来自数据里的 `sequence`（打印件的序号），过滤不会让它重新编号。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MaterialSlipLinesTable, type SlipDocument } from "../components/production/material-slip-lines-table";

const issueSlip: SlipDocument = {
  document_type: "issue",
  document: {
    lines: [
      { sequence: 1, materialName: "面料A", materialCode: "RM-1", specificationModel: "150D", color: "米白", unit: "米", bomQuantity: 10, issuedQuantity: 2, currentQuantity: 3, remainingQuantity: 5, remark: null },
      { sequence: 2, materialName: "拉链B", materialCode: "RM-2", specificationModel: "3号", color: "藏青", unit: "条", bomQuantity: 10, issuedQuantity: 8, currentQuantity: 8, remainingQuantity: -6, remark: "备损" },
      { sequence: 3, materialName: "伞骨C", materialCode: "RM-3", specificationModel: "8K", color: "黑", unit: "根", bomQuantity: 8, issuedQuantity: 0, currentQuantity: 8, remainingQuantity: 0, remark: null },
    ],
  },
};

const replenishmentSlip: SlipDocument = {
  document_type: "replenishment",
  document: {
    lines: [
      { sequence: 1, materialName: "面料A", materialCode: "RM-1", specificationModel: "150D", color: "米白", unit: "米", replenishQuantity: 2 },
      { sequence: 2, materialName: "伞骨C", materialCode: "RM-3", specificationModel: "8K", color: "黑", unit: "根", replenishQuantity: 4 },
    ],
  },
};

const lines = () => screen.queryAllByTestId("data-table-row");
const searchBox = () => screen.getByTestId("material-slip-lines-search");

describe("MaterialSlipLinesTable：明细行的关键字搜索", () => {
  it("没有关键词时列出全部明细，且不显示「筛选后」计数与清除按钮", () => {
    render(<MaterialSlipLinesTable slip={issueSlip} />);

    expect(lines()).toHaveLength(3);
    expect(screen.queryByTestId("material-slip-lines-count")).toBeNull();
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  });

  it("按物料名称收窄（搜「伞骨」只剩一行），并给出「筛选后 N / M 行」", async () => {
    render(<MaterialSlipLinesTable slip={issueSlip} />);

    await userEvent.type(searchBox(), "伞骨");

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("伞骨C");
    expect(screen.getByTestId("material-slip-lines-count")).toHaveTextContent("筛选后 1 / 3 行");
  });

  it("编码、规格型号、颜色与备注也参与匹配（搜「RM-2」「8K」「米白」「备损」都能命中）", async () => {
    render(<MaterialSlipLinesTable slip={issueSlip} />);

    await userEvent.type(searchBox(), "RM-2");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("拉链B");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "8K");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("伞骨C");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "米白");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("面料A");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "备损");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("拉链B");
  });

  it("空格分词按 AND 收窄：「面料 150D」命中一个物料，而「面料 8K」什么都命中不到", async () => {
    render(<MaterialSlipLinesTable slip={issueSlip} />);

    await userEvent.type(searchBox(), "面料 150D");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("面料A");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "面料 8K");
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("没有匹配“面料 8K”的物料行");
  });

  it("没命中时不是空表格：给出「没有匹配」与「本单共 N 行明细」", async () => {
    render(<MaterialSlipLinesTable slip={issueSlip} />);

    await userEvent.type(searchBox(), "不存在的物料");

    expect(await screen.findByTestId("empty-state")).toHaveTextContent("没有匹配“不存在的物料”的物料行");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("本单共 3 行明细");
    expect(lines()).toHaveLength(0);
  });

  it("「清除搜索」恢复全部明细，空态文案回到「该单据没有物料明细」的原始口径", async () => {
    render(<MaterialSlipLinesTable slip={issueSlip} />);
    await userEvent.type(searchBox(), "伞骨");
    await waitFor(() => expect(lines()).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    await waitFor(() => expect(lines()).toHaveLength(3));
    expect(searchBox()).toHaveValue("");
  });

  it("明细本来就是空的时候：不显示「没有匹配」，只说该单据没有物料明细", () => {
    render(<MaterialSlipLinesTable slip={{ document_type: "issue", document: { lines: [] } }} />);

    expect(screen.getByTestId("empty-state")).toHaveTextContent("该单据没有物料明细");
  });

  it("补料单版式（补领数量）同样能搜，且列名仍是补料单那一套", async () => {
    render(<MaterialSlipLinesTable slip={replenishmentSlip} />);
    expect(screen.getByRole("columnheader", { name: "补领数量" })).toBeVisible();
    expect(lines()).toHaveLength(2);

    await userEvent.type(searchBox(), "伞骨");

    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("伞骨C");
    expect(screen.getByRole("columnheader", { name: "补领数量" })).toBeVisible();
  });

  it("过滤只改显示：命中的是数据里的那一整行，字段不会与别的行串位", async () => {
    // 明细表的每一格都是后端组装好的同一行数据（配料 / 已领 / 本次 / 余下四个数量同源），
    // 过滤只能整行搬：一旦「按关键词挑了格」，伞骨那一行就会带上拉链的「-6」或「备损」备注。
    render(<MaterialSlipLinesTable slip={issueSlip} />);

    await userEvent.type(searchBox(), "伞骨");

    await waitFor(() => expect(lines()).toHaveLength(1));
    const [row] = lines();
    expect(row).toHaveTextContent("伞骨C");
    expect(row).toHaveTextContent("8K");
    expect(row).toHaveTextContent("黑");
    // 拉链B 独有的东西（超领 -6 与备注「备损」）绝不能跟着串到伞骨这一行上
    expect(row).not.toHaveTextContent("-6");
    expect(row).not.toHaveTextContent("备损");
  });
});
