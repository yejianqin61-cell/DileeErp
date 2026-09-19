// 采购单「打印信息」的口径（纯函数，无 React / 无网络依赖）。
//
// 用户 2026-09-16：「付款方式，有月结30天，月结60天，当月付款」+「系统中采购单也要支持对这些字段
// 进行填写和设置」。付款方式在这里是**固定三项**（用户选定），但后端只按文本存（不做枚举校验），
// 所以以后要加「月结90天」只需要改这一处，不用动接口与数据库。
//
// 为什么单独成模块：ActionDialog 的 select 不接受空串 value（Radix 的约束），而「付款方式」是可选字段
// —— 清空需要一个哨兵值，而这个哨兵值必须在**提交前**换回空串（空串在服务端表示「清除这一格」）。
// 这段转换逻辑放在页面里只能靠渲染测试间接覆盖，抽成纯函数后 lib 测试可以直接推演边界。

/** Radix Select 不接受空串 value，用哨兵代表「不填”。 */
export const PAYMENT_TERM_CLEAR = "__none__";

/** 业务给的三项（用户 2026-09-16）。 */
export const PURCHASE_PAYMENT_TERMS = ["月结30天", "月结60天", "当月付款"] as const;

/**
 * 下拉选项。已有值不在三项里时（手填或以后加过项）**照样列出来**，
 * 否则打开弹窗会看到空白下拉、感觉「我填的付款方式丢了」。
 */
export function paymentTermOptions(current?: string | null): Array<{ value: string; label: string }> {
  const options = [{ value: PAYMENT_TERM_CLEAR, label: "（不填）" }, ...PURCHASE_PAYMENT_TERMS.map((term) => ({ value: term, label: term }))];
  const value = (current ?? "").trim();
  return value && !PURCHASE_PAYMENT_TERMS.includes(value as typeof PURCHASE_PAYMENT_TERMS[number])
    ? [...options, { value, label: `${value}（当前值）` }]
    : options;
}

/** 当前值 → 下拉可用的值（空 / 全空白 → 哨兵）。 */
export function paymentTermValue(current?: string | null): string {
  const value = (current ?? "").trim();
  return value || PAYMENT_TERM_CLEAR;
}

/** 下拉值 → 提交值：哨兵还原成空串（服务端把空串当「清除这一格」）。 */
export function paymentTermPayload(selected: string | undefined): string {
  return !selected || selected === PAYMENT_TERM_CLEAR ? "" : selected.trim();
}

/**
 * 「打印信息」弹窗的 8 个字段 → PATCH /purchase-orders/:id/print-fields 的请求体。
 *
 * 三件事必须在这里定死，否则每处调用都会各写一遍、迟早漂移：
 *   - 未填的文本一律提交**空串**（服务端把空串存成 null = 这一格不印字），不是 undefined
 *     —— undefined 在服务端表示「这一格不要动」，删空一格却什么都没发生，用户会以为没保存上；
 *   - 交货日期空 → `null`（日期列，服务端用它清空）；
 *   - 只提交这 8 个键（PATCH 是白名单校验，多一个键就 400）。
 */
export function printFieldsPayload(values: Record<string, string>): Record<string, string | null> {
  return {
    payment_terms: paymentTermPayload(values.payment_terms),
    delivery_terms: values.delivery_terms ?? "",
    delivery_address: values.delivery_address ?? "",
    expected_date: (values.expected_date ?? "").trim() || null,
    remark: values.remark ?? "",
    supplier_reply: values.supplier_reply ?? "",
    supplier_signed: values.supplier_signed ?? "",
    supervisor_signature: values.supervisor_signature ?? "",
  };
}

/** 采购单（列表/详情返回的行）→ 弹窗初值。 */
export type PurchaseOrderPrintSource = {
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  deliveryAddress?: string | null;
  expectedDate?: string | null;
  remark?: string | null;
  supplierReply?: string | null;
  supplierSigned?: string | null;
  supervisorSignature?: string | null;
};

export function printFieldsDefaults(order: PurchaseOrderPrintSource): Record<string, string> {
  return {
    payment_terms: paymentTermValue(order.paymentTerms),
    delivery_terms: order.deliveryTerms ?? "",
    delivery_address: order.deliveryAddress ?? "",
    expected_date: (order.expectedDate ?? "").slice(0, 10),
    remark: order.remark ?? "",
    supplier_reply: order.supplierReply ?? "",
    supplier_signed: order.supplierSigned ?? "",
    supervisor_signature: order.supervisorSignature ?? "",
  };
}
