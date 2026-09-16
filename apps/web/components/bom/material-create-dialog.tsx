"use client";

// 共享的「新建物料」弹窗：BOM 表在哪个模块被打开，就能在哪里就地建物料。
//
// 为什么抽成组件（2026-09-16 用户问「BOM 表的新建物料按钮怎么不见了」）：
//   BOM 工作区（components/bom/bom-workbench.tsx）由采购与生产共用，一共三个入口，
//   而「新建物料」原来是各页自己接的：采购→BOM表、采购单→编辑BOM表 把 onCreateMaterial
//   接成了空函数（**按钮在、点了没反应**），生产→BOM表 干脆不传（按钮不渲染）。
//   于是现场改 BOM 时想补一个物料，要么跳到物料清单页建完再回来，要么点了没反应。
//
// 现在三处入口都挂这个组件：填完直接回填到 BOM 当前行，页面上已经打开的东西不用丢。
// 物料清单页（采购 → 物料清单）也复用它 —— 全站只有一份「新建物料」表单，字段与校验不会漂移。
//
// 新建单位：默认单位是必填的，而现场常见的是「这个单位池里还没有」（打、个、码之外的计量）。
// ActionDialog 的「新增类目」按钮会把**当前表单值**一起交给 onAddCategory，
// 所以这里先存下草稿、切到「新建单位」页，建完再切回来并把 id 填进默认单位（已填字段都在草稿里）。
// 用「换页」而不是叠两层弹窗：Radix 的两个模态弹窗同时开着会互相抢焦点。
import { useRef, useState } from "react";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { ApiClientError, apiPost } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";

export type MaterialRef = {
  id: string;
  materialCode?: string;
  code?: string;
  name?: string;
  specificationModel?: string | null;
  color?: string | null;
  materialType?: string;
  defaultUnitId?: string;
  isActive?: boolean;
  remark?: string | null;
};

export type MaterialUnitRef = { id: string; name?: string; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

/** 物料类型的中文名（列表与搜索都按这个说法）。 */
export const materialTypeLabel = (materialType?: string | null) => (materialType === "finished_product" ? "成品" : "原料");

export function MaterialCreateDialog({
  open,
  units,
  onOpenChange,
  onCreated,
  onUnitCreated,
}: {
  open: boolean;
  units: MaterialUnitRef[];
  onOpenChange: (open: boolean) => void;
  /** 创建成功后回调：调用方负责把新物料放进自己的物料池 / 回填到 BOM 行。 */
  onCreated: (material: MaterialRef) => void;
  /** 顺带新建的单位：调用方把它并进自己的单位池，后续下拉才有它。 */
  onUnitCreated?: (unit: MaterialUnitRef) => void;
}) {
  const [mode, setMode] = useState<"material" | "unit">("material");
  // 草稿 = 已填的物料字段。切到「新建单位」时整份带走，回来时作为 defaultValue 还原。
  const [draft, setDraft] = useState<Record<string, string>>({});
  // 单位建好后我们会**主动**切回物料页，而 ActionDialog 提交成功后还会再喊一次
  // onOpenChange(false)：那一次不是「用户关窗」，不能当成关窗处理，
  // 否则 requestClose 会把刚建好的单位选中态和整份草稿一起清掉。
  const keepOpenRef = useRef(false);

  function requestClose() {
    keepOpenRef.current = false;
    setMode("material");
    setDraft({});
    onOpenChange(false);
  }

  if (mode === "unit") {
    return (
      <ActionDialog
        // key：两个页面都有名叫 name 的字段，ActionDialog 是按字段名保留旧值的，
        // 不换实例的话「新建单位」的名称框会带着物料的名称（实测会拼成「伞骨打」）。
        key="unit-dialog"
        open
        title="新建单位"
        submitLabel="保存单位"
        fields={[{ name: "name", label: "单位名称", required: true }, { name: "remark", label: "备注", type: "textarea" }]}
        onOpenChange={(next) => {
          if (next) return;
          if (keepOpenRef.current) { keepOpenRef.current = false; return; }
          requestClose();
        }}
        onSubmit={async (values) => {
          try {
            const result = await apiPost<MaterialUnitRef>("/units", { name: values.name, remark: values.remark || undefined });
            onUnitCreated?.(result.data);
            notifySuccess("单位已创建");
            // 回到物料表单，并把刚建的单位预选上（其余字段从草稿还原）
            keepOpenRef.current = true;
            setDraft({ ...draft, default_unit_id: result.data.id });
            setMode("material");
          } catch (cause) {
            notifyError(messageOf(cause, "单位创建失败"));
            // 抛出去：ActionDialog 会保持弹窗打开并显示原因，用户不用重新填
            throw cause;
          }
        }}
      />
    );
  }

  const unitOptions = units.filter((unit) => unit.isActive !== false).map((unit) => ({ value: unit.id, label: unit.name ?? unit.id }));
  const fields: ActionField[] = [
    { name: "code_mode", label: "编码方式", type: "select", required: true, defaultValue: draft.code_mode || "auto", options: [{ value: "auto", label: "自动生成" }, { value: "manual", label: "手动填写" }] },
    { name: "material_code", label: "物料编码", defaultValue: draft.material_code, placeholder: "自动生成时留空" },
    { name: "name", label: "物料名称", required: true, defaultValue: draft.name, placeholder: "同名不同规格/颜色可以并存" },
    { name: "specification_model", label: "规格型号", defaultValue: draft.specification_model },
    { name: "color", label: "颜色", defaultValue: draft.color },
    { name: "default_unit_id", label: "默认单位", type: "select", required: true, defaultValue: draft.default_unit_id, options: unitOptions, placeholder: unitOptions.length ? "请选择单位" : "单位池为空，先新建单位" },
    { name: "material_type", label: "物料类型", type: "select", required: true, defaultValue: draft.material_type || "raw_material", options: [{ value: "raw_material", label: "原料" }, { value: "finished_product", label: "成品" }] },
    { name: "remark", label: "备注", type: "textarea", defaultValue: draft.remark },
  ];

  return (
    <ActionDialog
      key="material-dialog"
      open={open}
      title="新建物料"
      submitLabel="保存物料"
      fields={fields}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onAddCategory={(field, values) => {
        // 只有「默认单位」有就地新建的意义（物料编码/名称没有可新建的类目）。
        if (field.name !== "default_unit_id") return;
        setDraft(values);
        setMode("unit");
      }}
      onSubmit={async (values) => {
        try {
          const result = await apiPost<MaterialRef>("/materials", {
            ...values,
            material_code: values.material_code || undefined,
            specification_model: values.specification_model || undefined,
            color: values.color || undefined,
            material_type: values.material_type || "raw_material",
            remark: values.remark || undefined,
          });
          notifySuccess(`物料已创建：${result.data.materialCode ?? result.data.code ?? result.data.name ?? ""}`);
          setDraft({});
          setMode("material");
          // 回调里调用方会关掉本弹窗（并回填到目标位置），所以这里不再自己调 onOpenChange
          onCreated(result.data);
        } catch (cause) {
          notifyError(messageOf(cause, "物料创建失败"));
          throw cause;
        }
      }}
    />
  );
}
