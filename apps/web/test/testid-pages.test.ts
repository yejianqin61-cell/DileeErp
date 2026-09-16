// S6：页面根节点 testid 的**约定检查（convention lint），不是行为测试**。
//
// 它只用 node:fs 读取 apps/web/app/**/page.tsx 的源码文本，证明"每个路由页面都声明了 page-<route> 钩子"。
// 它**不能**证明：
//   1) 钩子真的渲染进了 DOM（那是 testid-contract.test.tsx 的渲染断言负责）；
//   2) testid 挂在了正确的元素上（例如挂到了装饰性 div 而不是页面根）。
// 仓库历史上有把源码文本断言当成行为测试的教训（docs/test/00-recon-frontend-coverage.md），
// 因此本文件明确标注为约定检查，请勿用它宣称页面行为覆盖率。
//
// 第二个用例（"没有未登记的新页面"）也不能证明新页面行为正确，只能保证新页面必须补 testid 约定。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 期望的 路由页面文件 → 页面根 testid 映射（apps/web 相对路径，正斜杠）。 */
const EXPECTED: Record<string, string> = {
  "page.tsx": "page-dashboard",
  "login/page.tsx": "page-login",
  "customers/page.tsx": "page-customers",
  "sales/page.tsx": "page-sales",
  "procurement/page.tsx": "page-procurement",
  "qc/page.tsx": "page-qc",
  "qc/incoming/page.tsx": "page-qc-incoming",
  "qc/finished-goods/page.tsx": "page-qc-finished-goods",
  "qc/inbound/page.tsx": "page-qc-inbound",
  "procurement/materials/page.tsx": "page-procurement-materials",
  "procurement/suppliers/page.tsx": "page-procurement-suppliers",
  "procurement/boms/page.tsx": "page-procurement-boms",
  "procurement/orders/page.tsx": "page-procurement-orders",
  "procurement/orders/[id]/page.tsx": "page-procurement-orders-detail",
  "procurement/incoming-qc/page.tsx": "page-procurement-incoming-qc",
  "procurement/inbounds/page.tsx": "page-procurement-inbounds",
  "production/page.tsx": "page-production",
  "production/locations/page.tsx": "page-production-locations",
  "production/operations/page.tsx": "page-production-operations",
  "production/units/page.tsx": "page-production-units",
  "production/orders/[id]/page.tsx": "page-production-orders-id",
  "production/material-issues/page.tsx": "page-production-material-issues",
  "production/material-issues/new/page.tsx": "page-production-material-issues-new",
  "warehouse/page.tsx": "page-warehouse",
  "warehouse/raw-material-storage/page.tsx": "page-warehouse-raw-material-storage",
  "warehouse/finished-goods-storage/page.tsx": "page-warehouse-finished-goods-storage",
  "finance/page.tsx": "page-finance",
  "finance/receivable/page.tsx": "page-finance-receivable",
  "finance/payable/page.tsx": "page-finance-payable",
  "finance/voucher/page.tsx": "page-finance-voucher",
  "finance/salary/page.tsx": "page-finance-salary",
  "finance/salary/ledger/page.tsx": "page-finance-salary-ledger",
  "finance/salary/payments/page.tsx": "page-finance-salary-payments",
  "finance/cash-flow/page.tsx": "page-finance-cash-flow",
  "finance/banks/page.tsx": "page-finance-banks",
  "finance/bank-transfers/page.tsx": "page-finance-bank-transfers",
  "finance/reports/page.tsx": "page-finance-reports",
  "hr/page.tsx": "page-hr",
  "hr/departments/page.tsx": "page-hr-departments",
  "hr/positions/page.tsx": "page-hr-positions",
  "reports/page.tsx": "page-reports",
};

/**
 * 纯重定向页面：不渲染任何页面根节点，因此没有 page-<route> testid。
 * 这类页面必须显式调用 redirect()，否则用户会看到一个空白页（见下面的用例）。
 * 它们仍然要登记在 EXPECTED 里，才能被「没有未登记的页面」用例覆盖。
 */
const REDIRECT_ONLY = new Set(["finance/[section]/page.tsx"]);
Object.assign(EXPECTED, Object.fromEntries([...REDIRECT_ONLY].map((file) => [file, ""])));

const appDir = join(process.cwd(), "app");

/** 去掉注释后再匹配，避免"只写在注释里的 testid"被当成真钩子。 */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function listPageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listPageFiles(full);
    return entry.name === "page.tsx" ? [relative(appDir, full).split(sep).join("/")] : [];
  });
}

describe("data-testid 约定（源码文本检查，非行为测试）", () => {
  it("每个已知路由页面都在源码里声明了 page-<route> 钩子", () => {
    const missing = Object.entries(EXPECTED).filter(([file, testid]) => {
      if (REDIRECT_ONLY.has(file)) return false;
      const source = stripComments(readFileSync(join(appDir, file), "utf8"));
      // 页面可以直接写 data-testid="page-x"，也可以把 testId="page-x" 传给共享工作台组件
      // （组件在数据加载完成后再渲染根节点，因此 testid 不在页面文件里硬编码）。
      return !source.includes(`data-testid="${testid}"`) && !source.includes(`testId="${testid}"`);
    });

    expect(missing).toEqual([]);
  });

  it("纯重定向页面必须真的 redirect()，而不是渲染一个空页面", () => {
    for (const file of REDIRECT_ONLY) {
      const source = stripComments(readFileSync(join(appDir, file), "utf8"));
      expect(source, file).toMatch(/\bredirect\(/);
    }
  });

  it("页面根 testid 的命名是 kebab-case 的 page-<route>", () => {
    const bad = Object.entries(EXPECTED).filter(([file, testid]) => !REDIRECT_ONLY.has(file) && !/^page-[a-z0-9]+(-[a-z0-9]+)*$/.test(testid));

    expect(bad).toEqual([]);
  });

  it("没有未登记的页面：新增 app/**/page.tsx 必须同时补 testid 并登记到本文件", () => {
    const actual = listPageFiles(appDir).sort();
    const expected = Object.keys(EXPECTED).sort();

    expect(actual).toEqual(expected);
  });
});