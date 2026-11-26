/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
"use client";

import { useContext, useMemo } from "react";
import { AgentSettingsContext, type Locale } from "../settings/settings";
import { en } from "./en";
import { zh } from "./zh";

export type TranslationKey = keyof typeof zh;
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { "zh-CN": zh, "en-US": en };

export function translatorFor(locale: Locale): Translate {
  const messages = DICTIONARIES[locale];
  return (key, params) => messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => (params && name in params ? String(params[name]) : placeholder));
}

export function useTranslate(): Translate {
  const { locale } = useContext(AgentSettingsContext).settings;
  return useMemo(() => translatorFor(locale), [locale]);
}
