/**
 * 复制到剪贴板（AI 回复的「复制」按钮用）。
 *
 * 为什么需要回退：厂内系统部署在 http://118.178.95.156（非 HTTPS），
 * `navigator.clipboard` 在非安全上下文里直接不存在 —— 只写 Clipboard API 的话，
 * 生产环境的复制按钮会静默失败。execCommand("copy") 已废弃但在 Chromium 里仍可用，
 * 作为回退路径保留，两条都失败时返回 false 让按钮显示「复制失败」而不是假装成功。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走下面的回退路径：非安全上下文 / 权限被拒都会进这里。
  }

  if (typeof document === "undefined") return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // fixed + 负偏移：不进可视流，也不会把对话滚动位置顶偏。
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
