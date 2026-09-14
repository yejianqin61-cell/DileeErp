// RequestLogMiddleware 单元测试。
//
// recon（docs/test/00-recon-backend-coverage.md:243、:880）指出该文件零覆盖，
// 而它是全站**唯一的访问日志出口**：main.ts:18 `app.use(new RequestLogMiddleware().use)`。
// 它有两个必须钉死的契约：
//   1) 必须无条件放行 next()（否则整个 API 挂死在中间件里）；
//   2) 日志**只能**包含 URL/方法/状态/耗时/请求 id，绝不打印请求体、请求头、Cookie
//      —— 而 main.ts 的挂载顺序（request-id → request-log）决定了 request_id 的来源。
//
// 本文件不连数据库；该中间件不接触 Prisma，因此没有假 Prisma（也不需要 $queryRaw 桩）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RequestLogMiddleware } = require("../../dist/platform/http/request-log.middleware.js");
const { RequestIdMiddleware } = require("../../dist/platform/http/request-id.middleware.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 日志记录的键白名单（request_id 可能缺失，见对应用例）。
const LOG_KEYS_WITH_REQUEST_ID = ["duration_ms", "event", "level", "method", "path", "request_id", "status", "timestamp"];
const LOG_KEYS_ALONE = LOG_KEYS_WITH_REQUEST_ID.filter((key) => key !== "request_id");

/**
 * 假 Express 响应：只需 statusCode / getHeader / once。
 * once() 忠实实现 EventEmitter 语义（触发后自动摘除监听器），
 * 否则无法验证「finish 多次触发只记一条」。
 */
function fakeResponse({ headers = {}, statusCode = 200 } = {}) {
  const store = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const listeners = new Map();
  return {
    statusCode,
    headers: store,
    getHeader: (name) => store.get(String(name).toLowerCase()),
    setHeader: (name, value) => store.set(String(name).toLowerCase(), value),
    once(event, handler) {
      const wrapped = (...args) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((registered) => registered !== wrapped));
        handler(...args);
      };
      listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
    },
    emit(event) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  };
}

/** 假 Express 请求：本中间件只读 method / originalUrl。 */
const fakeRequest = (overrides = {}) => ({ method: "GET", originalUrl: "/api/v1/health", ...overrides });

/** 捕获 console.log，避免测试输出噪声，并断言「写了什么」。 */
function captureConsole() {
  const entries = [];
  const original = console.log;
  console.log = (...args) => { entries.push(args); };
  return {
    entries,
    lines: () => entries.map((args) => args[0]),
    parsed: (index = 0) => JSON.parse(entries[index][0]),
    restore: () => { console.log = original; },
  };
}

/**
 * 用受控时钟替换 performance.now()，跑完「进入 → finish」整个生命周期后还原，
 * 让 duration_ms 可以确定断言（中间件在 use() 与 finish 各取一次时钟）。
 */
function durationWithClock(values) {
  const original = globalThis.performance;
  let index = 0;
  globalThis.performance = { now: () => values[Math.min(index++, values.length - 1)] };
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    new RequestLogMiddleware().use(fakeRequest(), response, () => {});
    response.emit("finish");
    return capture.parsed().duration_ms;
  } finally {
    capture.restore();
    globalThis.performance = original;
  }
}

test("request-log.next_is_called_exactly_once_and_use_returns_undefined", async () => {
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    let nextCalls = 0;
    // main.ts:18 传的是**脱离实例的方法** `new RequestLogMiddleware().use`，
    // 因此 use 不得依赖 this —— 这里按同样方式解构调用。
    const { use } = new RequestLogMiddleware();
    const returned = use(fakeRequest(), response, () => { nextCalls += 1; });

    assert.equal(nextCalls, 1, "必须放行且只放行一次");
    assert.equal(returned, undefined, "不得返回响应体/布尔值，Express 会误判链式返回");
    assert.equal(response.listenerCount("finish"), 1, "注册且仅注册一个 finish 监听");
    assert.equal(capture.entries.length, 0, "请求进入时不得写日志（只在响应结束时写）");
  } finally {
    capture.restore();
  }
});

test("request-log.emits_one_structured_json_line_on_finish_with_the_allowlisted_fields", async () => {
  const capture = captureConsole();
  try {
    const response = fakeResponse({ statusCode: 201, headers: { "x-request-id": "req-abc" } });
    new RequestLogMiddleware().use(fakeRequest({ method: "POST", originalUrl: "/api/v1/sales-orders?page=2" }), response, () => {});

    response.emit("finish");

    assert.equal(capture.entries.length, 1, "一次 finish 只写一条日志");
    assert.equal(capture.entries[0].length, 1, "console.log 只接收一个参数（即 JSON 串）");
    const log = capture.parsed();
    assert.deepEqual(Object.keys(log).sort(), LOG_KEYS_WITH_REQUEST_ID, "日志字段是固定白名单，不得多出 headers/body/cookies 之类");
    assert.equal(log.level, "info");
    assert.equal(log.event, "http_request");
    assert.equal(log.method, "POST");
    assert.equal(log.path, "/api/v1/sales-orders?page=2");
    assert.equal(log.status, 201);
    assert.equal(log.request_id, "req-abc");
    assert.equal(Number.isInteger(log.duration_ms), true, "duration_ms 必须是整数毫秒");
    assert.ok(log.duration_ms >= 0, `duration_ms 不得为负，实际 ${log.duration_ms}`);
    assert.match(log.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "timestamp 是 ISO-8601");
    assert.ok(Number.isFinite(Date.parse(log.timestamp)), "timestamp 必须可解析");
  } finally {
    capture.restore();
  }
});

test("request-log.duration_ms_is_rounded_elapsed_time_and_clamped_neither_way", async () => {
  // 正常：Math.round(1234.6 - 1000) === 235
  assert.equal(durationWithClock([1000, 1234.6]), 235);

  // 边界：同一时刻完成的 0ms 请求（Math.round(0.4) === 0，不产生小数/负数）
  assert.equal(durationWithClock([7, 7.4]), 0);

  // 隐藏分支：时钟回拨时**不夹取**，会写出负数耗时（未验证真实运行是否发生过，仅固化行为）
  assert.equal(durationWithClock([100, 50]), -50, "没有 Math.max(0, …) 保护；此处变红说明已加夹取");
});

test("request-log.finish_fired_twice_writes_only_once", async () => {
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    new RequestLogMiddleware().use(fakeRequest(), response, () => {});

    response.emit("finish");
    response.emit("finish");

    assert.equal(capture.entries.length, 1, "用 once() 而非 on()：重复 finish 不得重复计数日志（否则访问量翻倍）");
    assert.equal(response.listenerCount("finish"), 0, "once 触发后监听器被摘除");
  } finally {
    capture.restore();
  }
});

test("request-log.request_id_comes_from_the_response_header_written_by_request-id-middleware", async () => {
  const capture = captureConsole();
  try {
    // main.ts:17-18 的真实挂载顺序：RequestIdMiddleware 先跑，RequestLogMiddleware 后跑。
    const request = { header: () => undefined, requestId: undefined };
    const response = fakeResponse();
    new RequestIdMiddleware().use(request, response, () => {});
    new RequestLogMiddleware().use(request, response, () => {});

    response.emit("finish");

    const log = capture.parsed();
    assert.match(String(response.getHeader("x-request-id")), UUID_PATTERN);
    assert.equal(log.request_id, response.getHeader("x-request-id"), "日志的 request_id 必须与响应头一致，否则无法与客户端报错关联");
  } finally {
    capture.restore();
  }
});

test("request-log.request_id_key_is_dropped_when_the_response_has_no_x-request-id", async () => {
  const capture = captureConsole();
  try {
    // 若挂载顺序被改（日志中间件先于 request-id）或响应头缺失，
    // JSON.stringify 会直接丢掉 undefined 的键 —— 线上表现为该条日志没有 request_id。
    const response = fakeResponse();
    new RequestLogMiddleware().use(fakeRequest(), response, () => {});
    response.emit("finish");

    const log = capture.parsed();
    assert.deepEqual(Object.keys(log).sort(), LOG_KEYS_ALONE, "键整体消失（不是 null）");
    assert.equal("request_id" in log, false);
  } finally {
    capture.restore();
  }
});

test("request-log.control_characters_and_quotes_in_the_url_cannot_break_the_log_line", async () => {
  const capture = captureConsole();
  try {
    const hostile = "/api/v1/search?q=%22%5Cn%22&note=line1\nline2\r\tend\"}";
    const response = fakeResponse();
    new RequestLogMiddleware().use(fakeRequest({ originalUrl: hostile }), response, () => {});
    response.emit("finish");

    const line = capture.lines()[0];
    assert.equal(line.includes("\n"), false, "日志必须是单行（换行注入会让一条请求变成多条日志）");
    assert.equal(line.includes("\r"), false);
    const log = JSON.parse(line); // 能解析 = 引号/花括号注入未破坏结构
    assert.equal(log.path, hostile, "原样保留，由 JSON 转义负责安全");
  } finally {
    capture.restore();
  }
});

test("request-log.oversized_url_is_logged_in_full_without_truncation", async () => {
  const capture = captureConsole();
  try {
    const longUrl = `/api/v1/health?q=${"a".repeat(8000)}`;
    const response = fakeResponse();
    new RequestLogMiddleware().use(fakeRequest({ originalUrl: longUrl }), response, () => {});
    response.emit("finish");

    const log = capture.parsed();
    assert.equal(log.path.length, longUrl.length, "无长度上限（客户端可用超长 URL 放大日志体积）；此处变红说明已截断");
    assert.ok(capture.lines()[0].length > 8000);
  } finally {
    capture.restore();
  }
});

test("request-log.credentials_in_the_query_string_are_logged_verbatim_KNOWN_DEFECT", async () => {
  // KNOWN_DEFECT（脱敏缺失）：本模块的关注点要求「不得打印密码/token/cookie」，
  // 但日志写的是 request.originalUrl（request-log.middleware.ts:7），而 Express 的
  // originalUrl **包含查询串**，因此带凭据的 URL 会被整条落到 stdout。
  // 责任位置：apps/api/src/platform/http/request-log.middleware.ts:7（path: request.originalUrl）。
  // 复现：GET /api/v1/auth/login?password=Sup3rSecret&token=abc123 → 日志 path 含明文凭据。
  // 该行为被固化而非修正（本任务的纪律：不改生产代码）。此处变红 = 已加入脱敏，请改为正向断言。
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    new RequestLogMiddleware().use(
      fakeRequest({ method: "GET", originalUrl: "/api/v1/auth/login?password=Sup3rSecret&token=abc123&session=dilee_session" }),
      response,
      () => {},
    );
    response.emit("finish");

    const log = capture.parsed();
    assert.match(log.path, /password=Sup3rSecret/, "密码明文进日志（缺陷）");
    assert.match(log.path, /token=abc123/, "token 明文进日志（缺陷）");
  } finally {
    capture.restore();
  }
});

test("request-log.cookies_authorization_and_request_body_are_never_serialised", async () => {
  // 正向脱敏护栏：越权信息只可能通过 request.headers / request.body / request.cookies 泄露，
  // 本中间件只读 method 与 originalUrl，因此这些来源必须整体缺席。
  const capture = captureConsole();
  try {
    const secrets = {
      cookie: "dilee_session=super-secret-session",
      authorization: "Bearer super-secret-bearer",
      password: "super-secret-password",
    };
    const request = fakeRequest({
      originalUrl: "/api/v1/auth/login",
      headers: secrets,
      body: { username: "admin", password: secrets.password },
      cookies: { dilee_session: "super-secret-session" },
    });
    const response = fakeResponse();
    new RequestLogMiddleware().use(request, response, () => {});
    response.emit("finish");

    const line = capture.lines()[0];
    for (const secret of Object.values(secrets)) {
      assert.equal(line.includes(secret), false, `日志不得包含凭据片段：${secret}`);
    }
    const log = capture.parsed();
    assert.equal("headers" in log, false, "不得整体倾印请求头");
    assert.equal("body" in log, false, "不得倾印请求体（登录请求体里就是明文密码）");
    assert.equal("cookies" in log, false);
  } finally {
    capture.restore();
  }
});

test("request-log.aborted_requests_are_never_logged_KNOWN_DEFECT", async () => {
  // KNOWN_DEFECT（可观测性缺口）：只监听 "finish"（request-log.middleware.ts:6），
  // 客户端中断 / 连接重置时 Express 只发 "close"，不发 "finish"，
  // 于是这类请求在访问日志里完全不可见（也解释了「有请求但无日志」的排查困境）。
  // 责任位置：apps/api/src/platform/http/request-log.middleware.ts:6。
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    new RequestLogMiddleware().use(fakeRequest(), response, () => {});

    assert.equal(response.listenerCount("finish"), 1);
    assert.equal(response.listenerCount("close"), 0, "没有 close 兜底；此处变红说明已补齐中断日志");

    response.emit("close");
    assert.equal(capture.entries.length, 0, "中断的请求不产生任何日志记录");
  } finally {
    capture.restore();
  }
});

test("request-log.missing_request_fields_degrade_to_absent_keys_instead_of_throwing", async () => {
  // 边界：中间件对入参**零校验**，缺字段时静默降级（键被 JSON.stringify 丢弃）而不是抛错。
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    new RequestLogMiddleware().use({}, response, () => {});
    assert.doesNotThrow(() => response.emit("finish"));

    const log = capture.parsed();
    assert.equal("method" in log, false, "method 缺失 → 键消失");
    assert.equal("path" in log, false, "originalUrl 缺失 → 键消失");
    assert.equal(log.event, "http_request", "固定的结构字段仍在");
    assert.equal(log.status, 200);
  } finally {
    capture.restore();
  }
});

test("request-log.invalid_response_without_getHeader_throws_and_writes_no_log", async (t) => {
  // 反向用例：非法输入（响应对象不满足 Express Response 契约）必须失败，
  // 且失败时**不产生日志写入** —— 不允许出现半截/伪造的成功日志。
  const capture = captureConsole();
  try {
    const response = fakeResponse();
    delete response.getHeader;
    const logsBefore = capture.entries.length;
    new RequestLogMiddleware().use(fakeRequest(), response, () => {});

    assert.throws(() => response.emit("finish"), TypeError, "缺失 getHeader 时抛出 TypeError（无防御性兜底）");
    assert.equal(capture.entries.length, logsBefore, "抛错路径不得写入任何日志");
  } finally {
    capture.restore();
  }
});

test("request-log.next_errors_propagate_and_are_never_swallowed", async () => {
  // 反向用例：下游中间件失败时，异常必须原样抛出（不得吞掉后假装请求成功），
  // 且此刻尚未 finish，因此不产生任何日志写入。
  const capture = captureConsole();
  try {
    const boom = new Error("downstream boom");
    const response = fakeResponse();
    const request = fakeRequest();

    assert.throws(
      () => new RequestLogMiddleware().use(request, response, () => { throw boom; }),
      (error) => error === boom,
      "异常必须原样传播（同一实例）",
    );
    assert.equal(capture.entries.length, 0, "失败路径不得写日志");
    assert.equal(response.listenerCount("finish"), 1, "监听器仍在，响应若最终 finish 仍会记录该请求");
  } finally {
    capture.restore();
  }
});
