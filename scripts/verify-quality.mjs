import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "quick";
const commands = mode === "quick"
  ? [["npm", ["run", "typecheck"]], ["npm", ["run", "test:unit"]], ["npm", ["run", "build", "--workspace=@dilee/api"]], ["npm", ["run", "build", "--workspace=@dilee/web"]]]
  : [["npm", ["run", "db:test:prepare"]], ["npm", ["run", "test:integration"]], ["npm", ["run", "test:api"]], ["npm", ["run", "test:e2e"]]];

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const results = commands.map(([command, args]) => {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096" } });
  return { command: [command, ...args].join(" "), status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll(/(password|token|cookie)=\S+/gi, "$1=[REDACTED]") };
});

mkdirSync("docs/test/results", { recursive: true });
const lines = [`# ${mode === "quick" ? "快速" : "链路"}质量门禁结果`, "", `- 提交：\`${commit}\``, `- 时间：${new Date().toISOString()}`, `- 环境：${mode === "chain" ? "真实测试库/API/浏览器，缺失时明确阻断" : "本地快速静态与领域测试"}`, "", "| 命令 | 退出码 | 结果 |", "| --- | ---: | --- |", ...results.map((result) => `| \`${result.command}\` | ${result.status} | ${result.status === 0 ? "通过" : result.status === 3 ? "环境阻断" : "失败"} |`), "", "## 诊断摘要", "", ...results.filter((result) => result.status !== 0).map((result) => `### ${result.command}\n\n\`\`\`text\n${result.output.trim()}\n\`\`\``)];
writeFileSync(`docs/test/results/latest-${mode}-quality-gate.md`, `${lines.join("\n").trimEnd()}\n`);
process.exit(results.some((result) => result.status !== 0) ? 1 : 0);
