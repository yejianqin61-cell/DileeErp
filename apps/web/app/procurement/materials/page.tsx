"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { FileInput } from "../../../components/ui/file-input";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { createdByColumn, updatedByColumn, type AuditRow } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { downloadFile } from "../../../lib/download";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import {
  MATERIAL_IMPORT_ACCEPT, MATERIAL_IMPORT_COLUMNS, MATERIAL_IMPORT_PATH, MATERIAL_IMPORT_TEMPLATE_FILENAME,
  MATERIAL_IMPORT_TEMPLATE_PATH, materialImportErrorField, materialImportOutcome, materialImportSummary,
  type MaterialImportResult,
} from "../../../lib/material-import";
import { MaterialCreateDialog } from "../../../components/bom/material-create-dialog";
import { MaterialImageUploader } from "../../../components/procurement/material-image";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type MaterialImageRow = { id: string; width: number; height: number; byteSize: number; sha256: string; updatedAt: string };
type Reference = AuditRow & { id: string; materialCode?: string; code?: string; name?: string; specificationModel?: string | null; color?: string | null; isActive?: boolean; defaultUnitId?: string; materialType?: string; remark?: string | null; image?: MaterialImageRow | null };
type Unit = { id: string; name?: string; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * 物料清单表的列宽（百分比，总和正好 100%）。
 *
 * 用户 2026-10-08：「物料清单太宽了，表格所有列宽限定长度，超过就省略显示，鼠标hover才显示所有文字。
 * 尽量保证所有column一次性展示。」—— 十列各给一个显式宽度，`DataTable` 一旦看到有列带 `meta.width`
 * 就给 `<table>` 加上 `data-table-fixed`（components/data/data-table.tsx），固定布局下内容再也撑不宽列；
 * 总和恰好 100% 时表宽 = 容器宽，「一次性展示」于是由布局保证，而不是靠文本恰好不长。
 *
 * 每个数字的来历（真实 Chromium 实测见 docs/design/materials-table-column-widths-2026-10-08.md）：
 *   - 物料编码 / 物料名称 / 规格型号 / 颜色 / 默认单位：**文本列**，超长的部分省略号、hover 看全文
 *     （`title` 由 DataTable 按 `meta.ellipsis` 加，取的就是这一格渲染出来的那串字）；
 *   - 图片 15%：一行里要放 40px 缩略图 +「换图」+「删除图片」，单行需要 162px；操作 13%：
 *     编辑 / 停用 / 删除三个按钮单行需要 142px（实测值）。这两列装的是**控件**不是文字，
 *     `action-row` 自己会换行，缺的是宽度而不是省略号（也不给 title：把按钮文案拼成一句提示
 *     比没有更让人困惑，见 data-table.tsx 的注释）。1600 屏（内容宽 1268px）上这两列拿到 190/165px，
 *     三个控件一行放得下；1366 屏（1034px）只有 155/134px，会折成两行、行高 44 → 80px ——
 *     这是"宁可让按钮折行、也不把文本列压到看不清"的取舍（把宽度让给文本列，编码/名称才不至于一上来就被省略）。
 *   - 创建人 / 最后修改人各 8%：姓名 + 次行小字时间（配合 globals.css 里的同名规则），
 *     两行布局实测需要 58.7px，8% 在 1366 屏有 82.7px（内容 66.7px）。
 * 改数字之前先看那张实测表：总和不等于 100% 时，少掉的那一列由浏览器自动分摊，
 * 长名字会重新把别的列挤窄 —— 那正是用户报的这个毛病。
 */
const COLUMN_WIDTH = {
  materialCode: "12%",
  materialName: "14%",
  specificationModel: "11%",
  color: "7%",
  unit: "7%",
  image: "15%",
  status: "5%",
  // 这两列的键名刻意不叫 createdBy / updatedBy：`lib/audit-columns-coverage.test.mjs` 有一条守卫
  // 抓「JSX 里直接渲染 xxx.createdBy」（那会显示 UUID），键名撞上去会被误判。
  auditCreated: "8%",
  auditUpdated: "8%",
  actions: "13%",
} as const;

export default function MaterialsPage() {
  const [materials, setMaterials] = useState<Reference[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // 物料池的关键字搜索（用户 2026-09-16：「所有池子，都要支持搜索」）：
  // 与供应商池等共用 lib/fuzzy-search 的匹配语义（多词 AND、忽略大小写与空白）。
  const [query, setQuery] = useState("");
  // 「新建物料」弹窗（共享组件）：打开时是新建，关闭即销毁，草稿不跨次保留。
  const [creating, setCreating] = useState(false);
  // 「批量导入物料」（用户 2026-09-20）：上传中 + 上一次的逐行结果（整份留在页面上，不做成一条 toast）。
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<MaterialImportResult | null>(null);
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);

  // 默认单位在物料表里存的是 id，人搜的是单位名（「米」），所以这里先把名字解析出来再参与匹配。
  const unitNameOf = (unitId?: string | null) => units.find((unit) => unit.id === unitId)?.name ?? "";
  const visible = useMemo(
    () => materials.filter((item) => fuzzyMatch(query, [item.materialCode, item.code, item.name, item.specificationModel, item.color, unitNameOf(item.defaultUnitId), item.materialType === "finished_product" ? "成品" : "原料", item.remark])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unitNameOf 只读 units，下面已把 units 列为依赖
    [materials, units, query],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [ms, us] = await Promise.all([apiGet<Reference[]>("/materials"), apiGet<Unit[]>("/units")]);
      setMaterials(ms.data);
      setUnits(us.data);
    } catch (cause) {
      setError(messageOf(cause, "物料数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  /**
   * 下载导入模板。走 lib/download 的 fetch + blob（带鉴权 cookie，并从 Content-Disposition 解出
   * 中文文件名）—— 直接 `<a href>` 会丢掉 cookie，后端只回 401。
   */
  async function downloadTemplate() {
    try {
      await downloadFile(MATERIAL_IMPORT_TEMPLATE_PATH, MATERIAL_IMPORT_TEMPLATE_FILENAME);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "模板下载失败");
    }
  }

  /**
   * 上传物料清单。
   *
   * 上传的是 multipart（FormData），不能走 apiPost —— 那会把 body JSON 化。
   * 结果整份留在页面上（逐行错误 + 新增清单 + 缺哪些列 + 提示），不做成一条 toast：
   * 「第 7 行默认单位找不到」这类信息必须能逐条看清，否则操作员只能瞎猜。
   */
  async function importMaterials(file: File | undefined) {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(MATERIAL_IMPORT_PATH, { method: "POST", credentials: "include", body: form });
      const body = await response.json();
      if (!response.ok || body.error) throw new ApiClientError(body.error?.code ?? "MATERIAL_IMPORT_FAILED", body.error?.message ?? "导入失败", body.error?.details ?? []);
      const result = body.data as MaterialImportResult;
      setImportResult(result);
      // 导入了才刷新列表（一条都没进时刷新没有意义，反而会把逐行结果挤下去）。
      if (result.imported > 0) await load();
      const outcome = materialImportOutcome(result);
      if (outcome === "success") notifySuccess(materialImportSummary(result));
      else if (outcome === "partial") notifyError(`${materialImportSummary(result)}：未导入的行请看下方逐行原因`);
      else notifyError("没有可导入的行，请按下方逐行原因修改后重传");
    } catch (cause) {
      notifyError(messageOf(cause, "物料导入失败"));
    } finally {
      setImporting(false);
    }
  }

  async function action(path: string, body?: unknown, success = "操作已完成", method: "POST" | "PATCH" = "POST") {
    setError("");
    try {
      if (method === "PATCH") await apiRequest(path, { method, body: JSON.stringify(body) });
      else await apiPost(path, body);
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  const unitOptions = units.filter((u) => u.isActive !== false).map((u) => ({ value: u.id, label: u.name ?? u.id }));

  // 「新建物料」不再是本页自己的一份表单：用共享的 MaterialCreateDialog（BOM 表三处入口也用它），
  // 全站只有一份字段与校验，避免「物料清单里能建、BOM 表里建不出来」这种漂移。
  // 「新建单位」的联动（默认单位 + 新增类目）由该组件内部完成。

  function editMaterial(item: Reference) {
    setCategoryDialog({
      title: "编辑物料",
      fields: [
        { name: "material_code", label: "物料编码", required: true, defaultValue: item.materialCode ?? item.code ?? "" },
        { name: "name", label: "物料名称", required: true, defaultValue: item.name ?? "" },
        { name: "specification_model", label: "规格型号", defaultValue: item.specificationModel ?? "" },
        { name: "color", label: "颜色", defaultValue: item.color ?? "" },
        { name: "default_unit_id", label: "默认单位", type: "select", required: true, defaultValue: item.defaultUnitId, options: unitOptions },
        { name: "material_type", label: "物料类型", type: "select", required: true, defaultValue: item.materialType ?? "raw_material", options: [{ value: "raw_material", label: "原料" }, { value: "finished_product", label: "成品" }] },
      ],
      submit: async (v) => {
        await apiRequest(`/materials/${item.id}`, { method: "PATCH", body: JSON.stringify({ ...v, specification_model: v.specification_model || null, color: v.color || null }) });
        setCategoryDialog(null);
        setMessage("物料已更新");
        await load();
      },
    });
  }

  function deleteMaterial(id: string) {
    setDialog({
      title: "删除物料",
      fields: [{ name: "confirm", label: "确认删除该物料？（被 BOM 或采购单引用的物料会被拒绝删除）", required: true, placeholder: "输入 删除 确认" }],
      submit: async (v) => {
        if (v.confirm?.trim() !== "删除") throw new Error("请输入\u201c删除\u201d确认");
        await apiRequest(`/materials/${id}`, { method: "DELETE" });
        notifySuccess("物料已删除");
        await load();
      },
    });
  }

  const columns: ColumnDef<Reference>[] = [
    { accessorKey: "materialCode", header: "物料编码", meta: { width: COLUMN_WIDTH.materialCode, ellipsis: true } },
    { accessorKey: "name", header: "物料名称", meta: { width: COLUMN_WIDTH.materialName, ellipsis: true } },
    { accessorKey: "specificationModel", header: "规格型号", meta: { width: COLUMN_WIDTH.specificationModel, ellipsis: true }, cell: ({ row }) => row.original.specificationModel ?? "-" },
    { accessorKey: "color", header: "颜色", meta: { width: COLUMN_WIDTH.color, ellipsis: true }, cell: ({ row }) => row.original.color ?? "-" },
    // 「默认单位」用 accessorFn 而不是 `id` + 自定义 cell：DataTable 的省略 title 从**这一格的值**里取
    // （accessorKey / accessorFn 都有值，纯 `id` 写法没有）—— 用 id 写法的话，省略号会出现、
    // 鼠标悬停却什么都没有。屏幕上显示的就是这里的值，两边不会漂。
    { id: "unit", header: "默认单位", meta: { width: COLUMN_WIDTH.unit, ellipsis: true }, accessorFn: (row) => unitNameOf(row.defaultUnitId) || "-" },
    // 图片（用户 2026-09-24）：缩略图 + 上传/换图/删除。空着也是信息 —— 销售单编辑时要按它决定能不能引用图片。
    { id: "image", header: "图片", meta: { width: COLUMN_WIDTH.image }, cell: ({ row }) => <MaterialImageUploader materialId={row.original.id} hasImage={Boolean(row.original.image)} version={row.original.image?.sha256} onChanged={load} /> },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => row.original.isActive === false ? "停用" : "启用" },
    // 两列审计信息（姓名 + 时间）不写成 `...auditColumns()`：那一对工厂不给宽度，
    // 而这张表的每一列都必须有宽度，否则固定布局会把缺口自动分摊给别的列。
    // 用的是同一对工厂（createdByColumn / updatedByColumn），字段与格式仍然只有一份。
    { ...createdByColumn<Reference>(), meta: { width: COLUMN_WIDTH.auditCreated } },
    { ...updatedByColumn<Reference>(), meta: { width: COLUMN_WIDTH.auditUpdated } },
    {
      id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions },
      cell: ({ row }) => (
        <div className="action-row">
          <Button size="sm" variant="secondary" onClick={() => editMaterial(row.original)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => void action(`/materials/${row.original.id}/active`, { is_active: row.original.isActive === false }, row.original.isActive === false ? "物料已启用" : "物料已停用")}>{row.original.isActive === false ? "启用" : "停用"}</Button>
          <Button size="sm" variant="destructive" onClick={() => void deleteMaterial(row.original.id)}>删除</Button>
        </div>
      ),
    },
  ];

  if (loading) return <><PageHeader title="物料清单" breadcrumb={["采购", "物料清单"]} /><LoadingState /></>;
  if (categoryDialog) return <ActionDialog open title={categoryDialog.title} fields={categoryDialog.fields} onOpenChange={(open) => { if (!open) setCategoryDialog(null); }} onSubmit={(values) => { void categoryDialog.submit(values); }} />;

  return (
    <div className="page-root" data-testid="page-procurement-materials">
      <PageHeader title="物料清单" breadcrumb={["采购", "物料清单"]}>
        <div className="page-actions">
          <Button onClick={() => setCreating(true)}>新建物料</Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <MaterialCreateDialog
        open={creating}
        units={units}
        onOpenChange={setCreating}
        onUnitCreated={(unit) => setUnits((items) => [...items, unit])}
        onCreated={(material) => { setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]); setCreating(false); }}
      />
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}

      <section className="panel">
        <div className="panel-heading"><h2>批量导入物料</h2><span className="panel-note">下载模板 → 填写 → 上传；出错的行会逐条告诉你第几行、哪一格、为什么</span></div>
        <div className="panel-body">
          <div className="filter-bar">
            <Button size="sm" variant="secondary" data-testid="material-import-template" onClick={() => void downloadTemplate()}>下载模板</Button>
            <FileInput accept={MATERIAL_IMPORT_ACCEPT} data-testid="material-import-file" disabled={importing} onChange={(event) => { void importMaterials(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          </div>
          {importing && <LoadingState label="正在导入" />}
          {importResult && (
            <div data-testid="material-import-result">
              <p data-testid="material-import-summary" className={materialImportOutcome(importResult) === "success" ? "status-success" : materialImportOutcome(importResult) === "partial" ? "status-warning" : "status-error"}>
                {materialImportSummary(importResult)}
              </p>
              {importResult.missingColumns.length > 0 && <p className="status-error">缺少必需列：{importResult.missingColumns.join("、")}</p>}
              {importResult.ignoredColumns.length > 0 && <p>以下列不属于物料口径，已忽略：{importResult.ignoredColumns.join("、")}</p>}
              {importResult.ignoredTrailingRows > 0 && <p>表尾 {importResult.ignoredTrailingRows} 行未识别为数据，已跳过</p>}
              {importResult.hints.map((hint) => <p key={hint} className="panel-note">{hint}</p>)}
              {importResult.errors.length > 0 && <>
                <h3>未导入的行（共 {importResult.errorCount} 条原因）</h3>
                <DataTable columns={[
                  // 「原因」是整句中文提示，长起来能到一百多个字（nowrap + 自动布局时它一个人就能把这
                  // 张小表顶出面板）。同样按「固定列宽 + 超长省略 + hover 看全文」处理。
                  { accessorKey: "row", header: "Excel 行号", meta: { width: "12%" } },
                  { id: "field", header: "字段", meta: { width: "18%", ellipsis: true }, cell: ({ row }) => materialImportErrorField(row.original) },
                  { accessorKey: "reason", header: "原因", meta: { width: "70%", ellipsis: true } },
                ]} data={importResult.errors} empty={null} tableClassName="materials-page-table" />
              </>}
              {importResult.created.length > 0 && <>
                <h3>已新增的物料（{importResult.created.length} 条）</h3>
                <DataTable columns={[
                  { accessorKey: "row", header: "Excel 行号", meta: { width: "14%" } },
                  { accessorKey: "material_code", header: "物料编码", meta: { width: "30%", ellipsis: true } },
                  { id: "auto", header: "编码来源", meta: { width: "18%" }, cell: ({ row }) => row.original.auto_code ? "自动生成" : "表里填写" },
                  { accessorKey: "name", header: "物料名称", meta: { width: "38%", ellipsis: true } },
                ]} data={importResult.created} empty={null} tableClassName="materials-page-table" />
              </>}
            </div>
          )}
          {!importResult && !importing && (
            <p className="panel-note">
              模板 {MATERIAL_IMPORT_COLUMNS.length} 列：{MATERIAL_IMPORT_COLUMNS.join(" / ")}。
              <strong>物料名称</strong>与<strong>默认单位</strong>必填；<strong>物料编码留空即自动生成</strong>（MAT-当天日期-序号），
              自己填则必须唯一（匹配忽略大小写与空格）。默认单位要填系统里已有的单位名称，写错会逐行报错、不会自动新建单位。
              本导入只新增、不修改已有物料；编码或「名称+规格型号+颜色」撞上库里已有的记录会逐行报错。
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>物料清单</h2>
          <span className="panel-note" data-testid="material-count">共 {materials.length} 个物料（启用 {materials.filter((item) => item.isActive !== false).length} 个），当前列出 {visible.length} 条</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索物料编码、名称、规格型号或颜色<Input data-testid="material-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label>
          </div>
          <DataTable
            columns={columns}
            data={visible}
            tableClassName="materials-page-table"
            empty={query.trim()
              ? <EmptyState title={`没有匹配\u201c${query.trim()}\u201d的物料`} description={`共 ${materials.length} 个物料，换个关键词或清空搜索框。`} />
              : <EmptyState title="暂无物料" />}
          />
        </div>
      </section>
    </div>
  );
}