// 「审计」弹窗里的凭证上传（原仓库页审计侧栏的「上传凭证」，b1798d1 时丢失）。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MaterialIssuesPage from "../app/production/material-issues/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const movement = (over: Record<string, unknown> = {}) => ({
  id: "mi-1", movementNo: "MI-001", documentType: "issue", status: "posted", orderNo: "SO-001",
  productionOrderId: "po-1", productionOrder: { productionOrderNo: "MO-001", orderNo: "SO-001" },
  businessDate: "2026-01-02", createdAt: "2026-01-02T03:04:05.000Z", remark: null, reason: null, risks: [],
  lines: [{ id: "line-1", materialId: "m-1", quantity: "3", unit: { name: "米" }, material: { name: "面料A" } }],
  ...over,
});

type Override = (url: string, call: StubbedCall) => Response | Promise<Response> | undefined;

async function openAudit(override?: Override, movementNo = "MI-001") {
  const calls = stubApi((url, call) => {
    const intercepted = override?.(url, call);
    if (intercepted) return intercepted;
    if (url.endsWith("/production/orders")) return apiOk([]);
    if (url.endsWith("/production/material-movements")) return apiOk([movement(), movement({ id: "mr-1", movementNo: "MR-001", documentType: "return" })]);
    if (url.endsWith("/audit-events")) return apiOk([]);
    if (url.endsWith("/api/v1/attachments") && call.method === "POST") return apiOk({ id: "att-1" });
    if (url.endsWith("/attachments/att-1/links")) return apiOk({ id: "link-1" });
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
  render(<><Toaster /><MaterialIssuesPage /></>);
  const row = (await screen.findByText(movementNo)).closest('[data-testid="data-table-row"]') as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "审计" }));
  const dialog = await screen.findByRole("dialog");
  return { calls, dialog, input: within(dialog).getByTestId("material-voucher-file") as HTMLInputElement };
}

const pdf = (name = "签收单.pdf") => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const deletes = (calls: StubbedCall[]) => calls.filter((call) => call.method === "DELETE");

describe("原料流转审计弹窗：上传凭证", () => {
  it("先传文件再关联到本张单据，并提示结果", async () => {
    const { calls, dialog, input } = await openAudit();
    expect(input.accept).toBe("application/pdf,image/jpeg,image/png,.xls,.xlsx");
    const file = pdf();
    await userEvent.upload(input, file);

    expect(await screen.findByText("附件已关联")).toBeVisible();
    const [upload] = callsTo(calls, "/api/v1/attachments");
    expect(upload.method).toBe("POST");
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get("file")).toBe(file);
    const [link] = callsTo(calls, "/attachments/att-1/links");
    expect(link.method).toBe("POST");
    expect(JSON.parse(String(link.body))).toEqual({ entity_type: "raw_material_movement", entity_id: "mi-1", remark: "原料流转附件" });
    expect(dialog).toHaveTextContent("本次已上传：签收单.pdf");
    expect(deletes(calls)).toHaveLength(0);
    await waitFor(() => expect(input).toBeEnabled());
  });

  it("退料单那张表的「审计」同样可以上传，关联到退料单", async () => {
    const { calls, input } = await openAudit(undefined, "MR-001");
    await userEvent.upload(input, pdf());

    await waitFor(() => expect(callsTo(calls, "/attachments/att-1/links")).toHaveLength(1));
    expect(JSON.parse(String(callsTo(calls, "/attachments/att-1/links")[0].body)).entity_id).toBe("mr-1");
  });

  it("上传中禁用文件框", async () => {
    let finish: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    // 让上传请求停在半路，用来观察上传中的界面（stubApi 的 handler 允许返回 Promise）。
    const { input } = await openAudit((url) => (url.endsWith("/api/v1/attachments") ? pending : undefined));
    await userEvent.upload(input, pdf());

    expect(input).toBeDisabled();
    expect(screen.getByText("上传中…")).toBeVisible();
    finish(apiOk({ id: "att-1" }));
    await waitFor(() => expect(input).toBeEnabled());
  });

  it("审计记录加载失败时仍能上传", async () => {
    const { dialog, input } = await openAudit((url) => (url.endsWith("/audit-events") ? apiErr(403, "FORBIDDEN", "没有权限") : undefined));
    expect(await within(dialog).findByText("没有权限")).toBeVisible();
    await userEvent.upload(input, pdf());
    expect(await screen.findByText("附件已关联")).toBeVisible();
  });

  it("上传失败：显示后端原因，不发关联请求；同一个文件可以重选", async () => {
    const { calls, dialog, input } = await openAudit((url) => (url.endsWith("/api/v1/attachments") ? apiErr(400, "BAD_REQUEST", "不支持的文件类型或文件过大") : undefined));
    const file = pdf();
    await userEvent.upload(input, file);

    expect(await screen.findByText("不支持的文件类型或文件过大")).toBeVisible();
    expect(calls.filter((call) => call.url.endsWith("/links"))).toHaveLength(0);
    expect(dialog).not.toHaveTextContent("本次已上传");
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.upload(input, file);
    await waitFor(() => expect(callsTo(calls, "/api/v1/attachments")).toHaveLength(2));
  });

  it("网关返回非 JSON（如 413）时带上状态码", async () => {
    const { input } = await openAudit((url) => (url.endsWith("/api/v1/attachments") ? new Response("<html>413</html>", { status: 413 }) : undefined));
    await userEvent.upload(input, pdf());
    expect(await screen.findByText("附件上传失败（HTTP 413）")).toBeVisible();
  });

  it("关联被拒绝：删掉刚传的附件并显示原因", async () => {
    const { calls, dialog, input } = await openAudit((url, call) => {
      if (url.endsWith("/att-1/links")) return apiErr(404, "NOT_FOUND", "附件不存在");
      if (call.method === "DELETE" && url.endsWith("/attachments/att-1")) return apiOk({});
      return undefined;
    });
    await userEvent.upload(input, pdf());

    expect(await screen.findByText("附件不存在")).toBeVisible();
    expect(deletes(calls).map((call) => call.url)).toEqual(["/api/v1/attachments/att-1"]);
    expect(dialog).not.toHaveTextContent("本次已上传");
  });

  it("关联结果不明（网关错误）时不删附件", async () => {
    const { calls, input } = await openAudit((url) => (url.endsWith("/att-1/links") ? new Response("bad gateway", { status: 502 }) : undefined));
    await userEvent.upload(input, pdf());

    expect(await screen.findByText("请求失败")).toBeVisible();
    expect(deletes(calls)).toHaveLength(0);
  });

  it("达到 20MB 的文件在前端拦下，不发请求", async () => {
    const { calls, input } = await openAudit();
    const big = pdf("大文件.pdf");
    Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 });
    await userEvent.upload(input, big);

    expect(await screen.findByText("文件需小于 20MB")).toBeVisible();
    expect(calls.filter((call) => call.url.includes("/attachments"))).toHaveLength(0);
  });
});
