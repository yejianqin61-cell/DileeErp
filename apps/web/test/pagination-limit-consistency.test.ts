// 分页上限的一致性守卫（2026-11-27）。
//
// 为什么需要它：用户报「所有单据前端最多只能显示 200 单，再多就展示不了了」。
// 查下来不是 bug，是**护栏**——`MAX_PAGE_SIZE=200` 当初是「一次拉全量再前端过滤」的防呆上限。
// 但它在仓库里散成了五处各写一遍（控制器 200、工作台服务 500、报表 200、前端 200…），
// 于是「改一处、漏五处」几乎必然发生，而漏掉的表现是：
//   · 前端传 1000、后端 DTO 拒 400（用户看到「加载失败」）；
//   · 或者前端仍传 200，后端放宽了也没用（用户还是只看到 200 单）。
//
// 这条用例不测行为，只测**同一个数字有没有在两处写成两个值**。
// 它读源码文本，和 testid-pages 那条守卫是同一个思路：跨文件一致性只能靠静态检查钉住。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..");
const apiRoot = join(repoRoot, "apps", "api", "src");

function read(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

/** 去掉注释，避免注释里的旧数字把断言误导成"还写死着 200"。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("分页上限：真源只有一处，其余必须引用它", () => {
  it("真源是 1000（2026-11-27 从 200 提到 1000）", () => {
    const source = read(apiRoot, "platform", "http", "pagination-query.dto.ts");
    expect(source).toContain("export const MAX_PAGE_SIZE = 1000");
  });

  it("没有任何控制器再写死 @Max(200)", () => {
    const files = [
      ["modules", "order-workbench", "order-workbench.controller.ts"],
      ["modules", "reorder", "reorder.controller.ts"],
      ["modules", "reports", "reports.controller.ts"],
      ["modules", "production", "production-progress.controller.ts"],
    ] as const;
    const offenders = files.filter((segments) => stripComments(read(apiRoot, ...segments)).includes("@Max(200)"));
    expect(offenders, `这些文件还在写死 @Max(200)，应改为 @Max(MAX_PAGE_SIZE)`).toEqual([]);
  });

  it("服务层的硬上限也引用真源，不再各写一个数", () => {
    const workbench = read(apiRoot, "modules", "order-workbench", "order-workbench.service.ts");
    expect(workbench).toContain("MAX_PAGE_SIZE");

    const reorder = read(apiRoot, "modules", "reorder", "reorder.service.ts");
    expect(reorder).toContain("GLOBAL_MAX_PAGE_SIZE");

    const alerts = stripComments(read(apiRoot, "modules", "alerts", "alerts.service.ts"));
    expect(alerts).toContain("MAX_PAGE_SIZE");
    expect(alerts).not.toMatch(/Math\.min\(query\.page_size \?\? 20, 200\)/);
  });

  it("报表导出不受列表上限夹取（否则导出永远只有 200 行）", () => {
    const reports = read(apiRoot, "modules", "reports", "reports.service.ts");
    // 导出必须传自己的上限，而不是走默认的列表上限
    expect(reports).toMatch(/EXPORT_ROW_LIMIT/);
    expect(reports).toMatch(/this\.query\(report, \{[^}]*page_size: EXPORT_ROW_LIMIT[^}]*\}, EXPORT_ROW_LIMIT\)/);
    // take() 必须接受 cap 参数
    expect(reports).toMatch(/private take\(query: Query, cap: number = MAX_PAGE_SIZE\)/);
  });

  it("前端不再有页面写死 page_size=200", () => {
    const sources = [
      ["app", "workbench.tsx"],
      ["app", "production", "page.tsx"],
      ["app", "procurement", "boms", "page.tsx"],
      ["components", "production", "production-order-detail-page.tsx"],
      ["components", "sales", "customer-pool.tsx"],
      ["components", "sales", "sales-order-editor.tsx"],
    ] as const;
    const webRoot = join(repoRoot, "apps", "web");
    const offenders = sources.filter((segments) =>
      stripComments(read(webRoot, ...segments)).includes("page_size=200"),
    );
    expect(offenders, "这些前端文件还在写死 page_size=200，用户会只看到前 200 单").toEqual([]);
  });

  it("前端传的量不超过后端上限（超了就是 400）", () => {
    const source = read(join(repoRoot, "apps", "web"), "lib", "sales-order-sort.ts");
    const match = source.match(/SALES_ORDER_LIST_PAGE_SIZE = (\d+)/);
    expect(match, "销售单列表的每页条数应是一个具名常量").not.toBeNull();
    const frontendSize = Number(match![1]);
    const backendCap = Number(
      read(apiRoot, "platform", "http", "pagination-query.dto.ts").match(/MAX_PAGE_SIZE = (\d+)/)![1],
    );
    expect(frontendSize).toBeLessThanOrEqual(backendCap);
  });
});
