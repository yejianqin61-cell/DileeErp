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
    navigator.serviceWorker.addEventListener("controllerchange", refresh);
    navigator.serviceWorker.addEventListener("message", handleMessage);
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    return () => { navigator.serviceWorker.removeEventListener("controllerchange", refresh); navigator.serviceWorker.removeEventListener("message", handleMessage); };
  }, []);
  return null;
}
