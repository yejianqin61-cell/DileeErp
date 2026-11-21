// 老旧浏览器兼容层的行为与守卫测试（2026-11-21）。
//
// 两层断言，缺一不可：
//   ① **守卫**：注入的脚本文本必须是 ES5 语法 —— 否则 IE11 连解析都失败，
//      连"请换浏览器"的提示都显示不出来（白屏到底，这正是用户报的现象）。
//   ② **行为**：polyfill 真的补对了。最要紧的是 `AbortSignal.timeout`，
//      因为 `lib/api-client.ts` 每次请求都用它，补错等于全站接口都挂。
import { describe, expect, it, beforeEach } from "vitest";
import { LEGACY_COMPAT_SCRIPT, LEGACY_SUPPORT_FLOOR } from "../lib/legacy-compat";

/** 把兼容脚本跑在一个"故意缺 API"的沙箱里，返回该沙箱的 window。 */
function runInSandbox(patch?: (win: Record<string, unknown>) => void): Record<string, any> {
  const win: Record<string, any> = {
    Promise, Symbol, Map, Set, Object, Array, String, URL,
    AbortController: globalThis.AbortController,
    // 用一个**空对象**充当沙箱里的 AbortSignal：polyfill 往它身上挂 timeout/any，
    // 这样测的是"polyfill 补出来的实现"，而不是被还原后的原生实现（否则测试会自欺欺人地绿）。
    // 它内部只用到 `new w.AbortController()`，返回的仍是真实 signal，行为一致。
    AbortSignal: {} as any,
    DOMException: globalThis.DOMException,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    CSS: { supports: () => true },
    Element: globalThis.Element,
    document: {
      body: { appendChild: () => undefined },
      querySelector: () => null,
      createElement: () => ({ setAttribute: () => undefined, innerHTML: "" }),
      addEventListener: () => undefined,
    },
    navigator: { userAgent: "test-agent" },
    fetch: () => Promise.resolve(),
  };
  // 先摘掉要测的那批 API，模拟旧浏览器
  delete (Array.prototype as any).at;
  delete (String.prototype as any).at;
  delete (Object as any).hasOwn;
  delete (Array.prototype as any).findLast;
  delete (Array.prototype as any).findLastIndex;
  delete (String.prototype as any).replaceAll;
  delete (Object as any).groupBy;
  delete (Array.prototype as any).toSorted;
  delete (Array.prototype as any).toReversed;
  delete (Array.prototype as any).toSpliced;
  delete (Promise as any).withResolvers;
  delete (globalThis.URL as any).canParse;

  patch?.(win);

  // 用 Function 在给定作用域里执行（脚本自身声明 `var w = window`）
  const runner = new Function("window", "self", LEGACY_COMPAT_SCRIPT);
  runner(win, win);
  return win;
}

describe("注入脚本的语法守卫", () => {
  it("必须是 ES5 语法：不许出现箭头函数 / let / const / class / 模板字符串 / 展开", () => {
    // 这些一旦出现，IE11 会在**解析阶段**抛 SyntaxError，整段脚本一行都不执行，
    // 于是连"请换浏览器"的兜底提示也显示不出来 —— 用户看到的就是白屏。
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/=>/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\blet\s/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\bconst\s/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\bclass\s/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\bfor\s*\(\s*(const|let)\b/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/`/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\.\.\./);
    // 可选链与空值合并是 Chrome 80 才有的，IE11 同样解析不了
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\?\.(?!\d)/);
    expect(LEGACY_COMPAT_SCRIPT).not.toMatch(/\?\?/);
  });

  it("必须真的能作为函数体解析（不是只靠正则猜）", () => {
    expect(() => new Function("window", "self", LEGACY_COMPAT_SCRIPT)).not.toThrow();
  });

  it("不得覆盖浏览器已有的原生实现（只补缺失）", () => {
    // 每处补丁都应带「if (!X)」守卫；抽查几个关键项
    expect(LEGACY_COMPAT_SCRIPT).toMatch(/if\s*\(!Array\.prototype\.at\)/);
    expect(LEGACY_COMPAT_SCRIPT).toMatch(/if\s*\(!Object\.hasOwn\)/);
    expect(LEGACY_COMPAT_SCRIPT).toMatch(/if\s*\(!String\.prototype\.replaceAll\)/);
    expect(LEGACY_COMPAT_SCRIPT).toMatch(/if\s*\(!Array\.prototype\.toSorted\)/);
    expect(LEGACY_COMPAT_SCRIPT).toMatch(/if\s*\(!w\.AbortSignal\.timeout\)/);
  });

  it("支持范围文案要写明具体浏览器版本，便于转告用户", () => {
    expect(LEGACY_SUPPORT_FLOOR).toMatch(/80/);
    expect(LEGACY_SUPPORT_FLOOR).toMatch(/Chrome/);
  });
});

describe("polyfill 行为", () => {
  let win: Record<string, any>;
  beforeEach(() => { win = runInSandbox(); });

  it("AbortSignal.timeout：超时后 abort，reason.name 为 TimeoutError", async () => {
    // 这条最要紧：api-client 每次请求都用它；老浏览器缺它 → 所有接口 TypeError
    const signal: AbortSignal = win.AbortSignal.timeout(5);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
    expect((signal as any).reason?.name).toBe("TimeoutError");
  });

  it("AbortSignal.timeout：未超时就不 abort（不能一上来就中止请求）", async () => {
    const signal: AbortSignal = win.AbortSignal.timeout(500);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(false);
  });

  it("AbortSignal.any：任一上游 abort 即 abort", async () => {
    const a = new (win.AbortController as typeof AbortController)();
    const b = new (win.AbortController as typeof AbortController)();
    const combined: AbortSignal = win.AbortSignal.any([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(combined.aborted).toBe(true);
  });

  it("Array.prototype.at：支持负索引且越界返回 undefined", () => {
    const arr = [1, 2, 3] as any[];
    expect(arr.at(0)).toBe(1);
    expect(arr.at(-1)).toBe(3);
    expect(arr.at(5)).toBeUndefined();
    expect(arr.at(-5)).toBeUndefined();
  });

  it("Object.hasOwn：只认自有属性", () => {
    const obj = Object.create({ inherited: 1 }) as any;
    obj.own = 2;
    expect((Object as any).hasOwn(obj, "own")).toBe(true);
    expect((Object as any).hasOwn(obj, "inherited")).toBe(false);
  });

  it("replaceAll：字符串与全局正则都替换，且不做 $ 模式展开", () => {
    expect(("a-b-c" as any).replaceAll("-", "+")).toBe("a+b+c");
    expect(("aaa" as any).replaceAll("a", "b")).toBe("bbb");
    expect(("x.y" as any).replaceAll(".", "-")).toBe("x-y");
    // 原生行为：字符串替换不做模式展开（$1 原样保留），这里必须一致
    expect(("ab" as any).replaceAll("b", "$1")).toBe("a$1");
    expect(("a1b2" as any).replaceAll(/\d/g, "#")).toBe("a#b#");
  });

  it("replaceAll：非全局正则应当抛 TypeError（与原生一致）", () => {
    expect(() => ("abc" as any).replaceAll(/b/, "x")).toThrow(TypeError);
  });

  it("Array.prototype.toSorted / toReversed / toSpliced / with：都不改动原数组", () => {
    const arr = [3, 1, 2] as any[];
    expect(arr.toSorted()).toEqual([1, 2, 3]);
    expect(arr.toReversed()).toEqual([2, 1, 3]);
    expect(arr.toSpliced(1, 1, 9)).toEqual([3, 9, 2]);
    expect(arr.with(0, 7)).toEqual([7, 1, 2]);
    expect(arr).toEqual([3, 1, 2]); // 原数组不变
  });

  it("findLast / findLastIndex：从后往前找", () => {
    const arr = [1, 5, 3, 5] as any[];
    expect(arr.findLast((v: number) => v === 5)).toBe(5);
    expect(arr.findLastIndex((v: number) => v === 5)).toBe(3);
    expect(arr.findLast((v: number) => v === 99)).toBeUndefined();
    expect(arr.findLastIndex((v: number) => v === 99)).toBe(-1);
  });

  it("Object.groupBy：按回调分组", () => {
    const out = (Object as any).groupBy([1, 2, 3, 4], (v: number) => (v % 2 === 0 ? "even" : "odd"));
    expect(out.odd).toEqual([1, 3]);
    expect(out.even).toEqual([2, 4]);
  });

  it("URL.canParse：合法返回 true、非法返回 false（不抛错）", () => {
    expect(win.URL.canParse("https://example.com")).toBe(true);
    expect(win.URL.canParse("not a url")).toBe(false);
  });
});

describe("缺底座时的兜底提示", () => {
  it("缺 fetch 等不可 polyfill 的底座时，记录缺失清单", () => {
    const win = runInSandbox((w) => { delete w.fetch; delete w.Promise; });
    expect(win.__dileeCompatMissing).toContain("fetch");
    expect(win.__dileeCompatMissing).toContain("Promise");
  });

  it("底座齐全时不该误报（否则正常浏览器也会弹提示）", () => {
    const win = runInSandbox();
    expect(win.__dileeCompatMissing).toEqual([]);
  });

  it("语法能力探测：浏览器解析不了可选链/空值合并时要报出来（Chrome 60~79 会静默白屏）", () => {
    // 这类浏览器 Promise / fetch / AbortController 全有，常规探测一项都不过问，
    // 但打包产物用了可选链与空值合并，脚本在解析阶段就 SyntaxError —— 白屏且没有提示。
    // 用 win.Function 换成"对这两种语法抛 SyntaxError"的假实现来模拟。
    const realFunction = Function;
    const win = runInSandbox((w) => {
      w.Function = function (body: string) {
        const Q = String.fromCharCode(63);
        if (body.indexOf(Q + ".") !== -1 || body.indexOf(Q + Q) !== -1) {
          throw new SyntaxError("Unexpected token");
        }
        return new (realFunction as any)(body);
      };
    });
    const joined = win.__dileeCompatMissing.join(" ");
    expect(joined).toMatch(/可选链/);
    expect(joined).toMatch(/空值合并/);
  });
});
