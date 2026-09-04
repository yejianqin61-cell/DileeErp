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
    navigator.serviceWorker.addEventListener("controllerchange", refresh);
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    return () => navigator.serviceWorker.removeEventListener("controllerchange", refresh);
  }, []);
  return null;
}
