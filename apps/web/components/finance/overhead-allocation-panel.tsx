"use client";

// 「本月管理费」登记面板（财务 → 财务报表 → 核算表 tab 上的第一块）。
//
// 用户 2026-09-20 转述财务原话：「只有采购输入原材料 物控有录人工费。我这边录管理费，就可以出这个表。
// 我这里的管理费是一个月的所以费用的总合平摊在本月生产的总数量中。比如这个月管理费是22万
// 生产了4000打货 管理费就是55元」。
//
// 面板与报表同屏是刻意的：**录管理费与看核算表是同一件事的两半**，分成两个页面财务就得来回跳，
// 而且会看不出来「我刚改的费率有没有进到表里」（保存后 `onSaved` 直接重取报表）。
//
// 四个输入（金额 / 单位 / 分摊数量覆盖 / 备注）对应 `overhead_allocations` 的四列；
// 「自动数量」与「费率」是**算出来的**（后端 resolved 接口给），页面上只读显示 ——
// 让财务手填费率就等于把「总额 ÷ 数量」这条口径废掉，以后算错了从表上看不出来。
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { LoadingState } from "../feedback/states";
import { ApiClientError, apiDelete, apiGet, apiPost } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";

/** 后端 `/finance/overhead-allocations/resolved` 的响应（数量与费率都是十进制字符串）。 */
type ResolvedOverhead = {
  period: string;
  unit: string | null;
  auto_quantity: string | null;
  quantity: string | null;
  rate: string | null;
  record: { id: string; period: string; amount: string; unit: string; quantity_override: string | null; remark: string | null } | null;
};

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

/**
 * 十进制字符串去掉无意义的尾零（`55.0000` → `55`）。
 *
 * 界面上一律用这个显示而不是 `Number().toFixed(2)`：金额是 DECIMAL(18,4)，
 * 财务看到的应当是他输进去的那个数（55 就是 55，不是 55.00），而且不能经过浮点。
 */
function trimDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export default function OverheadAllocationPanel({ period, onMonthChange, onSaved }: {
  /** 当前分摊期间（YYYY-MM），由页面上筛选条的起始日期决定。 */
  period: string;
  /** 改月份：同时把筛选条切到该月（见下面的说明），所以它由父组件实现。 */
  onMonthChange: (period: string) => void;
  /** 保存/删除成功后通知父组件重取报表 —— 费率变了，表必须跟着变。 */
  onSaved: () => void;
}) {
  const [resolved, setResolved] = useState<ResolvedOverhead | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [quantityOverride, setQuantityOverride] = useState("");
  const [remark, setRemark] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<ResolvedOverhead>(`/finance/overhead-allocations/resolved?period=${period}`);
      setResolved(result.data);
      // 输入框用记录的值回填；**没有记录时留空而不是填 0** —— 「这个月还没录」与「录了 0」
      // 在页面上必须看得出区别，否则财务会以为 0 是已经存进去的数。
      setAmount(result.data.record?.amount ?? "");
      setUnit(result.data.record?.unit ?? "");
      setQuantityOverride(result.data.record?.quantity_override ?? "");
      setRemark(result.data.record?.remark ?? "");
    } catch (cause) {
      setError(messageOf(cause, "管理费登记加载失败"));
      setResolved(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await apiPost<ResolvedOverhead>("/finance/overhead-allocations", {
        period,
        amount: amount.trim(),
        unit: unit.trim(),
        // 空串 = 清掉人工覆盖，回到自动汇总数量（后端把空串当 null，与「不传」同义）。
        quantity_override: quantityOverride.trim(),
        remark: remark.trim() || undefined,
      });
      notifySuccess(`${period} 的管理费已登记`);
      await load();
      onSaved();
    } catch (cause) {
      const message = messageOf(cause, "管理费登记失败");
      setError(message);
      notifyError(message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!resolved?.record) return;
    setSaving(true);
    setError("");
    try {
      await apiDelete(`/finance/overhead-allocations/${resolved.record.id}`);
      notifySuccess(`${period} 的管理费登记已删除（核算表的管理费列会留空）`);
      await load();
      onSaved();
    } catch (cause) {
      const message = messageOf(cause, "删除失败");
      setError(message);
      notifyError(message);
    } finally {
      setSaving(false);
    }
  }

  return <section className="panel" data-testid="overhead-panel">
    <div className="panel-heading">
      <h2>本月管理费</h2>
      <span className="panel-note" data-testid="overhead-resolved">
        {resolved?.rate
          ? `费率 ${trimDecimal(resolved.rate)} 元 / ${resolved.unit}（分摊数量 ${trimDecimal(resolved.quantity)}）`
          : "尚未登记费率：核算表的管理费列会留空"}
      </span>
    </div>
    <div className="panel-body">
      {loading && <LoadingState label="正在读取管理费登记" />}
      {!loading && <>
        <div className="filter-bar">
          {/* 月份同时是报表的取数期间（报表按筛选条起始日期所在的月份取费率），所以改这里要
              把筛选条一起切过去 —— 否则会出现「面板显示 10 月的费率、底下的表是 9 月的」。 */}
          <label>管理费月份<Input data-testid="overhead-period" type="month" value={period} onChange={(event) => { if (event.target.value) onMonthChange(event.target.value); }} /></label>
          <label>本月管理费总额<Input data-testid="overhead-amount" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="如 220000" /></label>
          <label>分摊单位<Input data-testid="overhead-unit" value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="打 / 支" /></label>
          <label>分摊数量（留空=自动）<Input data-testid="overhead-quantity" value={quantityOverride} onChange={(event) => setQuantityOverride(event.target.value)} placeholder={resolved?.auto_quantity ? `自动 ${trimDecimal(resolved.auto_quantity)}` : "自动"} /></label>
          <Button data-testid="overhead-save" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
          {resolved?.record && <Button variant="destructive" data-testid="overhead-delete" disabled={saving} onClick={() => void remove()}>删除登记</Button>}
        </div>
        <label className="ui-form-item">备注<Textarea data-testid="overhead-remark" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="如：22 万 ÷ 本月 4000 打 = 55 元/打" /></label>
        {/* 自动数量一定显示出来：它是「费率的分母」，而它来自计件日报（按人按工序逐条填报，
            跨工序合计会重复计一件货）。财务只有看到这个数才能判断要不要人工覆盖。 */}
        <p className="panel-note" data-testid="overhead-auto-quantity">
          自动汇总数量（本月计件日报、按分摊单位过滤）：{trimDecimal(resolved?.auto_quantity)}
          {resolved?.record?.quantity_override ? `；当前使用人工覆盖值 ${trimDecimal(resolved.quantity)}` : ""}
        </p>
        {error && <p className="status-error" data-testid="overhead-error">{error}</p>}
      </>}
    </div>
  </section>;
}
