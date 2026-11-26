// Service Worker 注册组件：什么时候允许整页刷新。
//
// sw.js 安装即 skipWaiting + clients.claim()，首次访问的页面会从「无 controller」变为被接管，
// 同样触发 controllerchange。那一次不能刷新（会清掉用户已输入的内容）；
// 只有旧版本被新版本替换、或静态资源缺失时才刷新。
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PwaRegister } from "../components/pwa-register";

class FakeServiceWorkerContainer extends EventTarget {
  controller: object | null;
  register = vi.fn(() => Promise.resolve({}));

  constructor(controller: object | null) {
    super();
    this.controller = controller;
  }

  /** 模拟浏览器：先换掉 controller，再派发 controllerchange。 */
  takeControl() {
    this.controller = {};
    this.dispatchEvent(new Event("controllerchange"));
  }

  post(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const reload = vi.fn();

function mount(controller: object | null) {
  const container = new FakeServiceWorkerContainer(controller);
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  const view = render(<PwaRegister />);
  return { container, view };
}

describe("PwaRegister", () => {
  beforeEach(() => {
    reload.mockClear();
    // jsdom 的 location.reload 不可单独改写，整体替换 location。
    vi.stubGlobal("location", { reload });
  });

  afterEach(() => {
    // 先卸载（组件清理时要访问 serviceWorker），再撤掉桩。
    cleanup();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("注册 sw.js 且不走 HTTP 缓存检查更新", () => {
    const { container } = mount(null);
    expect(container.register).toHaveBeenCalledWith("/sw.js", { updateViaCache: "none" });
  });

  it("首次访问被 Service Worker 接管时不刷新", () => {
    const { container } = mount(null);
    container.takeControl();
    expect(reload).not.toHaveBeenCalled();
  });

  it("首次接管之后，同一页面里的版本替换仍会刷新", () => {
    const { container } = mount(null);
    container.takeControl();
    container.takeControl();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("页面原本已有 controller 时，版本替换会刷新", () => {
    const { container } = mount({});
    container.takeControl();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["首次访问", null],
    ["已受控页面", {}],
  ])("%s收到静态资源缺失消息时刷新", (_label, controller) => {
    const { container } = mount(controller);
    container.post({ type: "dilee-static-chunk-missing" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("忽略其他消息", () => {
    const { container } = mount({});
    container.post({ type: "something-else" });
    container.post(null);
    expect(reload).not.toHaveBeenCalled();
  });

  it("多个刷新信号只刷新一次", () => {
    const { container } = mount({});
    container.takeControl();
    container.takeControl();
    container.post({ type: "dilee-static-chunk-missing" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("卸载后不再响应事件", () => {
    const { container, view } = mount({});
    view.unmount();
    container.takeControl();
    container.post({ type: "dilee-static-chunk-missing" });
    expect(reload).not.toHaveBeenCalled();
  });
});
