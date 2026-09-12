// 工序员工日报面板的三项行为守卫（用户明确要求，且都是"看不见就会退化"的实现细节）：
// 1) 挑选员工支持同一员工重复复选（同一天同一生产单同一工序可多次登记，各自独立计薪）；
// 2) 全站计时单位统一为小时（面板不得再出现"分钟"口径的录入/表头）；
// 3) 每个条目都有"备注"列，并且可随更正一起保存。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const panel = readFileSync(join(webRoot, "components", "production", "daily-reports-panel.tsx"), "utf8");

test("挑选员工支持同一员工重复复选（不得去重、不得用员工 ID 当行 key）", () => {
  assert.equal(
    /selectedEmployeeIds\.filter\(\(id\) => !rows\.some\(/.test(panel),
    false,
    "加入日报时不得再过滤掉已存在的员工（否则无法同一员工多次登记）",
  );
  assert.match(panel, /\.\.\.selectedEmployeeIds\.map\(\(employee_id\) => \(/, "选中的每个员工都要无条件追加一行");
  assert.equal(
    /<TableRow key=\{row\.employee_id\}>/.test(panel),
    false,
    "草稿行不能再用 employee_id 当 React key（重复员工会互相覆盖）",
  );
  assert.match(panel, /<TableRow key=\{`\$\{row\.employee_id\}-\$\{index\}`\}>/, "草稿行 key 必须带上行序号");
});

test("批量保存的幂等键用草稿行自身标识，不能用行序号（超时重试会错位丢行）", () => {
  assert.match(panel, /draft_id: idempotencyKey\(\)/, "每行草稿创建时必须分配稳定的 draft_id");
  assert.match(panel, /type Draft = \{ draft_id: string;/, "草稿类型必须带 draft_id");
  assert.match(panel, /idempotency_key: `\$\{batchKey\}-\$\{draft_id\}`/, "幂等键 = 批次 + 草稿行标识");
  assert.equal(
    /idempotency_key: `\$\{batchKey\}-\$\{index\}/.test(panel),
    false,
    "不得再用行序号拼幂等键：删除/调整某行后重试会让旧键落到别的员工身上",
  );
  assert.match(panel, /drafts\.map\(\(\{ draft_id, \.\.\.row \}\)/, "draft_id 是前端内部字段，不得进入请求体");
});

test("计时单位统一为小时：面板不出现分钟口径，且单价按 元/小时 提示", () => {
  // 允许注释里说明“数据库仍以分钟存储”，但不允许任何界面文案出现分钟口径。
  assert.equal(/时长（分钟）/.test(panel), false, "面板不得再出现“时长（分钟）”文案");
  assert.equal(/<TableHead>[^<]*分钟/.test(panel), false, "表头不得出现分钟单位");
  assert.equal(/\$\{?[a-zA-Z_.]*时长[^"`<]*分钟/.test(panel), false, "提示文案不得出现分钟单位");
  const hourHeaders = panel.match(/<TableHead>时长（小时）<\/TableHead>/g) ?? [];
  assert.equal(hourHeaders.length, 2, "草稿表与日报表的时长表头都要是时长（小时），当前 " + hourHeaders.length + " 处");
  assert.match(panel, /const unitPriceLabel = \(mode: string\) => mode === "time_rate" \? "单价（元\/小时）" : "单价（元\/件）"/, "计时单价必须标注元/小时");
  assert.match(panel, /if \(edit\.duration_hours !== original\.duration_hours\) body\.duration_hours = edit\.duration_hours;/, "更正日报必须提交 duration_hours（小时）");
  assert.equal(/duration_minutes: edit\.duration_minutes/.test(panel), false, "不得再按分钟提交时长");
  assert.match(panel, /hoursText\(report\.durationMinutes\)/, "已保存日报的时长必须由分钟换算成小时展示");
});

test("草稿表与日报表都有备注列，且更正要能保存备注", () => {
  const remarkHeaders = panel.match(/<TableHead>备注<\/TableHead>/g) ?? [];
  assert.equal(remarkHeaders.length, 2, "草稿表与日报表都必须有备注列，当前 " + remarkHeaders.length + " 处");
  assert.match(panel, /type Draft = \{[^}]*remark: string \}/, "草稿行必须带备注字段");
  assert.match(panel, /type Report = \{[^}]*remark\?: string \| null/, "日报行必须接收 remark 字段");
  assert.match(panel, /remark: edit\.remark\.trim\(\)/, "保存更正必须提交备注（空串表示清空）");
  assert.match(panel, /edit\.remark !== original\.remark/, "备注变化必须参与“已修改”判定，否则保存按钮会一直禁用");
});

// 只改备注（或打开更正弹窗什么都不改）绝不能顺带把按分钟单价录入的历史计时日报重算成 ÷60。
// 前端只提交真正改动过的计价字段，后端再按“生效值是否变化”二次把关。
test("更正日报只提交改动过的计价字段（避免只改备注就把历史金额重算）", () => {
  assert.match(panel, /if \(edit\.quantity !== original\.quantity\) body\.quantity = edit\.quantity;/, "件数未变则不提交");
  assert.match(panel, /if \(edit\.duration_hours !== original\.duration_hours\) body\.duration_hours = edit\.duration_hours;/, "时长未变则不提交");
  assert.match(panel, /if \(edit\.unit_price !== original\.unit_price\) body\.unit_price = edit\.unit_price;/, "单价未变则不提交");
  assert.equal(
    /body: JSON\.stringify\(\{\s*quantity: edit\.quantity/.test(panel),
    false,
    "不得再整体回传 quantity/unit_price（后端会认为计价要素变了）",
  );
});
