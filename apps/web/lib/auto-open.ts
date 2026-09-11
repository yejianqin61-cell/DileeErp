// 由 URL 参数自动打开单据弹窗的判定。
//
// 曾经的缺陷（“编辑原料入库单”关不掉）：弹窗自动打开由 useEffect 驱动，而该 effect 的依赖里
// 带着弹窗自身状态。用户点关闭 → dialog 变 null → effect 重新满足条件 → 立刻又打开，
// 表现为关闭按钮“点了没反应”（原料入库、生产领料两处都有）。
// 因此自动打开必须是“每个目标只做一次”，而不是由当前是否打开推导。

export function shouldAutoOpenDraft(params: {
  /** URL 上的目标单据标识（notice_id / production_order_id）。 */
  targetId: string | null | undefined;
  /** 已经自动打开过的目标标识。 */
  alreadyOpened: string | null;
  /** 目标数据是否已加载完成：未加载时不打开，避免用空列表误判。 */
  hasLoaded: boolean;
}): boolean {
  if (!params.targetId) return false;
  if (!params.hasLoaded) return false;
  return params.alreadyOpened !== params.targetId;
}
