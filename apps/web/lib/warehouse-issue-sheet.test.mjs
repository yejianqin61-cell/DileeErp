// 领料/补料单的三项行为守卫（用户明确要求，且都是"看不见就会退化"的实现细节）：
// 1) 物料下拉必须引用该生产单订单的 BOM 明细，而不是全部物料；
// 2) 编辑必须在**全屏独立页面**完成（窄侧栏里列多时物料名/规格会挤在一起互相覆盖）；
// 3) 已过账的领料/补料单要能"回退草稿"继续编辑。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");
const warehouse = read("app", "warehouse", "page.tsx");
const editorPage = read("app", "production", "material-issues", "new", "page.tsx");
const editor = read("components", "production", "material-slip-editor.tsx");
const listPage = read("app", "production", "material-issues", "page.tsx");
const slipApi = read("lib", "material-slip-api.ts");
const panel = read("components", "production", "material-issues-panel.tsx");
const css = read("app", "globals.css");

test("物料下拉引用生产单订单的 BOM 明细（不能再列出全部物料）", () => {
  assert.equal(/materials\.map\(/.test(editor), false, "编辑页里不得再直接用全部物料作为下拉选项");
  assert.match(editor, /apiGet<\{ items: BomItem\[\] \}>\(`\/boms\/\$\{bomId\}`\)/, "必须按 bomId 拉取 BOM 明细");
  assert.match(editor, /bomMaterialOptions\.length \? bomMaterialOptions\.map\(/, "下拉选项必须来自 BOM 明细");
  assert.match(editor, /async function changeOrder/, "切换生产单时必须重新加载该订单的 BOM");
});

test("新建/编辑领料单与补料单都在全屏独立页面（不再用窄侧栏 Sheet）", () => {
  // 仓库页只放按钮跳转，不再内嵌编辑器
  assert.match(warehouse, /<Link href="\/production\/material-issues\/new">新建领料单<\/Link>/, "仓库页要有新建领料单按钮");
  assert.match(warehouse, /<Link href="\/production\/material-issues\/new\?type=replenishment">新建补料单<\/Link>/, "仓库页要有新建补料单按钮");
  assert.equal(/issueDraft|replenishmentDraft/.test(warehouse), false, "仓库页不得再保留侧栏草稿状态");
  assert.equal(/material-issue-sheet/.test(warehouse), false, "仓库页不得再使用窄侧栏编辑样式");
  // 独立页面按 type 渲染同一个编辑器，并支持 ?production_order_id / ?movement_id
  assert.match(editorPage, /searchParams\.get\("type"\) === "replenishment" \? "replenishment" : "issue"/, "同一页面支持领料与补料两种类型");
  assert.match(editorPage, /<MaterialSlipEditor documentType=\{type\}/, "页面渲染编辑器组件");
  assert.match(editor, /searchParams\.get\("movement_id"\)/, "支持继续编辑指定草稿");
  assert.match(editor, /searchParams\.get\("production_order_id"\)/, "支持预选生产单");
  // 两种单据类型的创建/过账路径集中在 lib/material-slip-api.ts（有独立行为测试），
  // 编辑页必须走它而不是自己写死，否则补料单会打到领料单接口上。
  assert.match(editor, /createMovementPath\(documentType\)/, "补料单走补料创建接口");
  assert.match(editor, /postMovementPath\(documentType, id\)/, "补料单过账走 post-replenishment");
  assert.match(slipApi, /"\/production\/material-movements\/replenishments"/);
  assert.match(slipApi, /post-replenishment/);
  assert.match(listPage, /新建领料单<\/Link>/, "单据列表页也要有新建入口");
  assert.match(listPage, /新建补料单<\/Link>/, "单据列表页也要有新建补料入口");
});

test("全屏编辑页给关键列固定宽度并单行省略，避免物料名与相邻列互相覆盖", () => {
  assert.match(css, /\.material-slip-editor \.data-table th,[\s\S]{0,120}overflow: hidden; text-overflow: ellipsis; white-space: nowrap/, "表头/单元格必须单行省略");
  assert.match(css, /\.material-slip-editor \.slip-col-material \{ min-width: 260px/, "物料列要固定最小宽度");
  assert.match(css, /\.material-slip-editor \.slip-col-qty input \{ width: 108px/, "数量输入框固定宽度");
  assert.match(css, /\.material-slip-editor \.slip-col-material \.ui-select-trigger > span \{[\s\S]{0,160}text-overflow: ellipsis/, "Select 文案要在自己单元格内省略");
  assert.match(editor, /className="panel material-slip-editor"/, "编辑页表格要挂上专属样式类");
});

test("已过账的领料/补料单支持回退草稿，且必须填原因", () => {
  assert.match(warehouse, /\/production\/material-movements\/\$\{movement\.id\}\/reopen/, "必须调用回退草稿接口");
  assert.match(warehouse, /label: "回退原因（退回草稿后库存会相应回补）", type: "textarea", required: true/, "回退原因必填");
  assert.match(warehouse, /\["issue", "replenishment"\]\.includes\(row\.original\.documentType\)[\s\S]{0,200}?>回退草稿<\/Button>/, "只有领料/补料单显示回退按钮");
});

test("编辑已有草稿时锁定生产单（PATCH 不支持换单，换了会让明细与单据头不一致）", () => {
  assert.match(editor, /disabled=\{Boolean\(editingId\)\}/, "编辑草稿时生产单下拉必须禁用");
  assert.match(editor, /该草稿已绑定当前生产单/, "要告诉用户为什么不能换单");
});

test("同一物料只能一行：可选物料都用完时禁用「添加行」并在保存前先校验", () => {
  assert.match(editor, /const allMaterialsUsed = bomMaterialOptions\.length > 0/);
  assert.match(editor, /disabled=\{allMaterialsUsed\}/);
  assert.match(panel, /disabled=\{allMaterialsUsed\}/);
  assert.match(editor, /同一物料只能有一行/, "全屏编辑页要先拦重复物料");
  assert.match(panel, /同一物料只能有一行/, "领料面板也要先拦重复物料");
});

test("一个生产单可以开多张领料单/补料单：三处界面都要有「再建/新建」入口", () => {
  // 单据列表：每行可以直接为该生产单续开领料单与补料单
  assert.match(listPage, /再建领料单<\/Link>/, "列表行内要有「再建领料单」");
  assert.match(listPage, /再建补料单<\/Link>/, "列表行内要有「再建补料单」");
  assert.match(listPage, /movementEditorHref\("issue", \{ productionOrderId: slip\.productionOrderId \}\)/, "续开领料单时带上该行的生产单");
  assert.match(listPage, /movementEditorHref\("replenishment", \{ productionOrderId: slip\.productionOrderId \}\)/, "续开补料单时带上该行的生产单");
  assert.match(listPage, /same production order can hold multiple slips|同一生产单可开多张领料单与补料单/, "页面要说明可开多张");
  // 列表页顶部：新建入口
  assert.match(listPage, /新建领料单<\/Link>/);
  assert.match(listPage, /新建补料单<\/Link>/);
  // 生产单详情：带本单 ID 的新建入口
  const detailPage = read("components", "production", "production-order-detail-page.tsx");
  assert.match(detailPage, /material-issues\/new\?production_order_id=\$\{order\.id\}/, "生产单详情要有新建领料单入口");
  assert.match(detailPage, /material-issues\/new\?type=replenishment&production_order_id=\$\{order\.id\}/, "生产单详情要有新建补料单入口");
  // 仓库页：同样两个入口
  assert.match(warehouse, /<Link href="\/production\/material-issues\/new">新建领料单<\/Link>/);
  assert.match(warehouse, /<Link href="\/production\/material-issues\/new\?type=replenishment">新建补料单<\/Link>/);
  // 深链过滤：列表页要按 URL 里的 production_order_id 预筛选
  assert.match(listPage, /new URLSearchParams\(window\.location\.search\)\.get\("production_order_id"\)/, "列表页要支持按生产单深链筛选");
});
