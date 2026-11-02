"use client";

// 销售单 Excel 补录（2026-11-02）。
//
// 用户原话：「针对销售模块，现在要加一个补录功能。用户上传销售单 excel，系统进行字段读取与匹配，
// 展示一份系统表单，让用户进行修改与确认。用户通过之后，再确认建立销售单。」
//
// 这一页只做**第一步**：选文件 → 上传 → 解析（服务端只读，不写库）。解析成功后把结果交给
// `SalesOrderEditor`（同一张系统表单，预填好），由它负责「修改 → 确认建立销售单」。
//
// 为什么补录要单独一页而不是塞在「新建销售单」页头：
//   · 新建页点开就该是一张空表（销售手上有单子上的信息要打），先弹一个文件选择器会打断这条最常见的路；
//   · 补录是**偶发动作**（历史单、客户发来的 Excel），不该平时占版面 —— 与【返单与总结】里
//     「未填货号（补录）」那个折叠面板同一条理由。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "../../../../components/layout/app-shell";
import { Button } from "../../../../components/ui/button";
import { FileInput } from "../../../../components/ui/file-input";
import { ErrorState, LoadingState } from "../../../../components/feedback/states";
import { SalesOrderEditor } from "../../../../components/sales/sales-order-editor";
import { ApiClientError } from "../../../../lib/api-client";
import { SALES_ORDER_IMPORT_ACCEPT, SALES_ORDER_IMPORT_PATH, importFileProblem, type SalesOrderImportResult } from "../../../../lib/sales-order-import";

/** 后端错误信封（multipart 走原生 fetch，所以这里自己解一层）。 */
type ImportFailure = { error?: { code?: string; message?: string; details?: unknown[] } };

export default function SalesOrderImportPage() {
  const router = useRouter();
  const [result, setResult] = useState<SalesOrderImportResult | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  async function read(file: File | undefined) {
    const problem = importFileProblem(file);
    if (problem) { setError(problem); return; }
    setReading(true);
    setError("");
    try {
      // multipart 只能自己 fetch：`apiPost` 会把 body JSON 化（见 lib/material-import.ts 的同一条注释）。
      const form = new FormData();
      form.append("file", file as File);
      const response = await fetch(SALES_ORDER_IMPORT_PATH, { method: "POST", credentials: "include", body: form });
      const body = await response.json().catch(() => null) as ({ data?: SalesOrderImportResult } & ImportFailure) | null;
      if (!response.ok || !body?.data || body.error) {
        throw new ApiClientError(body?.error?.code ?? "SALES_ORDER_IMPORT_FAILED", body?.error?.message ?? "读取失败", body?.error?.details ?? []);
      }
      setResult(body.data);
    } catch (cause) {
      // 错误整条留在页面上（不做成 toast）：用户要能照着「没认出任何销售单字段」这类话去换文件/改表。
      setError(cause instanceof ApiClientError ? cause.message : "读取失败：请确认文件没有损坏、且是 .xlsx / .xls");
    } finally {
      setReading(false);
    }
  }

  // 解析成功后整页换成系统表单（表单一律带自己的页头与保存按钮）。
  if (result) {
    return <SalesOrderEditor imported={result} onReimport={() => { setResult(null); setError(""); }} />;
  }

  return (
    <div className="page-root" data-testid="page-sales-orders-import">
      <PageHeader title="销售单补录（Excel）" breadcrumb={["客户与销售", "销售单", "补录"]}>
        <Button variant="secondary" onClick={() => router.push("/sales/orders")}>返回销售单列表</Button>
      </PageHeader>
      <section className="panel">
        <div className="panel-heading">
          <h2>第 1 步：上传要补录的 Excel</h2>
          <span className="panel-note">支持 .xlsx / .xls，单件最大 10MB</span>
        </div>
        <div className="panel-body">
          <p className="panel-note">
            传我们自己的工艺单/生产单可以（客户单号、数量、品名规格、材料明细、工艺要求、伞布明细都会被读出来），
            客户发来的订单表也可以先读一遍：认得出的格子先填好，认不出的会列成清单让你在表单里补。
            <strong>这一步不会写进系统</strong>，读完你会看到一份填好的销售单表单。
          </p>
          <div className="filter-bar">
            <FileInput
              accept={SALES_ORDER_IMPORT_ACCEPT}
              data-testid="sales-order-import-file"
              disabled={reading}
              onChange={(event) => { void read(event.target.files?.[0]); event.currentTarget.value = ""; }}
            />
          </div>
          {reading && <LoadingState label="正在读取 Excel（大文件带图时会慢几秒）" />}
          {error && <ErrorState message={error} />}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>第 2 步：核对系统表单并建单</h2><span className="panel-note">读完就进这一步</span></div>
        <div className="panel-body">
          <ul className="panel-note">
            <li>系统会把读出来的内容填进<strong>正式的新建销售单表单</strong>（不是另做一张"导入表"），你改的就是最终要存的东西；</li>
            <li>核对清单会写清每一格是从哪个单元格读来的，以及哪几项<strong>必须改</strong>（比如客户对不上、订单号已被占用、数量没读到）；</li>
            <li>改完点右上角「确认建立销售单」，走的仍是新建销售单那一套校验与建档（草稿状态，之后照常「确认」下单）；</li>
            <li>中途想换文件，点表单右上角「换一个文件重新读取」即可，不会留下半张单。</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
