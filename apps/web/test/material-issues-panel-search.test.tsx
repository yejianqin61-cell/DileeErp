// 生产领料面板（MaterialIssuesPanel）的**关键字搜索**行为测试。
//
// 用户 2026-11-13：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要
// 加上搜索功能。因为现在单子多了，查找比较麻烦。」—— 这里钉住的是那颗搜索框的真实行为：
//   1) 输入关键词 → 单据行按关键词收窄（单据号 / 类型 / 业务日期 / 状态都算命中）；
//   2) 没命中时不是空表格，而是「没有匹配“xx”」+ 总数，让人知道是关键词打偏了而不是单据没了；
//   3) 点「清除搜索」→ 恢复全部行、计数回到「共 N 张」。
//
// 纪律与同目录其它用例一致：只断言渲染结果与用户可见的文本，不断言 className、不读源码。
// 面板会真实请求 /production/material-movements 与 /boms/:id，因此每个用例都打桩后端。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiOk, stubApi } from "./helpers/api-stub";
import { MaterialIssuesPanel } from "../components/production/material-issues-panel";
import { Toaster } from "../components/ui/toaster";

const bomItems = [{ materialId: "m-1", materialName: "面料A", specificationModel: "150D", requiredQuantity: "5", unit: "米", unitId: "u-1" }];

type Movement = Record<string, unknown>;
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

/** 三张单据：两张领料单（草稿 / 已过账）+ 一张补料单，够区分「按单号」「按类型」「按状态」三种命中方式。 */
const movements = [
  movement({ id: "mv-1", movementNo: "MI-001" }),
  movement({ id: "mv-2", movementNo: "MI-002", status: "posted", businessDate: "2026-02-03" }),
  movement({ id: "mv-3", movementNo: "MC-001", documentType: "replenishment", businessDate: "2026-03-04" }),
];

function renderPanel() {
  stubApi((url) => {
    if (url.includes("/production/material-movements?")) return apiOk(movements);
    if (url.includes("/boms/")) return apiOk({ items: bomItems });
    return apiOk([]);
  });
  return render(
    <>
      <Toaster />
      <MaterialIssuesPanel productionOrderId="MO-1" bomId="bom-1" issuable onChanged={() => undefined} />
    </>
  );
}

const listRows = () => screen.queryAllByTestId("data-table-row");
const searchBox = () => screen.getByTestId("material-issues-panel-search");
const countNote = () => screen.getByTestId("material-issues-panel-count");

describe("MaterialIssuesPanel：单据列表的关键字搜索", () => {
  it("没有关键词时列出全部单据，计数是「共 N 张」（不显示筛选后的假象）", async () => {
    renderPanel();

    expect(await screen.findByText("MI-001")).toBeVisible();
    expect(listRows()).toHaveLength(3);
    expect(countNote()).toHaveTextContent("共 3 张");
  });

  it("按单据号收窄，并给出「筛选后 N / M 张」", async () => {
    renderPanel();
    await screen.findByText("MI-001");

    await userEvent.type(searchBox(), "MI-002");

    await waitFor(() => expect(listRows()).toHaveLength(1));
    expect(listRows()[0]).toHaveTextContent("MI-002");
    expect(countNote()).toHaveTextContent("筛选后 1 / 3 张");
  });

  it("类型与状态也参与匹配（搜「补料单」只剩补料单，搜「已过账」只剩已过账那张）", async () => {
    renderPanel();
    await screen.findByText("MI-001");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "补料单");
    await waitFor(() => expect(listRows()).toHaveLength(1));
    expect(listRows()[0]).toHaveTextContent("MC-001");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "已过账");
    await waitFor(() => expect(listRows()).toHaveLength(1));
    expect(listRows()[0]).toHaveTextContent("MI-002");
  });

  it("一个词都命中不到时给出「没有匹配」而不是空表格，并说明本单共有多少张", async () => {
    renderPanel();
    await screen.findByText("MI-001");

    await userEvent.type(searchBox(), "不存在的单号");

    expect(await screen.findByTestId("empty-state")).toHaveTextContent("没有匹配“不存在的单号”的单据");
    // 空态里要带上总数：否则用户以为是这个生产单的单据被删了
    expect(screen.getByTestId("empty-state")).toHaveTextContent("该生产单共 3 张单据");
    expect(listRows()).toHaveLength(0);
    expect(countNote()).toHaveTextContent("筛选后 0 / 3 张");
  });

  it("「清除搜索」把关键词清空并恢复全部行与计数", async () => {
    renderPanel();
    await screen.findByText("MI-001");
    await userEvent.type(searchBox(), "MI-002");
    await waitFor(() => expect(listRows()).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    await waitFor(() => expect(listRows()).toHaveLength(3));
    expect(searchBox()).toHaveValue("");
    expect(countNote()).toHaveTextContent("共 3 张");
    // 清除后「清除搜索」按钮自己也消失（没有关键词时它没有意义）
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  });

  it("搜索是纯显示过滤：过滤期间不会重新拉取单据（取数口径不变）", async () => {
    const calls: string[] = [];
    stubApi((url) => {
      calls.push(url);
      if (url.includes("/production/material-movements?")) return apiOk(movements);
      if (url.includes("/boms/")) return apiOk({ items: bomItems });
      return apiOk([]);
    });
    render(
      <>
        <Toaster />
        <MaterialIssuesPanel productionOrderId="MO-1" bomId="bom-1" issuable onChanged={() => undefined} />
      </>
    );
    await screen.findByText("MI-001");
    const before = calls.filter((url) => url.includes("/production/material-movements?")).length;

    await userEvent.type(searchBox(), "MI-002");
    await waitFor(() => expect(listRows()).toHaveLength(1));

    expect(calls.filter((url) => url.includes("/production/material-movements?")).length).toBe(before);
  });
});
