/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
"use client";

import { createContext, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";
export type Locale = "zh-CN" | "en-US";
export type AgentSettings = { theme: ThemePreference; locale: Locale };

export const DEFAULT_SETTINGS: AgentSettings = { theme: "system", locale: "zh-CN" };

const STORAGE_KEY = "dilee.agent.settings";
const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];
const LOCALES: readonly Locale[] = ["zh-CN", "en-US"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export type AgentSettingsValue = { settings: AgentSettings; theme: Theme; update: (patch: Partial<AgentSettings>) => void };

export const AgentSettingsContext = createContext<AgentSettingsValue>({ settings: DEFAULT_SETTINGS, theme: "light", update: () => undefined });

function readSettings(): AgentSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AgentSettings> | null;
    return {
      theme: THEMES.find((theme) => theme === stored?.theme) ?? DEFAULT_SETTINGS.theme,
      locale: LOCALES.find((locale) => locale === stored?.locale) ?? DEFAULT_SETTINGS.locale,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const darkQuery = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null);

function subscribeSystemTheme(listener: () => void) {
  const query = darkQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

const systemTheme = (): Theme => (darkQuery()?.matches ? "dark" : "light");

export function useAgentSettingsState(): AgentSettingsValue {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const system = useSyncExternalStore(subscribeSystemTheme, systemTheme, (): Theme => "light");

  useEffect(() => setSettings(readSettings()), []);

  const update = useCallback((patch: Partial<AgentSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        return next;
      }
      return next;
    });
  }, []);

  const theme = settings.theme === "system" ? system : settings.theme;
  return useMemo(() => ({ settings, theme, update }), [settings, theme, update]);
}
