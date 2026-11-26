/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
import { useEffect, useRef, useState } from "react";

const MAX_WAIT = 2000;
const RENDER_COST_RATE = 2;

export function useThrottledText(text: string, enabled: boolean): string {
  const startRef = useRef<number | null>(null);
  startRef.current ??= performance.now();
  const updatableAtRef = useRef(0);
  const [output, setOutput] = useState(text);

  useEffect(() => {
    const now = performance.now();
    updatableAtRef.current = now + Math.min(MAX_WAIT, (now - (startRef.current ?? now)) * RENDER_COST_RATE);
  }, [output]);

  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      startRef.current = performance.now();
      setOutput(text);
    };
    const delay = updatableAtRef.current - performance.now();
    if (delay <= 0) {
      update();
      return;
    }
    const timer = setTimeout(update, delay);
    return () => clearTimeout(timer);
  }, [text, enabled]);

  return enabled ? output : text;
}
