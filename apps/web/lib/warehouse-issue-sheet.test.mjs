// 领料/补料表单的三项行为守卫（用户明确要求，且都是"看不见就会退化"的实现细节）：
// 1) 物料下拉必须引用该生产单订单的 BOM 明细，而不是全部物料；
// 2) 表单要有横向滚动条（否则列多时被压死，没有拖动条）；
// 3) 已过账的领料/补料单要能"回退草稿"继续编辑。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const warehouse = readFileSync(join(webRoot, "app", "warehouse", "page.tsx"), "utf8");
const css = readFileSync(join(webRoot, "app", "globals.css"), "utf8");

test("物料下拉引用生产单订单的 BOM 明细（不能再列出全部物料）", () => {
  assert.equal(/materials\.map\(/.test(warehouse), false, "表单里不得再直接用全部物料作为下拉选项");
  assert.match(warehouse, /apiGet<\{ items: BomItem\[\] \}>\(`\/boms\/\$\{bomId\}`\)/, "必须按 bomId 拉取 BOM 明细");
  const uses = warehouse.match(/bomMaterialOptions\.length \? bomMaterialOptions\.map\(/g) ?? [];
  assert.equal(uses.length, 2, "领料单与补料单两处下拉都要用 BOM 明细，当前只有 " + uses.length + " 处");
  assert.match(warehouse, /changeIssueOrder/, "切换生产单时必须重新加载该订单的 BOM");
});

test("表单表格设置了最小宽度，横向滚动条才会出现", () => {
  assert.match(css, /\.material-issue-sheet \.data-table \{[^}]*min-width: 1180px/, "领料单表单表格需要最小宽度");
  assert.match(css, /\.material-issue-sheet\.material-replenishment-sheet \.data-table \{[^}]*min-width: 720px/, "补料单列少，单独给较小的最小宽度");
  assert.match(css, /\.material-issue-sheet \.table-wrap[\s\S]{0,80}overflow-x: auto/, "滚动容器必须允许横向滚动");
  assert.match(warehouse, /className="material-issue-sheet material-replenishment-sheet"/, "补料单表单要带自己的样式类");
});

test("已过账的领料/补料单支持回退草稿，且必须填原因", () => {
  assert.match(warehouse, /\/production\/material-movements\/\$\{movement\.id\}\/reopen/, "必须调用回退草稿接口");
  assert.match(warehouse, /label: "回退原因（退回草稿后库存会相应回补）", type: "textarea", required: true/, "回退原因必填");
  assert.match(warehouse, /\["issue", "replenishment"\]\.includes\(row\.original\.documentType\)[\s\S]{0,200}?>回退草稿<\/Button>/, "只有领料/补料单显示回退按钮");
});
