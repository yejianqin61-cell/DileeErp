"use client";

// BOM 表工作区（采购与生产共用）。
//
// 为什么抽成共享组件：BOM 现在有两个编辑入口——【采购】按 BOM 下单、【生产】按 BOM 建生产单并领料，
// 两边都要根据现场情况改用量与明细。如果各自实现一套，冲突处理和字段口径必然漂移
// （历史上「规格型号/颜色被 material_snapshot 覆盖」就是这样出现的）。
//
// 并发编辑（本次新增的关口）：
//   打开时记住服务端返回的 `updatedAt`，保存时原样回传 `expected_updated_at`。
//   服务端在事务里取行锁后比对，不一致返回 422 BOM_UPDATE_CONFLICT。
//   前端不重试、不覆盖，而是明确告诉操作者「别人先改了」并给一个重新加载的入口——
//   按宪法「Reversible Business Changes」，不允许静默丢弃别人的现场修正。
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiRequest } from "../../lib/api-client";
import { currencyOptionsWithCurrent, type CurrencyOption } from "../../lib/currency-options";
import { fetchCurrencyOptions } from "../../lib/currency-catalogue";
import { displayText } from "../../lib/display-text";
import { notifyError, notifySuccess } from "../ui/toaster";
import { SupplierSelect, type BomSupplierRef } from "./supplier-select";

export type BomMaterialRef = {
  id: string;
  materialCode?: string;
  code?: string;
  name?: string;
  specificationModel?: string | null;
  color?: string | null;
  materialType?: string;
  defaultUnitId?: string;
  isActive?: boolean;
};

export type BomUnitRef = { id: string; name?: string; isActive?: boolean };

export type BomRow = {
  id?: string;
  materialId: string;
  materialName: string;
  model: string;
  specificationModel?: string | null;
  color?: string | null;
  productionBatchBase?: string | null;
  baseUsage?: string | null;
  requiredQuantity: string;
  unit: string;
  unitId?: string | null;
  materialSnapshot: Record<string, unknown>;
  /** 默认供应商（2026-09-26）：这一行通常找哪家做。备查用，不预填到采购单。 */
  supplierId?: string | null;
  /** 供应商被改名/停用后，用快照显示"当时记的是哪一家"。 */
  supplierSnapshot?: Record<string, unknown> | null;
  /** 只读关系（服务端 include 回来的当前供应商）。 */
  supplier?: { id: string; supplierCode?: string | null; name?: string | null; isActive?: boolean } | null;
  /**
   * 参考单价 + 币种（2026-10-08）：这一行「通常多少钱」。备查 + 预填到采购计划，**不参与任何金额计算**。
   * 服务端回的是 Decimal 字符串（如 `"12.5000"`），空/null 都是「没填」。
   */
  referenceUnitPrice?: string | null;
  referenceCurrency?: string | null;
};

type BomPayload = { id: string; orderNo: string; status: string; version: number; updatedAt?: string; items: BomRow[] };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
/** 规格型号/颜色只在「选择物料 / 新建物料」时引用主数据；保存时不再回填，避免覆盖人工修改。 */
const specOf = (material?: BomMaterialRef | null) => ({ specificationModel: material?.specificationModel ?? "", color: material?.color ?? "" });
/**
 * 服务端回的参考单价是 4 位小数的 Decimal 字符串（`"12.5000"`）：输入框里显示 `12.5` 更好读。
 *
 * 与采购计划的 `trimQuantity` 只差一处：**空字符串保持空**。价格里"没填"与"填了 0"是两个意思
 * （0 价不能下单），把空变成 `"0"` 会让这一格看起来像填过了。
 * 全程按字符串处理，不进 `Number`：金额相关的一律不碰浮点（全站口径）。
 */
const trimPrice = (value?: string | null) => {
  const text = String(value ?? "").trim();
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
};

export function BomWorkbench({ bomId, title, materials, units, onCreateMaterial, onSupplierCreated, showSupplier = true, showReferencePrice = true, onClose, onSaved }: {
  bomId: string;
  title?: string;
  materials: BomMaterialRef[];
  units: BomUnitRef[];
  /** 打开「新建物料」弹窗，并把新物料回填到回调里指定的行（生产模块未开放新建物料时为 undefined）。 */
  onCreateMaterial?: (apply: (material: BomMaterialRef) => void) => void;
  /** 在 BOM 里快速新建了供应商时通知调用方，让它把自己那份供应商池也补上（可选）。 */
  onSupplierCreated?: (supplier: BomSupplierRef) => void;
  /**
   * 要不要显示「默认供应商」这一列（2026-09-27）。
   *
   * 用户原话：「现在，生产模块里面的 BOM 表里面不用填写供应商。」
   * —— 这一列回答的是"这个部件**通常找哪家做**"，是**采购**的知识；生产只关心做多少、
   * 用什么料。所以生产侧显式传 `false`（`app/production/page.tsx`）。
   *
   * 默认 `true`：采购那两个入口本来就要它，而且组件是共用的 —— 默认隐藏会让
   * "这个入口要不要供应商"变成每个新入口都得记得判断一次的事。
   * ⚠️ 隐藏**只影响显示与编辑**：行状态里的 `supplierId` 仍在，保存时会原样回传，
   * 所以生产侧保存 BOM **不会**把采购标过的供应商抹掉（`BomItem.supplier_id` 是
   * "这个部件通常找哪家做"的长期知识，不该因为换了个入口保存就丢）。
   */
  showSupplier?: boolean;
  /**
   * 要不要显示「参考单价」这一列（2026-10-08）。
   *
   * 用户原话：「采购计划要下单需要填写单价，但是BOM表没办法填写单价，检查一下这条链路。尤其是前端。」
   * 用户选定：BOM 行上手填参考单价（含币种），新建采购计划时预填到计划行。
   * 与「默认供应商」同一条判断：这一列回答的是"这个部件**通常多少钱**、找哪家做"，
   * 是**采购**的知识；生产只关心做多少、用什么料，所以生产侧显式传 `false`。
   *
   * 为什么另开一个 prop 而不是复用 `showSupplier`：两个列**现在**恰好同开同关，
   * 但"要不要显示供应商"和"要不要显示价"是两件独立的事（将来生产侧想看见价、或者采购侧
   * 想先不上价，都只需要改一个入口的一个参数），共用一个开关会让下一次改动被迫一起动。
   * ⚠️ 与供应商同理：隐藏**只影响显示与编辑**，行里的价仍在，保存时照旧回传。
   */
  showReferencePrice?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [bom, setBom] = useState<BomPayload | null>(null);
  const [items, setItems] = useState<BomRow[]>([]);
  /** 供应商池由本组件自己取：BOM 的三个入口（采购→BOM表、采购单→编辑BOM、生产→BOM表）不必各自加载一遍。 */
  const [suppliers, setSuppliers] = useState<BomSupplierRef[]>([]);
  /**
   * 币种选项（参考单价的币种格）。与采购计划的收束预览用同一个来源
   * （`lib/currency-catalogue.ts` 的 `fetchCurrencyOptions`：字典接口失败时回落到内置清单）。
   * 生产侧不显示这一列（`showReferencePrice={false}`）时不拉它 —— 少一次请求，也不会有"看不见的输入"。
   */
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setConflict("");
    try {
      const [result, supplierList] = await Promise.all([
        apiGet<BomPayload>(`/boms/${bomId}`),
        // 供应商池拉不到不该让 BOM 打不开：那一列仍能"快速新建"（下拉为空而已）。
        apiGet<BomSupplierRef[]>("/suppliers").catch(() => ({ data: [] as BomSupplierRef[], meta: {} })),
      ]);
      setBom(result.data);
      setItems((result.data.items ?? []).map((item) => ({ ...item, referenceUnitPrice: trimPrice(item.referenceUnitPrice) })));
      setSuppliers(Array.isArray(supplierList.data) ? supplierList.data : []);
    } catch (cause) {
      setError(messageOf(cause, "BOM表加载失败"));
    } finally { setLoading(false); }
  }, [bomId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!showReferencePrice) return;
    let cancelled = false;
    void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencies(options); });
    return () => { cancelled = true; };
  }, [showReferencePrice]);

  const materialOptions = materials.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: `${item.materialCode ?? item.code ?? ""} / ${item.name ?? "物料"}` }));
  /**
   * 物料名称列里触发器**正在显示**的那串字（省略号吃掉长名之后，hover 用它看全文）。
   *
   * 为什么不用 `row.materialName`：触发器显示的是下拉选项的 label（「编码 / 名称」），
   * title 必须与眼睛看到的逐字一致，否则 hover 出来的是另一份东西。
   * 物料被停用/删除时它不在 `materialOptions` 里、触发器本来也退回占位符 —— 那就没有 title。
   */
  const materialLabelOf = (materialId: string) => materialOptions.find((option) => option.value === materialId)?.label ?? "";
  const unitOptions = units.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: item.name ?? item.id }));
  const updateItem = (index: number, patch: Partial<BomRow>) => setItems((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  function changeMaterial(index: number, materialId: string) {
    const material = materials.find((item) => item.id === materialId);
    updateItem(index, { materialId, materialName: material?.name ?? "", ...specOf(material), materialSnapshot: material ?? {} });
  }
  function newRow(material?: BomMaterialRef): BomRow {
    return { materialId: material?.id ?? "", materialName: material?.name ?? "", model: "", ...specOf(material), productionBatchBase: "1", baseUsage: "1", requiredQuantity: "1", unit: "", materialSnapshot: (material ?? {}) as Record<string, unknown>, supplierId: null, supplierSnapshot: null };
  }
  function addRow() {
    const material = materials.find((item) => item.isActive !== false && item.materialType === "raw_material");
    setItems((rows) => [...rows, newRow(material)]);
  }
  function createMaterial() {
    if (!onCreateMaterial) return;
    onCreateMaterial((material) => {
      // 与旧行为一致：已经在编辑明细时把新物料填到当前最后一行；表里没有行时补一行。
      setItems((rows) => rows.length
        ? rows.map((row, index) => (index === rows.length - 1 ? { ...row, materialId: material.id, materialName: material.name ?? "", ...specOf(material), materialSnapshot: material as unknown as Record<string, unknown> } : row))
        : [newRow(material)]);
    });
  }

  async function save() {
    // 参考单价是可选字段，唯一能在前端先拦下的坏值是负数：负价没有任何业务含义，
    // 而服务端会以 INVALID_BOM_ITEM 拒绝**整张表**（保存失败但看不出是哪一行）。
    const negativePrice = items.findIndex((row) => row.referenceUnitPrice !== undefined && row.referenceUnitPrice !== null && row.referenceUnitPrice !== "" && !(Number(row.referenceUnitPrice) >= 0));
    if (negativePrice >= 0) { setError(`第 ${negativePrice + 1} 行的参考单价不能是负数（或直接清空这一格）`); return; }
    setSaving(true); setError("");
    try {
      const result = await apiRequest<BomPayload>(`/boms/${bomId}/items`, {
        method: "PUT",
        body: JSON.stringify({
          items: items.map((row) => ({ material_id: row.materialId, material_name: row.materialName, model: row.model || undefined, specification_model: row.specificationModel || undefined, color: row.color || undefined, production_batch_base: row.productionBatchBase || undefined, base_usage: row.baseUsage || undefined, material_snapshot: row.materialSnapshot, required_quantity: row.requiredQuantity, unit: row.unit, unit_id: row.unitId || undefined, supplier_id: row.supplierId || undefined, // 参考单价：空 = 服务端存 NULL（"没填"），不是 0。
            // 币种**只在有价时**才发：没有价的币种是没有意义的孤儿值（再打开时下拉本来也默认显示 CNY）。
            reference_unit_price: row.referenceUnitPrice || undefined, reference_currency: row.referenceUnitPrice ? (row.referenceCurrency || "CNY") : undefined })),
          // 乐观锁令牌：服务端比对失败会返回 422 BOM_UPDATE_CONFLICT，本组件不覆盖、只提示。
          expected_updated_at: bom?.updatedAt,
        }),
      });
      setBom(result.data);
      setItems((result.data.items ?? []).map((item) => ({ ...item, referenceUnitPrice: trimPrice(item.referenceUnitPrice) })));
      setConflict("");
      notifySuccess("BOM表已保存");
      onSaved?.();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "BOM_UPDATE_CONFLICT") {
        setConflict(cause.message);
      } else {
        notifyError(messageOf(cause, "BOM表保存失败"));
      }
    } finally { setSaving(false); }
  }

  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent className="bom-workbench">
    <SheetHeader>
      <SheetTitle>BOM表 {title ?? bom?.orderNo ?? ""}</SheetTitle>
      <SheetDescription>物料名称、型号、规格型号、颜色、数量、单位和默认供应商可直接编辑；规格型号与颜色在选择物料或新建物料时引用物料主数据，保存后保留人工修改。默认供应商是备查信息（这个部件通常找哪家），不会自动带到采购单。保存会带上打开时的版本，若采购或生产已先改过，会提示你重新加载。</SheetDescription>
    </SheetHeader>
    {loading ? <LoadingState label="正在加载 BOM" /> : <>
      {error && <p className="status-error panel-body" role="alert">{error}<Button size="sm" variant="secondary" onClick={() => void load()}>重新加载</Button></p>}
      {conflict && <div className="panel panel-body status-error" data-testid="bom-conflict" role="alert">
        <p>{conflict}</p>
        <p className="panel-note">你这次改的内容还在屏幕上，没有被写入。重新加载会放弃本地改动并显示最新版本。</p>
        <Button size="sm" variant="secondary" onClick={() => void load()}>重新加载最新版本（放弃本次修改）</Button>
      </div>}
      <div className="page-actions">
        {onCreateMaterial && <Button size="sm" variant="secondary" onClick={createMaterial}>新建物料</Button>}
        <Button size="sm" variant="secondary" onClick={addRow}>添加行</Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? "保存中..." : "保存BOM表"}</Button>
      </div>
      {!onCreateMaterial && <p className="panel-note">物料池由【采购 → 物料清单】维护；这里可以直接改用量、单位、规格型号与颜色。</p>}
      {showReferencePrice && <p className="panel-note" data-testid="bom-price-hint">「参考单价」是这个部件通常多少钱：填了之后，新建采购计划时会自动预填到计划行的单价（采购员仍按实际报价改）；留空就是还没谈价，计划行单价为 0、不能下单。</p>}
      {/*
        2026-10-08（用户）：「BOM表页面，物料名称一长，后面的column就被压缩很窄。这很不好。我要求，
        扩大BOM表悬浮居中页面的占页面大小，并且固定物料名称这一列的宽度。一旦字数超出，就省略显示，
        鼠标hover时显示全部文字。」

        两个东西各占一半，缺一不可：
          · `.bom-table` 上的 `table-layout: fixed` + 每列显式宽度（globals.css）——列宽不再由内容决定，
            长物料名撑不宽自己、也就挤不窄别人。**列宽必须写在 CSS 里**：`width` 在 auto 布局下只是"建议"，
            内容一长就被推翻（这正是"被压缩很窄"的机理）。
          · 物料名称列的 `title`（下面每行的 SelectTrigger）——省略号把字吃掉之后，hover 要有地方看全文。
            文案取 `materialOptions` 的 label，与触发器里显示的**同一份字符串**，不会两处不一致。
      */}
      <div className="table-wrap"><table className="data-table bom-table"><thead><tr><th className="bom-col-index">序号</th><th className="bom-col-material">物料名称</th><th className="bom-col-model">型号</th><th className="bom-col-spec">规格型号</th><th className="bom-col-color">颜色</th><th className="bom-col-quantity">数量</th><th className="bom-col-unit">单位</th>{showSupplier && <th className="bom-col-supplier">供应商</th>}{showReferencePrice && <th className="bom-col-price">参考单价</th>}<th className="bom-col-action"><span className="sr-only">操作</span></th></tr></thead><tbody>{items.map((row, index) => <tr key={row.id ?? `${row.materialId}-${index}`}>
        <td className="bom-col-index">{index + 1}</td>
        <td className="bom-col-material"><Select value={row.materialId || undefined} onValueChange={(value) => changeMaterial(index, value)}><SelectTrigger data-testid={`bom-material-${index}`} title={materialLabelOf(row.materialId) || undefined}><SelectValue placeholder="请选择物料" /></SelectTrigger><SelectContent>{materialOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></td>
        <td className="bom-col-model"><Input value={row.model ?? ""} onChange={(event) => updateItem(index, { model: event.target.value })} /></td>
        <td className="bom-col-spec"><Input value={row.specificationModel ?? ""} onChange={(event) => updateItem(index, { specificationModel: event.target.value })} /></td>
        <td className="bom-col-color"><Input value={row.color ?? ""} onChange={(event) => updateItem(index, { color: event.target.value })} /></td>
        <td className="bom-col-quantity"><Input type="number" min="0" step="0.0001" value={row.requiredQuantity} onChange={(event) => updateItem(index, { requiredQuantity: event.target.value })} /></td>
        <td className="bom-col-unit"><Select value={row.unitId ?? undefined} onValueChange={(value) => updateItem(index, { unitId: value, unit: units.find((unit) => unit.id === value)?.name ?? value })}><SelectTrigger><SelectValue placeholder={row.unit || "选择单位"} /></SelectTrigger><SelectContent>{unitOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></td>
        {/*
          默认供应商（2026-09-26）：下拉里搜不到可以就地新建（见 SupplierSelect）。
          停用/已删的供应商在列表里找不到，但**当行已有值**时要显示得出来 —— 否则用户会以为这一格空了，
          一保存就把记录抹掉。所以占位优先用当前关系，其次用快照。

          2026-09-27：生产侧不显示这一列（`showSupplier={false}`，用户：「生产模块里面的 BOM 表里面
          不用填写供应商」）。注意**行状态里的值不因此清空**，保存时照旧回传 —— 生产侧保存 BOM
          不会把采购标过的供应商抹掉。
        */}
        {showSupplier && <td data-testid={`bom-supplier-${index}`} className="bom-col-supplier">
          <SupplierSelect
            value={row.supplierId ?? ""}
            suppliers={row.supplierId && !suppliers.some((supplier) => supplier.id === row.supplierId) && (row.supplier ?? row.supplierSnapshot) ? [...suppliers, { id: row.supplierId, supplierCode: row.supplier?.supplierCode ?? (row.supplierSnapshot?.supplierCode as string | undefined) ?? null, name: row.supplier?.name ?? (row.supplierSnapshot?.name as string | undefined) ?? "（已停用的供应商）", isActive: true }] : suppliers}
            onChange={(supplierId) => updateItem(index, { supplierId })}
            onCreated={(supplier) => { setSuppliers((current) => (current.some((item) => item.id === supplier.id) ? current : [...current, supplier])); onSupplierCreated?.(supplier); }}
            testId={`bom-supplier-select-${index}`}
          />
        </td>}
        {/*
          参考单价（2026-10-08，用户：「采购计划要下单需要填写单价，但是BOM表没办法填写单价，
          检查一下这条链路。尤其是前端。」）。

          这一格是"这个部件通常多少钱"，与左边的供应商配对：**备查 + 预填到采购计划**，
          不参与任何金额计算（成本/毛利/应付一律取采购单上的实际单价，取价口径没变）。
          所以它没有校验"必须 > 0"：没谈价就留空，采购员到计划里按实际报价填。

          币种紧挨着价：不记币种的话，一笔美元报价预填进计划会让"计划合计按币种分列"说谎。
          币种只显示代码（`CNY`）而不是「CNY 人民币」—— 这一格要跟输入框挤在同一列里，
          汉字标签会把价挤到看不见；代码本身没有歧义，label 留在 hover 与下拉里。
        */}
        {showReferencePrice && <td data-testid={`bom-price-cell-${index}`} className="bom-col-price">
          <div className="bom-price-cell">
            <Select value={row.referenceCurrency || "CNY"} onValueChange={(value) => updateItem(index, { referenceCurrency: value })}>
              <SelectTrigger data-testid={`bom-price-currency-${index}`} aria-label={`第 ${index + 1} 行参考单价的币种`}><SelectValue /></SelectTrigger>
              <SelectContent>{currencyOptionsWithCurrent(currencies, row.referenceCurrency || "CNY").map((option) => <SelectItem key={option.value} value={option.value}>{option.value}</SelectItem>)}</SelectContent>
            </Select>
            <Input type="number" min="0" step="0.0001" data-testid={`bom-price-${index}-input`} aria-label={`第 ${index + 1} 行参考单价`} placeholder="未填" value={row.referenceUnitPrice ?? ""} onChange={(event) => updateItem(index, { referenceUnitPrice: event.target.value })} />
          </div>
        </td>}
        <td className="bom-col-action"><Button size="icon" variant="ghost" title="删除行" aria-label="删除行" onClick={() => setItems((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={16} /></Button></td>
      </tr>)}</tbody></table></div>
      {!items.length && <p className="panel-note">这张 BOM 还没有明细行：点「添加行」或「新建物料」开始录入。</p>}
      <p className="panel-note">状态：{bom ? String(displayText(bom.status)) : "-"}　版本：{bom?.version ?? "-"}　最后更新：{bom?.updatedAt ? String(bom.updatedAt).slice(0, 19).replace("T", " ") : "-"}</p>
    </>}</SheetContent></Sheet>;
}
