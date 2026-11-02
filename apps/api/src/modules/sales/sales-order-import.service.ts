import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../../platform/database/prisma.service";
import { parseSalesOrderWorkbook, type ImportedFact, type ImportedUnknown } from "./sales-order-import";

/**
 * 「销售单 Excel 补录」的**第二步**：把解析结果与库里的主数据对上，整理成一张预览载荷。
 *
 * 分工（与全站导入同一套纪律）：
 *   - 纯解析放 `sales-order-import.ts`（不碰库，可脱离数据库测试）；
 *   - 这里只做**查库**的三件事：客户对不对得上、订单号有没有被占用、单位在不在池子里；
 *   - **不写库**：建单仍走 `POST /sales-orders`（同一套 DTO / 归一 / 快照 / 审计）。
 *     补录只是把「手工打字」换成「预先填好」，多一条建单路径就是多一处会慢慢分叉的口径。
 *
 * 为什么"客户对不上"不自动新建客户：客户是主数据（有唯一编码、有结算币种、有联系人），
 * 靠一张旧 Excel 顺手建出来只会让「家百纳 / 家百納 / JBN」各占一条 —— 与物料导入
 * 「不自动新建单位」同一条理由。这里只把原文摆出来，让人在表单里选。
 */
@Injectable()
export class SalesOrderImportService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(file: { buffer?: Buffer; originalname?: string } | undefined): Promise<SalesOrderImportPreview> {
    if (!file?.buffer?.length) throw this.invalid("SALES_ORDER_IMPORT_FILE_REQUIRED", "请上传要补录的 Excel 文件（仅支持 .xlsx / .xls）");
    // 控制器层的 Multer 白名单已经挡过一道；这里再按扩展名挡一次 —— 「上传了一个 CSV/PDF」
    // 应当回一句「只支持 .xlsx/.xls」，而不是让解析器把它读成空表再报「没认出任何字段」。
    if (file.originalname && !/\.(xlsx|xls)$/i.test(file.originalname)) throw this.invalid("SALES_ORDER_IMPORT_INVALID_FILE", "只支持 .xlsx / .xls 文件");

    let parsed;
    try {
      parsed = parseSalesOrderWorkbook(file.buffer);
    } catch {
      throw this.invalid("SALES_ORDER_IMPORT_INVALID_FILE", "这个文件读不出内容（可能已损坏，或是被改过扩展名的非 Excel 文件），请用 Excel 另存为 .xlsx 再试");
    }
    if (!parsed.recognized.length) {
      throw this.invalid("SALES_ORDER_IMPORT_NOTHING_RECOGNIZED", "这张表里没认出任何销售单字段（客户单号 / 数量 / 品名规格 / 材料明细…），请确认传的是销售单或工艺单");
    }

    const [customers, units] = await Promise.all([
      this.prisma.customer.findMany({ where: { deletedAt: null }, select: { id: true, name: true, customerCode: true, currency: true, isActive: true, countryRegion: true }, orderBy: { name: "asc" } }),
      this.prisma.unit.findMany({ where: { deletedAt: null }, select: { name: true, isActive: true }, orderBy: { name: "asc" } }),
    ]);

    const issues: SalesOrderImportIssue[] = [];
    const fields = { ...parsed.fields };
    const customerRaw = (fields.customer_code ?? "").trim();
    delete fields.customer_code;
    const region = (fields.region ?? "").trim();
    delete fields.region;

    // ---- 客户：按「名称 → 编码 → 去掉括号备注的编码」的顺序唯一匹配，对不上就把原文摆出来 ----
    const customer = matchCustomer(customerRaw, customers);
    let customerId: string | null = null;
    if (customer) {
      if (customer.isActive === false) {
        issues.push({ level: "error", field: "customer_id", message: `客户「${customer.name}」已停用，请先启用或换一个客户` });
      } else {
        customerId = customer.id;
      }
    } else if (customerRaw) {
      issues.push({ level: "error", field: "customer_id", message: `客户「${customerRaw}」在客户清单里没对上${region ? `（表里写的地区：${region}）` : ""}，请在表单里选客户` });
    } else {
      issues.push({ level: "error", field: "customer_id", message: "表里没读到客户，请在表单里选客户" });
    }
    // 币种优先用客户的默认币种：Excel 里一般没有币种，空着表单过不了。
    const currency = (fields.currency ?? "").trim() || (customer?.currency ?? "").trim();
    if (currency) fields.currency = currency;
    else issues.push({ level: "warning", field: "currency", message: "币种没读到、客户也没设默认币种，请在上面的「币种」里选" });

    // ---- 单位：按名字（忽略大小写与空格）在单位池里找；找不到就提示，**不自动新建单位** ----
    const unit = (fields.unit ?? "").trim();
    if (unit) {
      const hit = units.find((row) => unitKey(row.name) === unitKey(unit));
      if (hit) {
        if (hit.name !== unit) fields.unit = hit.name;
        if (hit.isActive === false) issues.push({ level: "warning", field: "unit", message: `单位「${hit.name}」已停用，请在「单位」里换一个` });
      } else {
        issues.push({ level: "warning", field: "unit", message: `单位「${unit}」不在单位清单里，请在「单位」里选一个（Excel 数量那一格的单位写法各异）` });
      }
    }

    // ---- 订单号：唯一性是「未删除行上唯一」，所以只查未删除的行（软删单占过的号可以再用） ----
    const orderNo = (fields.order_no ?? "").trim();
    if (!orderNo) {
      issues.push({ level: "error", field: "order_no", message: "表里没读到「客户单号」，请在上面的「订单号」里填（系统里不能重号）" });
    } else {
      const taken = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true, status: true } });
      if (taken) {
        issues.push({ level: "error", field: "order_no", message: `订单号 ${orderNo} 在系统里已经有一张单了（状态：${statusLabel(taken.status)}）。补录历史单请改用表上原来的号，或在这一格里改一个没用过的号` });
      }
    }
    for (const [field, label] of [["order_date", "下单日期"], ["product_name", "品名规格"], ["quantity", "数量"]] as const) {
      if (!(fields[field] ?? "").trim()) issues.push({ level: "error", field, message: `表里没读到「${label}」，请手工填` });
    }
    if (!(fields.delivery_date ?? "").trim()) issues.push({ level: "warning", field: "delivery_date", message: "表里没读到完工/交货日期，请确认后再建单" });

    // ---- 细分明细：品名是必填（表里可能只填了数量） ----
    const details = parsed.details.map((row, index) => {
      if (!row.name.trim()) issues.push({ level: "warning", field: "spec_details", message: `细分明细第 ${index + 1} 行没填品名/品番（表里只有数量），请补上或删掉这一行` });
      return { ...row, group_name: row.group_name || "明细", sort_order: index };
    });

    const missing = (["order_no", "customer_id", "order_date", "product_name", "quantity", "unit", "currency"] as const)
      .filter((field) => (field === "customer_id" ? !customerId : !(fields[field] ?? "").trim()))
      .map((field) => FIELD_LABELS[field]);

    return {
      file_name: file.originalname ?? "",
      sheet_name: parsed.sheet_name,
      status: issues.some((issue) => issue.level === "error") ? "partial" : "ok",
      customer_id: customerId,
      customer: customer ? { id: customer.id, name: customer.name, customer_code: customer.customerCode, currency: customer.currency ?? null, matched_by: customer.matchedBy } : null,
      customer_raw: customerRaw,
      // 预填载荷与「返单 / 复制」同一个形状（请求键），编辑器可以用同一个函数一次性灌进表单。
      copy: {
        ...fields,
        spec_details: details,
        material_extras: parsed.extras.map((row) => ({ label: row.label, content: row.content, ...(row.spec_key ? { spec_key: row.spec_key } : {}), sort_order: row.sort_order })),
      },
      must_fill: missing,
      issues,
      warnings: parsed.warnings,
      recognized: parsed.recognized,
      unrecognized: parsed.unrecognized,
      summary: {
        recognized: parsed.recognized.length,
        detail_rows: details.length,
        extra_rows: parsed.extras.length,
        fills: Object.keys(fields).length,
        missing,
      },
    };
  }

  private invalid(code: string, message: string) {
    return new UnprocessableEntityException({ code, message, details: [] });
  }
}

export type SalesOrderImportIssue = { level: "error" | "warning"; field?: string; message: string };
export type SalesOrderImportCustomer = { id: string; name: string; customer_code: string; currency: string | null; matched_by: string };
export type SalesOrderImportPreview = {
  file_name: string;
  sheet_name: string;
  status: "ok" | "partial";
  customer_id: string | null;
  customer: SalesOrderImportCustomer | null;
  customer_raw: string;
  /** 直接喂给销售单编辑器的预填载荷（与 `reorder-preview` / `copy-snapshot` 的 `copy` 同一形状）。 */
  copy: Record<string, unknown>;
  must_fill: string[];
  issues: SalesOrderImportIssue[];
  warnings: string[];
  recognized: ImportedFact[];
  unrecognized: ImportedUnknown[];
  summary: { recognized: number; detail_rows: number; extra_rows: number; fills: number; missing: string[] };
};

const FIELD_LABELS: Record<string, string> = {
  order_no: "订单号",
  customer_id: "客户",
  order_date: "下单日期",
  product_name: "品名规格",
  quantity: "数量",
  unit: "单位",
  currency: "币种",
};

const statusLabel = (status: string): string => ({ draft: "草稿", confirmed: "已确认", closed: "已关闭" } as Record<string, string>)[status] ?? status;

/** 名字比对用：去掉全部空白与标点、转小写（「家百纳」「家 百 纳」「ＪＢＮ」在纸上都可能是同一个客户）。 */
const unitKey = (text: string): string => text.replace(/[\s\u3000]/g, "").toLowerCase();

/**
 * 客户匹配（导出给单测：这段是「对不上就别猜」的判定，值得被单独钉住）。
 *
 * 只做**唯一命中**：名称全等、编码全等、或去掉括号备注后的编码全等（样本2 写的是「IS（PO32366-1)」，
 * 括号里是客户自己的 PO，不参与匹配）。不做模糊匹配 —— 「IS」与「ISUZU」这样的前缀关系
 * 猜错一次，这张单的应收就挂到了另一个客户头上，而错账没人会当场发现。
 */
export function matchCustomer(raw: string, customers: ReadonlyArray<{ id: string; name: string; customerCode: string; currency: string | null; isActive: boolean; countryRegion: string | null }>): (typeof customers)[number] & { matchedBy: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const variants = [text, text.replace(/[（(][^（）()]*[）)]/g, ""), text.replace(/[（(].*$/, "")].map((value) => value.replace(/\s+/g, "")).filter(Boolean);
  const byName = new Map(customers.map((row) => [row.name.replace(/\s+/g, ""), row]));
  const byCode = new Map(customers.map((row) => [row.customerCode.replace(/\s+/g, "").toLowerCase(), row]));
  for (const variant of variants) {
    const nameHit = byName.get(variant);
    if (nameHit) return { ...nameHit, matchedBy: `客户名称「${nameHit.name}」` };
    const codeHit = byCode.get(variant.toLowerCase());
    if (codeHit) return { ...codeHit, matchedBy: `客户编码「${codeHit.customerCode}」` };
  }
  return null;
}
