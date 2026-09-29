"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import { itemNoKey, normalizeItemNo } from "../../lib/item-no";
import { Input } from "../ui/input";

/**
 * 货号输入框：**既能挑既有货号，也能直接输一个系统里还没有的**。
 *
 * 为什么不用 `ui/searchable-select`：那个控件是**只能选不能建**的（`options` + `onChange`，
 * 输入只用于过滤）。而货号是客户/产品给的编码，销售经常会拿到一个系统里第一次出现的货号 ——
 * 逼他先「新建货号」再回来填单，等于给每张新品的单加一道无用手续。
 *
 * 为什么不用原生 `<datalist>`：全站治理轮（`docs/task/0824-01/04-remove-native-browser-prompts.md`）
 * 已经移除原生浏览器控件 —— 各浏览器/系统下的观感与键盘行为都不一样。
 *
 * 建议列表由父组件取（`GET /sales-orders/item-nos`）后传进来：本组件保持**无请求、纯受控**，
 * 这样测试不必起 msw 就能覆盖全部键盘与筛选行为。
 */

export type ItemNoSuggestion = { item_no: string; item_no_key: string; order_count: number };

const MAX_SUGGESTIONS = 8;

export function ItemNoInput({ value, onChange, suggestions, disabled = false, testId = "sales-base-item_no", placeholder = "如 27621（可挑既有，也可直接输新的）" }: {
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly ItemNoSuggestion[];
  disabled?: boolean;
  testId?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 按输入内容过滤：用**归一键**比，所以输 `27621` 也能命中存成「27621 流水花扇」的建议。
  const filtered = useMemo(() => {
    const key = itemNoKey(value);
    const seen = new Set<string>();
    const result: ItemNoSuggestion[] = [];
    for (const suggestion of suggestions) {
      const suggestionKey = suggestion.item_no_key || itemNoKey(suggestion.item_no);
      if (!suggestionKey) continue;
      if (key && !suggestionKey.includes(key)) continue;
      if (seen.has(suggestionKey)) continue;
      seen.add(suggestionKey);
      result.push(suggestion);
      if (result.length >= MAX_SUGGESTIONS) break;
    }
    return result;
  }, [suggestions, value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: globalThis.PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // 高亮项在列表变化后可能越界（输入变短时建议变多/变少）。
  useEffect(() => { if (activeIndex >= filtered.length) setActiveIndex(filtered.length - 1); }, [activeIndex, filtered.length]);

  function apply(suggestion: ItemNoSuggestion) {
    // 采用建议时**原样写入 `item_no`**（不是 key）：库里存的是人能读的原样，大小写与内部空格都保留。
    onChange(suggestion.item_no);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current < filtered.length - 1 ? current + 1 : current));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? -1 : current - 1));
    } else if (event.key === "Enter") {
      // 有高亮项才吃掉 Enter：否则销售在「输新货号」时按 Enter 会被莫名其妙地替换成建议值。
      if (open && activeIndex >= 0 && filtered[activeIndex]) {
        event.preventDefault();
        apply(filtered[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="ui-item-no" ref={rootRef}>
      <Input
        data-testid={testId}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && filtered.length > 0}
        aria-autocomplete="list"
        aria-label="货号"
        onChange={(event) => { onChange(event.target.value); setOpen(true); setActiveIndex(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && filtered.length > 0 && (
        <div className="ui-item-no-popover" role="listbox" aria-label="已有货号" data-testid="item-no-suggestions">
          {filtered.map((suggestion, index) => (
            <button
              key={suggestion.item_no_key}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-testid="item-no-suggestion"
              data-active={index === activeIndex ? "true" : undefined}
              className={cn("ui-item-no-option", index === activeIndex && "ui-item-no-option-active")}
              // 用 mousedown 落地：blur 会先触发并关掉列表，click 就永远等不到。
              onMouseDown={(event) => { event.preventDefault(); apply(suggestion); }}
            >
              <span>{suggestion.item_no}</span>
              <small>{suggestion.order_count} 单</small>
            </button>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && normalizeItemNo(value) !== null && (
        <div className="ui-item-no-popover ui-item-no-empty" role="status" data-testid="item-no-suggestions-empty">
          系统里还没有这个货号，将新建一个
        </div>
      )}
    </div>
  );
}
