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
  const required = ["package.json", "package-lock.json", "apps/api", "apps/web", "ecosystem.config.cjs", "RELEASE_VERSION"];
  const missing = required.filter((file) => !existsSync(join(root, file)));
  if (missing.length) throw new Error(`发布包缺少: ${missing.join(", ")}`);
  const version = readFileSync(join(root, "RELEASE_VERSION"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(version)) throw new Error("RELEASE_VERSION 必须是 40 位 Git 提交指纹");
  console.log(`Release archive OK: ${version}`);
} finally { rmSync(root, { recursive: true, force: true }); }
