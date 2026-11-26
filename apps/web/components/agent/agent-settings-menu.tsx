"use client";

import { useContext, useState } from "react";
import { Settings } from "lucide-react";
import { AgentSettingsContext, type ThemePreference } from "../../features/agent-chat/settings/settings";
import { Button } from "../ui/button";
import styles from "./agent-settings-menu.module.css";

const THEME_OPTIONS: ReadonlyArray<readonly [ThemePreference, string]> = [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]];

export function AgentSettingsMenu() {
  const { settings, update } = useContext(AgentSettingsContext);
  const [open, setOpen] = useState(false);
  return <div className={styles.menu} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <Button variant="ghost" size="icon" title="设置" aria-label="设置" aria-expanded={open} onClick={() => setOpen((value) => !value)} data-testid="agent-settings-open"><Settings size={14} /></Button>
    {open && <div className={styles.panel}>
      <fieldset>
        <legend>主题</legend>
        {THEME_OPTIONS.map(([value, label]) => <label key={value}>
          <input type="radio" name="agent-theme" checked={settings.theme === value} onChange={() => update({ theme: value })} />{label}
        </label>)}
      </fieldset>
    </div>}
  </div>;
}
