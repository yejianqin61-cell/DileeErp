"use client";
import { useEffect } from "react";
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    const handleMessage = (event: MessageEvent) => { if (event.data?.type === "dilee-static-chunk-missing") refresh(); };
    // sw.js 用 clients.claim() 接管首次访问的页面，同样会触发 controllerchange。
    // 那不是版本更新，刷新会清掉用户已输入的内容；只有替换已有 controller 时才刷新。
    let controlled = Boolean(navigator.serviceWorker.controller);
    const handleControllerChange = () => {
      if (controlled) refresh();
      controlled = true;
    };
    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    navigator.serviceWorker.addEventListener("message", handleMessage);
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    return () => { navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange); navigator.serviceWorker.removeEventListener("message", handleMessage); };
  }, []);
  return null;
}
