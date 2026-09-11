// 跨模块状态（如原料入库状态）在别的页面被改变后，本页需要重新拉取才看得到。
// 这里只定义"什么时候该刷新"的判定，便于单测；页面注册 focus/visibilitychange 事件即可。

/** 页面重新可见（或窗口重新获得焦点）时才刷新，避免后台标签页无意义地反复请求。 */
export function shouldRefreshOnVisibility(visibilityState: string | null | undefined): boolean {
  return visibilityState === "visible";
}
