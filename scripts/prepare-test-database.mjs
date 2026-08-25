import { spawnSync } from "node:child_process";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(url)) {
  console.error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");
  process.exit(3);
}

const env = { ...process.env, DATABASE_URL: url };
for (const args of [["migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]]) {
  // ponytail: migration preparation never needs client regeneration; Windows may lock its native engine while the API runs.
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", ...args], { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
