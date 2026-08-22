import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

export async function runEndpoint(baseUrl, path, total, concurrency, cookie) {
  const durations = [];
  const errors = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const started = performance.now();
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { headers: cookie ? { cookie } : {} });
        const duration = performance.now() - started;
        durations.push(duration);
        if (!response.ok) errors.push(`${response.status} ${path}`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { path, total, success: total - errors.length, errors, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99) };
}

async function main() {
  const baseUrl = process.env.PERF_BASE_URL;
  if (!baseUrl) {
    console.error("PERF_BLOCKED: PERF_BASE_URL is required");
    process.exitCode = 3;
    return;
  }
  const total = Number(process.env.PERF_REQUESTS ?? 30);
  const concurrency = Number(process.env.PERF_CONCURRENCY ?? 3);
  const cookie = process.env.PERF_COOKIE;
  const endpoints = [
    ["/api/v1/health", 1000],
    ["/api/v1/order-workbench/orders?page=1&page_size=20", 1000],
    ["/api/v1/reports/orders?page=1&page_size=20", 3000],
  ];
  const results = [];
  for (const [path, limit] of endpoints) {
    const result = await runEndpoint(baseUrl, path, total, concurrency, cookie);
    results.push({ ...result, p95_limit_ms: limit, passed: result.errors.length === 0 && result.p95 <= limit });
  }
  const output = { base_url: baseUrl, requests: total, concurrency, results, passed: results.every((result) => result.passed) };
  const outputPath = process.env.PERF_OUTPUT ?? "docs/test/results/latest-performance.json";
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (!output.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
