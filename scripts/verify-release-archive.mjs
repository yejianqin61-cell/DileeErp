import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const archive = process.argv[2] ?? "DileeErp-latest.tar.gz";
if (!existsSync(archive)) throw new Error(`发布包不存在: ${archive}`);
const root = mkdtempSync(join(tmpdir(), "dilee-release-"));
try {
  const result = spawnSync("tar", ["-xzf", archive, "-C", root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "无法解包发布包");
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(listing.stderr || "无法读取发布包目录");
  const entries = listing.stdout.split(/\r?\n/).map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
  const forbiddenPrefixes = [".agent-reach", ".android", ".cache", ".cargo", ".claude", ".codex", ".config", ".cursor", "AppData", "Application Data"];
  const polluted = entries.filter((entry) => forbiddenPrefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`)));
  if (polluted.length) throw new Error(`发布包包含用户目录或工具目录，请从项目根目录重新生成: ${polluted.slice(0, 5).join(", ")}`);
  const required = ["package.json", "package-lock.json", "apps/api", "apps/web", "ecosystem.config.cjs", "RELEASE_VERSION"];
  const missing = required.filter((file) => !existsSync(join(root, file)));
  if (missing.length) throw new Error(`发布包缺少: ${missing.join(", ")}`);
  const projectFiles = ["package.json", "package-lock.json", "ecosystem.config.cjs", "apps/api/prisma/schema.prisma", "apps/api/package.json", "apps/web/package.json"];
  const invalid = projectFiles.filter((file) => !existsSync(join(root, file)));
  if (invalid.length) throw new Error(`发布包项目结构不完整: ${invalid.join(", ")}`);
  const version = readFileSync(join(root, "RELEASE_VERSION"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(version)) throw new Error("RELEASE_VERSION 必须是 40 位 Git 提交指纹");
  console.log(`Release archive OK: ${version}`);
} finally { rmSync(root, { recursive: true, force: true }); }
