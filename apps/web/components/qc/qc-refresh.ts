"use client";

// 质检模块内的跨面板失效通知。
//
// /qc 把三块面板放在同一个页面里，各自持有自己的数据。拆之前它们分属不同路由，
// 跳转即重新挂载拉取；同页并存后如果不广播，就会出现「刚录完成品质检，下面的
// 质检合格待入库还是旧额度」「刚登记入库，上面成品质检的净值还是旧值」这类陈旧态。
//
// 用 window 事件而不是把 loadAll 提升到页面：三块面板仍可独立挂载（组件测试、单独路由复用），
// 且发出方不会收到自己的事件（source 过滤），因此不会多打一趟重复请求。
const EVENT = "qc-data-changed";

export type QcPanelSource = "incoming-inspections" | "finished-goods-qc" | "qc-inbound";

/** 广播「质检数据已变化」，让同页的其它面板重新拉取。 */
export function emitQcDataChanged(source: QcPanelSource) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { source } }));
}

/** 订阅其它面板的变更（忽略自己发出的事件）。返回取消订阅函数。 */
export function subscribeQcDataChanged(source: QcPanelSource, listener: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ source?: string }>).detail;
    if (detail?.source === source) return;
    listener();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
