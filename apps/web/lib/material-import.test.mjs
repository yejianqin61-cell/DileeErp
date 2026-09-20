// 物料清单批量导入的展示口径测试。
//
// 最要紧的一条：**部分成功不许说成全成功**。导入是「行级错误不连坐」的，
// 12 行里进了 10 行、被拒 2 行如果提示成「导入成功」，操作员会以为整批都进去了，
// 那 2 条物料后面开采购单时才会发现不存在 —— 这是最难查的一类错。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MATERIAL_IMPORT_ACCEPT, MATERIAL_IMPORT_COLUMNS, MATERIAL_IMPORT_PATH, MATERIAL_IMPORT_TEMPLATE_FILENAME,
  MATERIAL_IMPORT_TEMPLATE_PATH, materialImportErrorField, materialImportOutcome, materialImportSummary,
} from "./material-import.ts";

const result = (extra = {}) => ({ total: 0, imported: 0, errorCount: 0, created: [], ...extra });

test("结果档位：全成功 / 部分成功 / 一条都没进，三种要能分开", () => {
  assert.equal(materialImportOutcome(result({ total: 3, imported: 3 })), "success");
  assert.equal(materialImportOutcome(result({ total: 3, imported: 1, errorCount: 2 })), "partial");
  assert.equal(materialImportOutcome(result({ total: 3, imported: 0, errorCount: 3 })), "failed");
  assert.equal(materialImportOutcome(result()), "failed", "没有任何行时是 failed，不是 success");
});

test("汇总结论文案：条数、未导入行数、自动生成编码条数都要说出来", () => {
  assert.equal(
    materialImportSummary({ total: 12, imported: 10, errorCount: 2, created: [{ auto_code: true }, { auto_code: false }] }),
    "共 12 行：新增 10 条 / 未导入 2 行 / 其中自动生成编码 1 条",
  );
  assert.equal(materialImportSummary({ total: 3, imported: 3, errorCount: 0, created: [] }), "共 3 行：新增 3 条", "全成功且无自动编码时不拖多余的话");
  assert.equal(materialImportSummary({ total: 2, imported: 0, errorCount: 2, created: [] }), "共 2 行：新增 0 条 / 未导入 2 行");
  // created 缺失（老版本后端）也不能抛错
  assert.equal(materialImportSummary({ total: 1, imported: 1, errorCount: 0 }), "共 1 行：新增 1 条");
});

test("路径与文件名：前缀、接口、accept 与后端一致", () => {
  assert.equal(MATERIAL_IMPORT_TEMPLATE_PATH, "/api/v1/materials/import-template.xlsx");
  assert.equal(MATERIAL_IMPORT_PATH, "/api/v1/materials/import");
  assert.equal(MATERIAL_IMPORT_ACCEPT, ".xlsx,.xls");
  assert.match(MATERIAL_IMPORT_TEMPLATE_FILENAME, /^迪礼ERP-.*\.xlsx$/);
  assert.equal(MATERIAL_IMPORT_COLUMNS.length, 7, "与后端 MATERIAL_TEMPLATE_HEADERS 的 7 列一致");
  assert.deepEqual([...MATERIAL_IMPORT_COLUMNS].slice(0, 2), ["物料编码", "物料名称"]);
});

test("错误行的「字段」列：没有 field 时给占位符，不渲染成 undefined", () => {
  assert.equal(materialImportErrorField({ field: "默认单位" }), "默认单位");
  assert.equal(materialImportErrorField({}), "-");
  assert.equal(materialImportErrorField({ field: undefined }), "-");
});
