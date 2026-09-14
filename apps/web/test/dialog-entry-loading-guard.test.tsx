// 修复护栏：基础资料加载完成前，不得打开"选项来自异步数据"的对话框。
//
// 缺陷（docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md §7.3）：
//   openCreate() 会把**当时**的 units 快照进 dialog.fields；数据到达后 dialog.fields 不会重建，
//   于是「默认单位」下拉**永久为空**且无法恢复（用户手速快一点就会遇到）。
// 修法：入口按钮在 loading 期间 disabled（master-data-pool-page 与 app/production 两处）。
//
// 注意：procurement / sales / warehouse 等页面**不受影响** —— 它们在 loading 时提前 return
// `<PageHeader/><LoadingState/>`，操作按钮根本不存在。这里只护栏真正受影响的两个入口。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MasterDataPoolPage } from "../components/production/master-data-pool-page";
import { apiOk, stubApi } from "./helpers/api-stub";

const operations = [{ id: "op-1", isActive: true, operationName: "缝制" }];
const units = [{ id: "unit-1", isActive: true, name: "件" }];

/** 一个可控的 deferred，用来把页面稳定停在 loading 状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("主数据对话框入口的加载门禁", () => {
  it("加载未完成时「新建工序」按钮禁用，加载完成后启用", async () => {
    const gate = deferred<Response>();
    stubApi((url) => {
      if (url.includes("/production/operations")) return gate.promise;
      if (url.endsWith("/units")) return apiOk(units);
      return apiOk([]);
    });

    render(<MasterDataPoolPage kind="operations" />);

    // 加载中：入口必须不可点，否则会把空的单位列表快照进对话框
    const trigger = screen.getByTestId("master-data-create-operation");
    expect(trigger).toBeDisabled();

    gate.resolve(apiOk(operations));

    // 加载完成：入口恢复可点，并且此时单位已经就绪
    await waitFor(() => expect(screen.getByTestId("master-data-create-operation")).toBeEnabled());
  });

  it("加载完成后打开对话框，默认单位下拉带有已加载的单位", async () => {
    stubApi((url) => {
      if (url.includes("/production/operations")) return apiOk(operations);
      if (url.endsWith("/units")) return apiOk(units);
      return apiOk([]);
    });

    render(<MasterDataPoolPage kind="operations" />);
    await waitFor(() => expect(screen.getByTestId("master-data-create-operation")).toBeEnabled());

    await userEvent.click(screen.getByTestId("master-data-create-operation"));
    expect(await screen.findByTestId("action-dialog")).toBeVisible();

    // 打开下拉后必须能看到已加载的单位 —— 这正是修复前会永久为空的场景
    await userEvent.click(screen.getByTestId("action-field-default_unit_id"));
    expect(await screen.findByRole("option", { name: "件" })).toBeVisible();
  });

  it("加工地点入口同样受加载门禁保护", async () => {
    const gate = deferred<Response>();
    stubApi((url) => {
      if (url.includes("/production/locations")) return gate.promise;
      return apiOk([]);
    });

    render(<MasterDataPoolPage kind="locations" />);
    expect(screen.getByTestId("master-data-create-location")).toBeDisabled();

    gate.resolve(apiOk([]));
    await waitFor(() => expect(screen.getByTestId("master-data-create-location")).toBeEnabled());
  });
});
