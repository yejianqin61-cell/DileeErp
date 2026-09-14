"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../../lib/utils";

export type SearchableSelectOption = { value: string; label: string };

type SearchableSelectProps = {
  /** id of the visible control; a form <Label htmlFor> may point here. */
  id?: string;
  /** Currently selected option value ("" = none). Fully controlled. */
  value: string;
  /** { value, label } options; may be updated dynamically while open. */
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  onSearch?: (query: string) => void;
  disabled?: boolean;
  /** Text shown by the collapsed trigger when nothing is selected. */
  placeholder?: string;
  /** Accessible name of the control (usually the visible field label). */
  label?: string;
  /** Placeholder shown inside the search box once the list opens. */
  searchPlaceholder?: string;
  noResultsText?: string;
  className?: string;
};

/** Case-insensitive substring filter over option label or value. */
function matchesQuery(option: SearchableSelectOption, query: string) {
  return option.label.toLocaleLowerCase().includes(query) || option.value.toLocaleLowerCase().includes(query);
}

/** 弹层首选高度，与 globals.css 的 `.ui-searchable-select-popover { max-height: 288px }` 保持一致。 */
export const SEARCHABLE_POPOVER_MAX_HEIGHT = 288;
/** 触发点与弹层之间的间距，对应 CSS 的 `calc(100% + 4px)`。 */
const POPOVER_GAP = 4;

/**
 * 决定弹层朝上还是朝下，并给出该侧可用高度（用于内联 max-height）。
 *
 * 原实现只判断"下方空间是否 ≥288"，不够就朝上，**而没有检查上方是否够**。
 * 弹层绝对定位在触发点所在的裁切盒（宿主对话框 `.ui-dialog-content` 有 overflow:auto）内，
 * 因此触发点靠近对话框顶部时，朝上的弹层会伸出上边缘被裁掉 —— 顶部若干选项鼠标点不到
 * （键盘仍可达，所以测试与真实用户表现不一致）。
 *
 * 现在：能整高容纳的一侧优先；都容纳不下就选空间更大的一侧；并把高度限制在该侧可用高度内，
 * 保证弹层整体落在裁切盒内、每个选项都可点击。
 */
export function choosePopoverPlacement({
  spaceAbove,
  spaceBelow,
  preferred = SEARCHABLE_POPOVER_MAX_HEIGHT,
}: {
  spaceAbove: number;
  spaceBelow: number;
  preferred?: number;
}): { placement: "up" | "down"; maxHeight: number } {
  const placement = spaceBelow >= preferred ? "down" : spaceAbove >= preferred ? "up" : spaceBelow >= spaceAbove ? "down" : "up";
  const available = placement === "down" ? spaceBelow : spaceAbove;
  // 下限 24px 只为避免退化成 0 高；容器正常时 available 远大于此，弹层不会被裁切。
  return { maxHeight: Math.max(24, Math.min(preferred, Math.floor(available))), placement };
}

export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  onSearch,
  disabled = false,
  placeholder = "请选择",
  label,
  searchPlaceholder,
  noResultsText = "无匹配项",
  className,
}: SearchableSelectProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  // 打开时按裁切盒内该侧的可用高度收敛，保证弹层不被裁掉（见 choosePopoverPlacement）。
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(SEARCHABLE_POPOVER_MAX_HEIGHT);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => (normalizedQuery ? options.filter((option) => matchesQuery(option, normalizedQuery)) : options),
    [options, normalizedQuery]
  );
  const selectedOption = useMemo(() => options.find((option) => option.value === value), [options, value]);
  const listboxId = `ui-searchable-select-list-${uid}`;
  const optionIdPrefix = `ui-searchable-select-option-${uid}`;
  const searchPlaceholderText = searchPlaceholder ?? (label ? `搜索${label}` : "搜索…");

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  const openWith = useCallback((initialQuery = "") => {
    setQuery(initialQuery);
    setActiveIndex(-1);
    setOpen(true);
  }, []);

  const selectOption = useCallback(
    (nextValue: string) => {
      onChange(nextValue);
      close(true);
    },
    [onChange, close]
  );

  // On open: focus the search box, pre-select the current value, and flip the
  // panel upward when there is not enough room below inside the scroll parent.
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (input) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    if (!normalizedQuery) {
      const index = options.findIndex((option) => option.value === value);
      setActiveIndex(index);
    }
    const rootEl = rootRef.current;
    if (rootEl) {
      const rect = rootEl.getBoundingClientRect();
      let scrollParent: HTMLElement | null = null;
      for (let node = rootEl.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) {
          scrollParent = node;
          break;
        }
      }
      const bottomLimit = scrollParent ? scrollParent.getBoundingClientRect().bottom : window.innerHeight;
      const topLimit = scrollParent ? scrollParent.getBoundingClientRect().top : 0;
      const chosen = choosePopoverPlacement({
        spaceAbove: rect.top - topLimit - POPOVER_GAP,
        spaceBelow: bottomLimit - rect.bottom - POPOVER_GAP,
      });
      setPlacement(chosen.placement);
      setPopoverMaxHeight(chosen.maxHeight);
    }
    // Run only when the panel opens; values above are read from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted option valid while filtering / updating options.
  useEffect(() => {
    if (!open || activeIndex < filtered.length) return;
    setActiveIndex(filtered.length - 1);
  }, [open, activeIndex, filtered.length]);

  // Scroll the highlighted option into view inside the option list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  // While open: close on outside pointer-down / container scroll / Escape,
  // without letting Escape reach the host dialog (kept open until 2nd press).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: globalThis.PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    }
    function onScroll(event: globalThis.Event) {
      if (rootRef.current && rootRef.current.contains(event.target as Node)) return; // internal list scroll
      close(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openWith();
    } else if (event.key.length === 1) {
      // Typing directly on the collapsed control starts a search.
      event.preventDefault();
      openWith(event.key);
    }
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current < filtered.length - 1 ? current + 1 : filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? (filtered.length ? filtered.length - 1 : -1) : current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = activeIndex >= 0 ? filtered[activeIndex] : filtered.length === 1 ? filtered[0] : undefined;
      if (target) selectOption(target.value);
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  return (
    <div ref={rootRef} className={cn("ui-searchable-select", className)} data-testid="searchable-select">
      {open ? (
        <>
          <div className="ui-searchable-select-searchbox">
            <input
              ref={inputRef}
              id={id}
              type="text"
              className="ui-input"
              data-testid="searchable-select-search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-haspopup="listbox"
              aria-controls={filtered.length ? listboxId : undefined}
              aria-activedescendant={activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined}
              aria-label={label ?? placeholder}
              placeholder={searchPlaceholderText}
              value={query}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                 onSearch?.(event.target.value);
                setActiveIndex(-1);
              }}
              onKeyDown={handleInputKeyDown}
              onBlur={(event) => {
                if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close(false);
              }}
            />
            <Search size={14} aria-hidden="true" className="ui-searchable-select-search-icon" />
          </div>
          {filtered.length === 0 ? (
            <div className="ui-searchable-select-popover ui-searchable-select-popover-down" role="status">
              {noResultsText}
            </div>
          ) : (
            <div
              className={cn(
                "ui-searchable-select-popover",
                placement === "up" ? "ui-searchable-select-popover-up" : "ui-searchable-select-popover-down"
              )}
              style={{ maxHeight: popoverMaxHeight }}
            >
              <div
                ref={listRef}
                id={listboxId}
                role="listbox"
                aria-label={label ?? placeholder}
                className="ui-searchable-select-list"
              >
                {filtered.map((option, index) => {
                  const selected = option.value === value;
                  const active = activeIndex === index;
                  return (
                    <div
                      key={option.value}
                      id={`${optionIdPrefix}-${index}`}
                      role="option"
                      aria-selected={selected}
                      data-option-index={index}
                      data-active={active ? "true" : undefined}
                      data-testid="searchable-select-option"
                      className={cn("ui-select-item", "ui-searchable-select-option")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectOption(option.value)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className="ui-select-item-indicator">{selected && <Check size={14} aria-hidden="true" />}</span>
                      <span className="ui-searchable-select-option-text">{option.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        <button
          ref={triggerRef}
          id={id}
          type="button"
          className={cn("ui-select-trigger", "ui-searchable-select-trigger", !selectedOption && !value && "ui-searchable-select-placeholder")}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={false}
          aria-label={label ?? placeholder}
          disabled={disabled}
          onClick={() => openWith()}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="ui-searchable-select-trigger-text">{selectedOption ? selectedOption.label : value || placeholder}</span>
          <ChevronDown size={15} aria-hidden="true" className="ui-searchable-select-chevron" />
        </button>
      )}
    </div>
  );
}
