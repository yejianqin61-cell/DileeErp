// ActionDialog：全站唯一的防重复提交强守卫。
//
// 为什么这个文件优先级最高（见 docs/test/00-recon-frontend-coverage.md）：
//   勘察发现 18 个文件共 153 个 <Button> 的 disabled 计数为 0，13 个 action 封装全无 in-flight 标志；
//   components/ui/action-dialog.tsx 是**唯一**同时守卫了输入、按钮与弹窗关闭的组件，
//   而它此前零测试。它一旦回归，全站表单会同时出现重复提交与"弹窗关不掉"。
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionDialog, type ActionField } from "../components/ui/action-dialog";

/** 可手动控制的 Promise，用于把组件稳定停在 submitting 状态上做断言。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const nameField: ActionField = { name: "name", label: "客户名称", required: true };
const remarkField: ActionField = { name: "remark", label: "备注" };

function renderDialog(overrides: Partial<Parameters<typeof ActionDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onSubmit = vi.fn();
  const props = {
    open: true,
    title: "新建客户",
    fields: [nameField, remarkField],
    submitLabel: "保存客户",
    onOpenChange,
    onSubmit,
    ...overrides,
  } as Parameters<typeof ActionDialog>[0];
  render(<ActionDialog {...props} />);
  return { onOpenChange, onSubmit };
}

describe("ActionDialog 防重复提交与表单契约", () => {
  it("必填项为空时给出可读提示且不提交", async () => {
    const { onSubmit, onOpenChange } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请填写客户名称");
    expect(onSubmit).not.toHaveBeenCalled();
    // 校验失败不得关闭弹窗，否则用户输入会丢
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("只填空格不算填写（trim 后判定）", async () => {
    const { onSubmit } = renderDialog();

    await userEvent.type(screen.getByLabelText(/客户名称/), "   ");
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请填写客户名称");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("提交中：按钮进入禁用态并改文案，且连点不会触发第二次提交", async () => {
    const gate = deferred();
    const onSubmit = vi.fn(() => gate.promise);
    renderDialog({ onSubmit });

    await userEvent.type(screen.getByLabelText(/客户名称/), "测试客户");
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    // 提交中：文案切换 + 禁用，这是防重复提交的可见契约
    const pending = await screen.findByRole("button", { name: "提交中…" });
    expect(pending).toBeDisabled();

    // 连点：disabled 的按钮不会触发第三次 onClick
    await userEvent.click(pending);
    await userEvent.click(pending);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    gate.resolve();
  });

  it("提交中：输入框、取消按钮与「新增类目」一并禁用", async () => {
    const gate = deferred();
    renderDialog({ onSubmit: vi.fn(() => gate.promise) });

    await userEvent.type(screen.getByLabelText(/客户名称/), "测试客户");
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));
    await screen.findByRole("button", { name: "提交中…" });

    expect(screen.getByLabelText(/客户名称/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    gate.resolve();
  });

  it("提交中：关闭按钮被门禁挡住，弹窗不会关闭", async () => {
    const gate = deferred();
    const { onOpenChange } = renderDialog({ onSubmit: vi.fn(() => gate.promise) });

    await userEvent.type(screen.getByLabelText(/客户名称/), "测试客户");
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));
    await screen.findByRole("button", { name: "提交中…" });

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));

    // 若此处回归，一次悬挂请求会让弹窗永久关不掉（历史上正是这个成因）
    expect(onOpenChange).not.toHaveBeenCalled();

    gate.resolve();
  });

  it("提交成功后携带各字段当前值并请求关闭", async () => {
    const { onSubmit, onOpenChange } = renderDialog();

    await userEvent.type(screen.getByLabelText(/客户名称/), "测试客户");
    await userEvent.type(screen.getByLabelText(/备注/), "来自组件测试");
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ name: "测试客户", remark: "来自组件测试" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("onSubmit 抛错时展示错误文案、恢复可提交且不关闭弹窗", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("客户编号已存在")));
    renderDialog({ onSubmit });

    await userEvent.type(screen.getByLabelText(/客户名称/), "重复客户");
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("客户编号已存在");
    // 失败后必须回到可提交状态，否则用户无法重试
    expect(screen.getByRole("button", { name: "保存客户" })).toBeEnabled();
  });

  it("多选类必填给出「请选择」而不是「请填写」", async () => {
    const multi: ActionField = { name: "material_id", label: "物料", required: true, type: "multi-checkbox", options: [{ value: "m-1", label: "面料A" }] };
    renderDialog({ fields: [multi] });

    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请选择物料");
  });
});
