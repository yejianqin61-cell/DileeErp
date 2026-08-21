import { spawnSync } from "node:child_process";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url)) {
  console.error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");
  process.exit(3);
}

const env = { ...process.env, DATABASE_URL: url };
for (const args of [["prisma", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"], ["prisma", "generate", "--schema", "apps/api/prisma/schema.prisma"]]) {
  const result = spawnSync("npx", args, { env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
