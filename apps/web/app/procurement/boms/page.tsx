"use client";

import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../../lib/api-client";
import { BomWorkbench, type BomMaterialRef } from "../../../components/bom/bom-workbench";
import { MaterialCreateDialog } from "../../../components/bom/material-create-dialog";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Reference = AuditRow & { id: string; orderNo?: string; status?: string; salesOrderId?: string; name?: string; materialCode?: string; supplierCode?: string; code?: string; isActive?: boolean; defaultUnitId?: string };
// 物料池：规格型号与颜色要一起带上 —— BOM 行选择/新建物料时会引用它们做初始值。
type Material = { id: string; materialCode?: string; code?: string; name?: string; specificationModel?: string | null; color?: string | null; materialType?: string; defaultUnitId?: string; isActive?: boolean };
type Unit = { id: string; name?: string; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * BOM 表列表的列宽（2026-10-09：`DataTable` 一律 `table-layout: fixed`，没写宽度的列由浏览器**均分**，
 * 这里把「均分」换成「按内容需要分配」）。
 *
 * 口径同 `app/procurement/inbounds/page.tsx`，两个常数先记住：
 *   - 可用宽度基线 **1034px**（1366 视口减侧栏后的实测表宽）；
 *   - `.ui-table-cell` 左右各 12px 内边距 → 一列定 n% 后真正能放字的宽度是 `n% × 1034 - 24`
 *     （8% → 58.7px，与 `components/data/audit-columns.tsx:44` 记的实测值一致）。
 *
 * 本表 5 列 = 3 列业务列（订单号 / BOM状态 / BOM表）+ `auditColumns()` 的「创建人 / 最后修改人」。
 * 后两列**刻意不给宽度、也不改工厂用法**（`lib/audit-columns-coverage.test.mjs` 有守卫），
 * 所以下面 3 个数字的总和必须是 **84%**，剩下 16% 由那两列均分（各 8% = 58.7px）。
 *
 * 这张表行数少、列也少（只有 3 列要配），所以策略与其它页相反：订单号这种长文本列
 * **按内容需要给足**，而不是被预算压到 8% 下限 —— 剩下的都给「BOM表」按钮列。
 */
const COLUMN_WIDTH = {
  // 订单号：`SO-20261009-0001` 一行 16 字符 ≈ 110px（需求 10.6%），取 30%（= 310px）——
  // 按内容需要一次放全，不用 hover（这张表只有 3 列要分 84%，给得起）。
  orderNo: "30%",
  // BOM状态：`草稿 / 已确认` 一类短枚举（最长 3 汉字 ≈ 36px = 3.5%），短状态 4%~6% 取 12% ——
  // 6% 是规则上限，但这里没有别处更需要空间（订单号与按钮列都已按内容给足），
  // 多出来的量留在状态列不会撑坏版式，只让这一格更宽松。
  status: "12%",
  // BOM表：一个固定宽度的按钮（`编辑BOM表 / 新建BOM表`，5 汉字）。
  // `.ui-button-sm`（padding 0 10px、font-size 12px）下 5 汉字按钮 ≈ 80px，加本格 24px 内边距 = 104px
  // → 10.1%，规则下限 8% 已满足；剩下的预算给到 42%（= 434px）。
  // 为什么按钮列给这么宽：本列直接渲染一个 `<Button>`（不是 `.action-row` 那种会换行的 flex 行），
  // 宽出来的空间不会撑坏版式，而 84% 必须**精确**分完 —— 余下的每一分要么落在这里，
  // 要么让前两列各空一大段。
  bom: "42%",
} as const;

export default function BomsPage() {
  const [boms, setBoms] = useState<Reference[]>([]);
  const [salesOrders, setSalesOrders] = useState<Reference[]>([]);
  /** 空列表时问出来的草稿单张数（`null` = 没问/问不到）：只用来写空状态里那句解释。 */
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bomWorkbench, setBomWorkbench] = useState<{ id: string; label?: string } | null>(null);
  // BOM 工作区请求开的「新建物料」弹窗：存下它给的回填函数，物料建好就填回当前行。
  // （2026-09-16 之前这里是空函数：按钮在，点了没反应 —— 用户反馈「新建物料按钮怎么不见了」。）
  const [materialApply, setMaterialApply] = useState<((material: BomMaterialRef) => void) | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [bs, so, ms, us] = await Promise.all([
        apiGet<Reference[]>("/boms"),
        /**
         * 销售单：**服务端按「已确认」筛、一次取 200 张**（2026-10-13 修）。
         *
         * 用户原话：「采购模块，BOM表，没有新建 BOM 表的地方。只要有销售单事实的单子，就要允许
         * 也在采购中创建保存编辑 BOM 表。」
         *
         * 根因就是这一行：原来取的是 `/sales-orders`（**不带状态、默认只取最近 20 张**），
         * 再在页面上按 `status === "confirmed"` 过滤 —— 订单一多、或者最近动过的单恰好都是草稿，
         * 这一页就**整页空**（"暂无已确认销售单"），于是连「新建BOM表」按钮都看不到，
         * 更早的已确认单也永远轮不到。生产页的 BOM 入口一直是
         * `/sales-orders?status=confirmed&page=1&page_size=200`，两处现在一致。
         */
        apiGet<Reference[]>("/sales-orders?status=confirmed&page=1&page_size=200"),
        apiGet<Material[]>("/materials"),
        apiGet<Unit[]>("/units"),
      ]);
      setBoms(bs.data);
      setSalesOrders(so.data);
      setMaterials(ms.data);
      setUnits(us.data);
    } catch (cause) {
      setError(messageOf(cause, "BOM数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  /**
   * 一张已确认销售单都没有时，问一句"是不是还有草稿单"（**只在空列表时**打这一次请求）。
   *
   * 为什么值得单独问：BOM 只能建在**已确认**销售单上，而"为什么这一页是空的"对用户是个谜 ——
   * 说清"你还有 N 张草稿没确认"比一句"暂无已确认销售单"有用得多（2026-09-16 的
   * 「新建物料按钮怎么不见了」就是同一类"按钮/表空着但不说原因"的坑）。
   * 它**不在上面那个 `Promise.all` 里**：一是失败不影响主数据，二是那个位置型解构有守卫盯着。
   */
  useEffect(() => {
    if (loading || salesOrders.length) { setDraftCount(null); return; }
    let cancelled = false;
    void apiGet<Reference[]>("/sales-orders?status=draft&page=1&page_size=1")
      .then((result) => { if (!cancelled) setDraftCount(Number(result.meta?.total ?? 0) || 0); })
      .catch(() => { if (!cancelled) setDraftCount(null); });
    return () => { cancelled = true; };
  }, [loading, salesOrders.length]);

  function openBom(id: string, label?: string) {
    setError("");
    setBomWorkbench({ id, label });
  }

  async function createOrOpenBom(order: Reference) {
    const existing = boms.find((b) => b.salesOrderId === order.id);
    if (existing) {
      openBom(existing.id, order.orderNo);
      return;
    }
    setError("");
    try {
      const result = await apiPost<Reference>(`/boms/from-sales-order/${order.id}`, { extension_data: {} });
      setBoms((items) => [...items, result.data]);
      notifySuccess("BOM表已创建");
      openBom(result.data.id, order.orderNo);
    } catch (cause) {
      notifyError(messageOf(cause, "BOM表创建失败"));
    }
  }

  /**
   * 这一页只列**已确认**销售单：BOM 是"要按这张单买料/投产"的清单，草稿单随时会被改，
   * 拿它建 BOM 等于给一份会变的单子承诺物料。
   *
   * ⚠️ 过滤已经交给服务端（`?status=confirmed`）—— **不要**在这里再过滤一次：
   * 那正是 2026-10-13 那个缺陷的形态（前端拿到最近 20 张任意状态的单再过滤 → 整页空）。
   * 若真出现不该有的状态，页面上的「BOM状态」列会如实显示出来，比静默吞掉强。
   */
  const confirmedSalesOrders = salesOrders;
  const bomEmptyHint = draftCount
    ? `还有 ${draftCount} 张销售单是草稿：BOM 只能建在**已确认**的销售单上 —— 请先到【销售】确认，再回这里点「新建BOM表」。`
    : "建立并确认销售单后，即可在这里为其建立 BOM 表。";

  const columns: ColumnDef<Reference>[] = [
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo } },
    { accessorKey: "status", header: "BOM状态", meta: { width: COLUMN_WIDTH.status } },
    ...auditColumns<Reference>(),
    {
      id: "bom", header: "BOM表", meta: { width: COLUMN_WIDTH.bom },
      cell: ({ row }) => {
        const bom = boms.find((b) => b.salesOrderId === row.original.id);
        return <Button size="sm" variant="secondary" onClick={() => void createOrOpenBom(row.original)}>{bom ? "编辑BOM表" : "新建BOM表"}</Button>;
      },
    },
  ];

  if (loading) return <><PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]} /><LoadingState /></>;
  if (bomWorkbench) {
    return (
      <div className="page-root" data-testid="page-procurement-boms">
        <PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]} />
        <BomWorkbench
          bomId={bomWorkbench.id}
          title={bomWorkbench.label}
          materials={materials}
          units={units}
          onCreateMaterial={(apply) => setMaterialApply(() => apply)}
          onClose={() => setBomWorkbench(null)}
          onSaved={() => void load()}
        />
        <MaterialCreateDialog
          open={Boolean(materialApply)}
          units={units}
          onOpenChange={(open) => { if (!open) setMaterialApply(null); }}
          onUnitCreated={(unit) => setUnits((items) => [...items, unit])}
          onCreated={(material) => {
            // 新物料必须先进物料池：BOM 行里的物料下拉是靠 options 渲染出名字的，
            // 只把 id 填进行里会让那一格变成空白。
            setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]);
            materialApply?.(material);
            setMaterialApply(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page-root" data-testid="page-procurement-boms">
      <PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]}>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-body">
          <DataTable columns={columns} data={confirmedSalesOrders} empty={<EmptyState title="暂无已确认销售单" description={bomEmptyHint} />} />
        </div>
      </section>
    </div>
  );
}