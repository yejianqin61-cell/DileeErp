import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

// 成品 QC 数量的业务规则。
//
// 这些规则以前抛的是普通 Error，Nest 会把它当成未处理异常返回 **500 服务器内部错误**：
// 客户在「录入成品质检」时数量没配平（例如 检验 10 / 合格 8 / 不合格 3）或某个数量留空，
// 界面上只能看到「服务器内部错误」，完全不知道哪里填错了。现在统一抛 422 并带上可执行的中文提示。

export const FINISHED_GOODS_SUBMISSION_STATUSES = ["draft", "submitted", "inspecting", "qc_completed", "cancelled", "corrected"] as const;
export type FinishedGoodsSubmissionStatus = (typeof FINISHED_GOODS_SUBMISSION_STATUSES)[number];

export const FINISHED_GOODS_QC_CONCLUSIONS = ["qualified", "conditional_accepted", "rejected", "mixed"] as const;
export type FinishedGoodsQcConclusion = (typeof FINISHED_GOODS_QC_CONCLUSIONS)[number];

export type QcQuantities = {
  inspected_quantity: string;
  qualified_quantity: string;
  conditional_accept_quantity: string;
  rejected_quantity: string;
};

export type QcQuantityResult = QcQuantities & {
  conclusion: FinishedGoodsQcConclusion;
};

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const QUANTITY_FIELD_LABELS: Record<string, string> = {
  inspected_quantity: "本次检验数量",
  qualified_quantity: "合格数量",
  conditional_accept_quantity: "条件接收数量",
  rejected_quantity: "不合格数量",
  already_inbound: "已入库数量",
};

function ruleError(code: string, message: string, details: Array<Record<string, unknown>> = []) {
  return new UnprocessableEntityException({ code, message, details });
}

function decimal(value: string, field: string) {
  const label = QUANTITY_FIELD_LABELS[field] ?? field;
  if (typeof value !== "string" || value.trim() === "" || !decimalPattern.test(value.trim())) {
    throw ruleError("INVALID_QC_QUANTITY", `${label}必须填写为不小于 0 的数字（不能留空）`, [{ field }]);
  }
  // 与送检数量同一口径：最多 4 位小数。否则会被 DECIMAL(18,4) 静默四舍五入，
  // 出现「界面填的数」与「库里存的数」不一致、甚至配平校验通过的假象。
  const fraction = value.trim().split(".")[1] ?? "";
  if (fraction.length > 4) throw ruleError("INVALID_QC_QUANTITY", `${label}最多 4 位小数`, [{ field }]);
  return new Prisma.Decimal(value.trim());
}

export function deriveFinishedGoodsQcConclusion(input: QcQuantities): QcQuantityResult {
  const inspected = decimal(input.inspected_quantity, "inspected_quantity");
  const qualified = decimal(input.qualified_quantity, "qualified_quantity");
  const conditional = decimal(input.conditional_accept_quantity, "conditional_accept_quantity");
  const rejected = decimal(input.rejected_quantity, "rejected_quantity");
  if (inspected.lte(0)) throw ruleError("QC_INSPECTED_QUANTITY_REQUIRED", "本次检验数量必须大于 0", []);
  const splitTotal = qualified.plus(conditional).plus(rejected);
  if (!inspected.eq(splitTotal)) {
    throw ruleError(
      "QC_QUANTITY_NOT_BALANCED",
      `数量不配平：本次检验数量（${inspected.toString()}）必须等于 合格数量 + 条件接收数量 + 不合格数量（当前合计 ${splitTotal.toString()}）`,
      [
        { inspected_quantity: inspected.toString() },
        { qualified_quantity: qualified.toString() },
        { conditional_accept_quantity: conditional.toString() },
        { rejected_quantity: rejected.toString() },
      ],
    );
  }
  const conclusion = qualified.gt(0) && conditional.eq(0) && rejected.eq(0) ? "qualified" : qualified.eq(0) && conditional.gt(0) && rejected.eq(0) ? "conditional_accepted" : qualified.eq(0) && conditional.eq(0) && rejected.gt(0) ? "rejected" : "mixed";
  return { ...input, conclusion };
}

export function availableFinishedGoodsInboundQuantity(qualified: string, conditional: string, alreadyInbound: string) {
  const available = decimal(qualified, "qualified_quantity").plus(decimal(conditional, "conditional_accept_quantity")).minus(decimal(alreadyInbound, "already_inbound"));
  if (available.lt(0)) {
    throw ruleError("QC_INBOUND_QUANTITY_EXCEEDED", "可入库数量为负：已入库数量超过了 QC 接收数量（合格 + 条件接收），请先核对已入库记录", []);
  }
  return available.toString();
}
