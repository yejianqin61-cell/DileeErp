// 收货仓库档案（2026-11-18，工单 T-0018）。
//
// 采购「登记到货」时要在同安仓 / 晋江仓 / 大田仓之间选入库地点。仓库档案以后端
// `GET /purchase-orders/warehouses` 为准；本文件保留一份内置兜底，理由与币种字典相同：
// 请求失败、未登录或后端还没部署时，不能把到货登记整页锁死，而历史口径本来就只有同安仓。
//
// 本文件保持零依赖之外只依赖 api-client，页面与组件测试都能直接 import。

import { apiGet } from "./api-client";

export type WarehouseOption = { value: string; label: string };

/** 与后端 `warehouse-catalog.ts` 保持一致；新增仓库时两边一起追加。 */
export const FALLBACK_WAREHOUSES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "tongan", name: "同安仓" },
  { code: "jinjiang", name: "晋江仓" },
  { code: "daitan", name: "大田仓" },
];

/** 历史到货单没有地点：系统此前只维护同安仓，缺省按它显示/提交。 */
export const DEFAULT_WAREHOUSE_CODE = "tongan";

export const WAREHOUSE_CATALOGUE_PATH = "/purchase-orders/warehouses";

type WarehouseItem = { code?: string; name?: string; value?: string; label?: string };

const codeOf = (item: WarehouseItem) => (item.code ?? item.value ?? "").trim();
const nameOf = (item: WarehouseItem) => (item.name ?? item.label ?? "").trim();

/**
 * 把接口返回的仓库档案转成下拉选项。
 *
 * - 接口返回空数组（未配置 / 请求失败）时回落到内置三仓，保证到货登记仍可选；
 * - 过滤无编码项、按编码去重，保持接口顺序（档案顺序是业务顺序，不按字典序打乱）。
 */
export function warehouseOptions(items: WarehouseItem[] | undefined | null): WarehouseOption[] {
  const active = (items ?? []).filter((item) => codeOf(item) !== "");
  const source = active.length ? active : FALLBACK_WAREHOUSES;
  const seen = new Set<string>();
  return source
    .map((item) => ({ value: codeOf(item), label: nameOf(item) || codeOf(item) }))
    .filter((item) => (seen.has(item.value) ? false : (seen.add(item.value), true)));
}

/** 当前值不在档案里时补一个「历史值」选项，避免编辑老单时被迫改成别的仓库。 */
export function warehouseOptionsWithCurrent(items: WarehouseItem[] | undefined | null, current?: string | null): WarehouseOption[] {
  const options = warehouseOptions(items);
  const wanted = (current ?? "").trim();
  if (!wanted || options.some((option) => option.value === wanted)) return options;
  return [{ value: wanted, label: `${wanted}（历史值）` }, ...options];
}

/** 展示用名称：优先档案，其次历史编码，最后缺省同安仓。 */
export function warehouseLabel(code: string | null | undefined, items?: WarehouseItem[] | null): string {
  const wanted = (code ?? "").trim() || DEFAULT_WAREHOUSE_CODE;
  return warehouseOptions(items).find((option) => option.value === wanted)?.label ?? wanted;
}

/** 从后端取仓库档案；任何失败都回落内置清单，不阻断到货登记。 */
export async function fetchWarehouseOptions(): Promise<WarehouseOption[]> {
  try {
    const result = await apiGet<WarehouseItem[]>(WAREHOUSE_CATALOGUE_PATH);
    return warehouseOptions(result.data ?? []);
  } catch {
    return warehouseOptions([]);
  }
}
