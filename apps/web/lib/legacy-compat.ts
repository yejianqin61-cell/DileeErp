/**
 * 老旧浏览器兼容层（2026-11-21）。
 *
 * ## 为什么要做
 *
 * 用户反馈：Windows 10 以下的系统用浏览器打不开 ERP。实测诊断结论（见
 * `docs/deployment/legacy-browser-compatibility.md`）：
 *
 * - 构建产物的**语法底线是 Chrome 80**（含 `?.` / `??`，不含逻辑赋值 / 私有字段）；
 * - 我们自己的 `lib/api-client.ts` 在**每一次请求**上都调用 `AbortSignal.timeout`，
 *   而它是 **Chrome 103 / Firefox 100 / Safari 16** 才有的 —— 也就是说
 *   **Chrome 80~102 上页面能渲染，但每个接口都抛 TypeError，登录都登不进去**。
 * - IE 11 / 360 兼容模式（IE 内核）上整个脚本会语法报错 → 纯白屏，且**无法修复**
 *   （React 19 + Next 15 不可能跑在 IE 上）。这类只能明确告知用户换浏览器。
 *
 * ## 这个文件做什么
 *
 * 1. **补 API**：把 Chrome 80~102 缺的那一批（`AbortSignal.timeout`、
 *    `AbortSignal.any`、`Array.prototype.at`、`Object.hasOwn`、`findLast`、
 *    `replaceAll`、`Object.groupBy`、`Array.prototype.toSorted` 等）用 ES5 实现补齐。
 * 2. **兜底提示**：如果浏览器连不可 polyfill 的底座都缺（Promise / fetch / CSS 变量 …），
 *    就**明确告诉用户换浏览器**，而不是留一个白屏让人猜。
 *
 * ## 两个硬约束（改这个文件前务必知道）
 *
 * - **注入的脚本文本必须是 ES5**：它要在 IE11 上也能**解析**，否则语法错误会让兜底提示
 *   都显示不出来。所以脚本里不许出现箭头函数、`let`/`const`、`class`、`for…of`、
 *   展开运算符、模板字符串。`apps/web/test/legacy-compat.test.tsx` 有一条用例专门拦这个。
 * - **必须内联在 `<head>`、先于所有打包产物执行**：靠 `import` 顺序保证不了，
 *   供应商 chunk 可能先加载。所以由 `app/layout.tsx` 直接内联注入。
 */

/** 支持下限，用于文档与提示文案（不是精确判定，精确判定看下面的探测清单）。 */
export const LEGACY_SUPPORT_FLOOR = "Chrome / Edge 80 以上、Firefox 78 以上、Safari 14 以上";

/**
 * 内联注入的兼容脚本。**ES5 语法**，见文件头第 1 条硬约束。
 *
 * 结构：能力探测 → 补齐 API → 缺底座则渲染中文提示层。
 */
export const LEGACY_COMPAT_SCRIPT = `
(function () {
  var w = typeof window !== 'undefined' ? window : null;
  if (!w) { return; }
  var doc = w.document;

  // ---------- 1) 能力探测：这些补不出来，缺了就明确告知 ----------
  var missing = [];
  function need(name, ok) { if (!ok) { missing.push(name); } }

  need('Promise', typeof w.Promise === 'function');
  need('Symbol', typeof w.Symbol === 'function');
  need('Map / Set', typeof w.Map === 'function' && typeof w.Set === 'function');
  need('Object.assign', typeof Object.assign === 'function');
  need('Array.from', typeof Array.from === 'function');
  need('fetch', typeof w.fetch === 'function');
  need('AbortController', typeof w.AbortController === 'function');
  need('CSS 变量', !!(w.CSS && w.CSS.supports && w.CSS.supports('--dilee', '0')));
  need('Element.closest', !!(w.Element && w.Element.prototype && typeof w.Element.prototype.closest === 'function'));

  // 语法能力探测：**这是最容易被忽略的一类**。
  // Chrome 60~79 有 Promise / fetch / AbortController（所以上面的探测全过），但**解析不了**
  // 可选链与空值合并 —— 而打包产物的语法底线正好是 Chrome 80（含这两个运算符）。
  // 结果是脚本在**解析阶段**就 SyntaxError，一行都不执行：既白屏、又没有提示。
  // 用 new Function 在运行时试解析是最可靠的探测（try/catch 能接住解析错误）。
  // 探测串用 String.fromCharCode 拼出运算符：源文件里**不出现**这两个运算符字面量，
  // 一是守卫测试要求整段脚本不含它们（保证 IE11 能解析本脚本），
  // 二是本文件是模板字符串，注释与字符串里都不宜出现反引号/特殊符号。
  function canParse(body) {
    // 用 w.Function（浏览器里就是全局 Function）而不是裸 Function：
    // 这样测试可以把 win.Function 换成一个"对指定语法抛 SyntaxError"的假实现，
    // 从而在 Node 里模拟 Chrome 60~79，而不必污染真实全局。
    var Fn = w.Function || Function;
    try { new Fn(body); return true; } catch (e) { return false; }
  }
  var Q = String.fromCharCode(63);
  if (!canParse('var a = {}; return a' + Q + '.' + 'b;')) { missing.push('可选链（需 Chrome 80 以上）'); }
  if (!canParse('var a = null; return a ' + Q + Q + ' 1;')) { missing.push('空值合并（需 Chrome 80 以上）'); }

  // ---------- 2) 补齐 API（每项都先判存在，绝不覆盖原生实现）----------

  // Array.prototype.at / String.prototype.at —— Chrome 92
  function atImpl(n) {
    var len = this.length >>> 0;
    var k = n < 0 ? Math.ceil(n) : Math.floor(n);
    if (k < 0) { k = k + len; }
    if (k < 0 || k >= len) { return undefined; }
    return this[k];
  }
  if (!Array.prototype.at) { Array.prototype.at = atImpl; }
  if (!String.prototype.at) { String.prototype.at = atImpl; }

  // Object.hasOwn —— Chrome 93
  if (!Object.hasOwn) {
    Object.hasOwn = function (obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    };
  }

  // Array.prototype.findLast / findLastIndex —— Chrome 97
  if (!Array.prototype.findLast) {
    Array.prototype.findLast = function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i = i - 1) {
        if (fn.call(thisArg, this[i], i, this)) { return this[i]; }
      }
      return undefined;
    };
  }
  if (!Array.prototype.findLastIndex) {
    Array.prototype.findLastIndex = function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i = i - 1) {
        if (fn.call(thisArg, this[i], i, this)) { return i; }
      }
      return -1;
    };
  }

  // String.prototype.replaceAll —— Chrome 85
  // 已知差异：字符串替换时不做 $& / $1 之类的替换模式展开（直接替换为目标串）。
  // 我们自己的 5 处用法都是「把固定子串换成固定子串」，与原生行为一致。
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (search, replacement) {
      var s = String(this);
      if (Object.prototype.toString.call(search) === '[object RegExp]') {
        if (!search.global) { throw new TypeError('replaceAll must be called with a global RegExp'); }
        return s.replace(search, replacement);
      }
      var needle = String(search);
      if (needle === '') {
        if (typeof replacement === 'function') {
          var outEmpty = '';
          for (var j = 0; j <= s.length; j = j + 1) { outEmpty = outEmpty + String(replacement('', j, s)) + s.charAt(j); }
          return outEmpty;
        }
        var outE = '';
        for (var k = 0; k <= s.length; k = k + 1) { outE = outE + String(replacement) + s.charAt(k); }
        return outE;
      }
      var result = '';
      var from = 0;
      var at = s.indexOf(needle, from);
      while (at !== -1) {
        result = result + s.slice(from, at);
        result = result + (typeof replacement === 'function' ? String(replacement(needle, at, s)) : String(replacement));
        from = at + needle.length;
        at = s.indexOf(needle, from);
      }
      return result + s.slice(from);
    };
  }

  // Object.groupBy / Map.groupBy —— Chrome 117
  if (!Object.groupBy) {
    Object.groupBy = function (items, callback, thisArg) {
      var out = {};
      var list = Object(items);
      for (var i = 0; i < list.length; i = i + 1) {
        var key = String(callback.call(thisArg, list[i], i));
        if (!Object.prototype.hasOwnProperty.call(out, key)) { out[key] = []; }
        out[key].push(list[i]);
      }
      return out;
    };
  }
  if (typeof w.Map === 'function' && !Map.groupBy) {
    Map.groupBy = function (items, callback, thisArg) {
      var out = new Map();
      var list = Object(items);
      for (var i = 0; i < list.length; i = i + 1) {
        var key = callback.call(thisArg, list[i], i);
        if (!out.has(key)) { out.set(key, []); }
        out.get(key).push(list[i]);
      }
      return out;
    };
  }

  // Array.prototype.toSorted / toReversed / toSpliced / with —— Chrome 110
  if (!Array.prototype.toSorted) {
    Array.prototype.toSorted = function (compare) {
      var copy = Array.prototype.slice.call(this);
      return copy.sort(compare);
    };
  }
  if (!Array.prototype.toReversed) {
    Array.prototype.toReversed = function () {
      return Array.prototype.slice.call(this).reverse();
    };
  }
  if (!Array.prototype.toSpliced) {
    Array.prototype.toSpliced = function () {
      var copy = Array.prototype.slice.call(this);
      var args = Array.prototype.slice.call(arguments);
      copy.splice.apply(copy, args);
      return copy;
    };
  }
  if (!Array.prototype.with) {
    Array.prototype.with = function (index, value) {
      var copy = Array.prototype.slice.call(this);
      var i = index < 0 ? copy.length + index : index;
      if (i < 0 || i >= copy.length) { throw new RangeError('Invalid index'); }
      copy[i] = value;
      return copy;
    };
  }

  // Promise.withResolvers —— Chrome 119
  var P = w.Promise;
  if (typeof P === 'function' && !P.withResolvers) {
    P.withResolvers = function () {
      var resolveFn;
      var rejectFn;
      var promise = new P(function (resolve, reject) { resolveFn = resolve; rejectFn = reject; });
      return { promise: promise, resolve: resolveFn, reject: rejectFn };
    };
  }

  // AbortSignal.timeout —— Chrome 103；API 调用全靠它，缺了每个请求都抛错
  if (w.AbortSignal) {
    if (!w.AbortSignal.timeout) {
      w.AbortSignal.timeout = function (ms) {
        var controller = new w.AbortController();
        var timer = w.setTimeout(function () {
          var reason;
          try { reason = new w.DOMException('signal timed out', 'TimeoutError'); }
          catch (e) { reason = undefined; }
          controller.abort(reason);
        }, ms);
        if (controller.signal && controller.signal.addEventListener) {
          controller.signal.addEventListener('abort', function () { w.clearTimeout(timer); });
        }
        return controller.signal;
      };
    }
    // AbortSignal.any —— Chrome 116
    if (!w.AbortSignal.any) {
      w.AbortSignal.any = function (signals) {
        var controller = new w.AbortController();
        var done = false;
        function trip(source) {
          if (done) { return; }
          done = true;
          controller.abort(source && source.reason);
        }
        for (var i = 0; i < signals.length; i = i + 1) {
          var s = signals[i];
          if (!s) { continue; }
          if (s.aborted) { trip(s); return controller.signal; }
          if (s.addEventListener) {
            (function (captured) {
              captured.addEventListener('abort', function () { trip(captured); });
            })(s);
          }
        }
        return controller.signal;
      };
    }
  }

  // URL.canParse —— Chrome 120（Next 自己也补了一份，这里兜底）
  if (w.URL && !w.URL.canParse) {
    w.URL.canParse = function (url, base) {
      try { new w.URL(url, base); return true; } catch (e) { return false; }
    };
  }

  // ---------- 3) 缺底座：明确告知，不留白屏 ----------
  if (missing.length === 0) {
    w.__dileeCompatMissing = [];
    return;
  }
  w.__dileeCompatMissing = missing;

  function renderNotice() {
    if (!doc || !doc.body) { return; }
    if (doc.querySelector('[data-dilee-compat="unsupported"]')) { return; }
    var ua = (w.navigator && w.navigator.userAgent) ? w.navigator.userAgent : '未知';
    ua = ua.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var items = '';
    for (var i = 0; i < missing.length; i = i + 1) {
      items = items + '<li>' + String(missing[i]).replace(/</g, '&lt;') + '</li>';
    }
    var box = doc.createElement('div');
    box.setAttribute('data-dilee-compat', 'unsupported');
    box.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#f5f7fa;color:#172033;padding:28px 24px;font-family:Arial,"Microsoft YaHei",sans-serif;font-size:15px;line-height:1.75;overflow:auto;');
    box.innerHTML =
      '<h1 style="margin:0 0 12px;font-size:20px;color:#b42318;">当前浏览器无法打开迪礼 ERP</h1>' +
      '<p style="margin:0 0 10px;">这个浏览器缺少 ERP 必需的 <b>' + missing.length + '</b> 项基础能力：</p>' +
      '<ul style="margin:0 0 16px;padding-left:20px;color:#647184;">' + items + '</ul>' +
      '<p style="margin:0 0 10px;"><b>解决办法：换一个浏览器打开</b></p>' +
      '<ul style="margin:0 0 16px;padding-left:20px;">' +
      '<li>Windows 10 / 11：<b>Microsoft Edge</b> 或 <b>Google Chrome</b> 最新版</li>' +
      '<li>Windows 7 / 8.1：<b>Chrome 109</b>（这是这些系统支持的最高版本）或 <b>Edge 109</b></li>' +
      '<li>如果用的是 360 / QQ / 搜狗浏览器：请切到<b>「极速模式」</b>（不要用兼容 / IE 模式）</li>' +
      '<li>IE 浏览器（含 IE 内核的兼容模式）无法使用本系统，请改用上面的浏览器</li>' +
      '</ul>' +
      '<p style="margin:0;color:#647184;font-size:13px;">技术信息（反馈给管理员时请截图这一行）：<br>' +
      '缺少能力：' + missing.join('、') + '<br>' +
      '浏览器标识：' + ua + '</p>';
    doc.body.appendChild(box);
  }

  if (doc && doc.body) { renderNotice(); }
  else if (doc && doc.addEventListener) { doc.addEventListener('DOMContentLoaded', renderNotice); }
})();
`.trim();