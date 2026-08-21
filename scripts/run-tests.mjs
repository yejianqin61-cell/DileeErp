import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "unit";
const commands = {
  unit: ["npm", ["run", "build", "--workspace=@dilee/api"]],
  api: ["npm", ["run", "build", "--workspace=@dilee/api"]],
  integration: ["npm", ["run", "test:integration:raw"]],
  e2e: ["npm", ["run", "test:e2e:raw"]],
  chain: ["npm", ["run", "test:api"]],
};

if (!commands[mode]) {
  console.error(`Unknown test mode: ${mode}`);
  process.exit(2);
}

if (mode === "integration" && !process.env.DATABASE_URL) {
  console.error("TEST_BLOCKED: DATABASE_URL is required for PostgreSQL integration tests");
  process.exit(3);
}

if (mode === "e2e" && !process.env.PLAYWRIGHT_BASE_URL) {
  console.error("TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required for browser tests");
  process.exit(3);
}

const [command, args] = commands[mode];
const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
