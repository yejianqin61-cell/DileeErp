"use client";

import { useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";

export type MultiCheckboxSelectOption = { value: string; label: string };

type MultiCheckboxSelectProps = {
  /** id of the search input; a form <Label htmlFor> may point here. */
  id?: string;
  /** { value, label } options rendered as checkbox rows. */
  options: MultiCheckboxSelectOption[];
  /** Currently selected option values. Fully controlled. */
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Options that cannot be picked (e.g. already added to the target). */
  disabledValues?: string[];
  disabled?: boolean;
  /** Accessible name of the group (usually the visible field label). */
  label?: string;
  searchPlaceholder?: string;
  noResultsText?: string;
  className?: string;
};

/** Case-insensitive substring filter over option label or value. */
function matchesQuery(option: MultiCheckboxSelectOption, query: string) {
  return option.label.toLocaleLowerCase().includes(query) || option.value.toLocaleLowerCase().includes(query);
}

/** Searchable checkbox multi-select: order of picking carries no meaning, the
 * parent receives values in option (pool) order after every toggle. */
export function MultiCheckboxSelect({
  id,
  options,
  selected,
  onChange,
  disabledValues = [],
  disabled = false,
  label,
  searchPlaceholder,
  noResultsText = "无匹配项",
  className,
}: MultiCheckboxSelectProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => (normalizedQuery ? options.filter((option) => matchesQuery(option, normalizedQuery)) : options),
    [options, normalizedQuery]
  );
  const disabledSet = useMemo(() => new Set(disabledValues), [disabledValues]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const groupId = `ui-multi-checkbox-group-${uid}`;

  function toggle(value: string) {
    if (disabled || disabledSet.has(value)) return;
    // Emit in option order so submissions stay deterministic regardless of
    // the order checkboxes were ticked in.
    onChange(options.filter((option) => (option.value === value ? !selectedSet.has(option.value) : selectedSet.has(option.value))).map((option) => option.value));
  }

  return (
    <div className={cn("ui-multi-select", className)} data-testid="multi-checkbox-select">
      <div className="ui-multi-select-searchbox">
        <input
          id={id}
          type="text"
          className="ui-input"
          aria-label={searchPlaceholder ?? (label ? `搜索${label}` : "搜索…")}
          placeholder={searchPlaceholder ?? (label ? `搜索${label}` : "搜索…")}
          value={query}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Search size={14} aria-hidden="true" className="ui-multi-select-search-icon" />
      </div>
      <div id={groupId} role="group" aria-label={label} className="ui-multi-select-list">
        {filtered.length === 0 ? (
          <p className="ui-multi-select-empty" role="status">{noResultsText}</p>
        ) : (
          filtered.map((option) => {
            const optionDisabled = disabled || disabledSet.has(option.value);
            const checked = selectedSet.has(option.value);
            return (
              <label key={option.value} className="ui-multi-select-option" data-testid={`multi-checkbox-option-${option.value}`} data-disabled={optionDisabled ? "true" : undefined}>
                <input
                  type="checkbox"
                  className="ui-multi-select-checkbox"
                  checked={checked}
                  disabled={optionDisabled}
                  onChange={() => toggle(option.value)}
                />
                <span className="ui-multi-select-option-text">{option.label}</span>
                {disabledSet.has(option.value) && !checked ? <span className="ui-multi-select-hint">已在当前生产单</span> : null}
              </label>
            );
          })
        )}
      </div>
      <p className="ui-multi-select-count" aria-live="polite">已选 {selected.length} / {options.length} 项</p>
    </div>
  );
}
