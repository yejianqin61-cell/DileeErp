"use client";

import { useContext, useState } from "react";
import { Settings } from "lucide-react";
import { useTranslate, type TranslationKey } from "../../features/agent-chat/i18n";
import { AgentSettingsContext, type Locale, type ThemePreference } from "../../features/agent-chat/settings/settings";
import { Button } from "../ui/button";
import styles from "./agent-settings-menu.module.css";

const THEME_OPTIONS: ReadonlyArray<readonly [ThemePreference, TranslationKey]> = [["system", "themeSystem"], ["light", "themeLight"], ["dark", "themeDark"]];
const LOCALE_OPTIONS: ReadonlyArray<readonly [Locale, string]> = [["zh-CN", "中文"], ["en-US", "English"]];

export function AgentSettingsMenu() {
  const { settings, update } = useContext(AgentSettingsContext);
  const [open, setOpen] = useState(false);
  const t = useTranslate();
  return <div className={styles.menu} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <Button variant="ghost" size="icon" title={t("settings")} aria-label={t("settings")} aria-expanded={open} onClick={() => setOpen((value) => !value)} data-testid="agent-settings-open"><Settings size={14} /></Button>
    {open && <div className={styles.panel}>
      <fieldset>
        <legend>{t("theme")}</legend>
        {THEME_OPTIONS.map(([value, label]) => <label key={value}>
          <input type="radio" name="agent-theme" checked={settings.theme === value} onChange={() => update({ theme: value })} />{t(label)}
        </label>)}
      </fieldset>
      <fieldset>
        <legend>{t("language")}</legend>
        {LOCALE_OPTIONS.map(([value, label]) => <label key={value}>
          <input type="radio" name="agent-locale" checked={settings.locale === value} onChange={() => update({ locale: value })} />{label}
        </label>)}
      </fieldset>
    </div>}
  </div>;
}
