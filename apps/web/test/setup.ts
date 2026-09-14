// 组件测试的全局装配。
//
// 1) jest-dom 匹配器（toBeVisible / toBeDisabled / toHaveTextContent …）挂到 vitest 的 expect 上。
// 2) 每个用例后卸载已渲染的组件树，并还原被 stub 的全局对象（fetch 等）。
//    这两步必须成对出现：只 cleanup 不还原 fetch，会让后续用例拿到上一个用例的桩。
// 3) jsdom 未实现的几个浏览器 API 补最小桩 —— Radix 的 Select/Dialog 会用到它们，
//    缺失时会抛 TypeError 而不是"测试失败"，容易被误读为组件问题。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Radix Select 通过 Pointer Events 捕获指针；jsdom 没有实现这一组方法。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
}

// Radix 打开列表时会把选中项滚入视野；jsdom 没有布局，也没有该方法。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}

// Radix 的部分原语（Select 的定位、Dialog 的尺寸观测）依赖 ResizeObserver。
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
