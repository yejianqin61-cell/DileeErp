import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { paginated } from "../../platform/http/api-contract";
import { slipTotals, validateFinanceSlipShape, type FinanceSlip, type FinanceSlipKind, type FinanceSlipLine } from "./finance-slip";

/**
 * 收/付款单的**存档**（用户 2026-09-26：「付款单要有填写汇率的地方，**保存键**」）。
 *
 * ## 它解决的不是记账问题
 *
 * 2026-09-20 那一轮的口径是「单子不落库 —— 它是一张打印件，不是系统单据」：预填 → 财务改 →
 * 导出 xlsx，关掉弹窗就没了。用户现在要一个「保存键」，理由很具体：一次集中付款会拆出十几张
 * 单子，她改到第五张去接个电话，回来只能从头再勾一遍、再改一遍。
 *
 * 所以保存**只存这张单子本身**：不写收支流水、不生成凭证、不动应付/应收的状态与金额。
 * 「钱到底付没付」仍然由确认付款那条链回答（`supplier-payment.service.ts`）——
 * 一张单子是拿去银行/走签字的纸，不是记账动作。这条边界必须守住，否则会出现
 * 「存了一张付款单，应付就自己变成已付」这种没人能解释的账。
 *
 * ## 两条口径
 *
 * 1. **保存只拦结构**（`validateFinanceSlipShape`）：编号、对方单位、借贷平衡是**导出前**才必须满足的。
 *    逼财务填平了才能存，等于把「保存」变成「必须一次做完」。
 * 2. **改了再存是覆盖同一张**（服务端按 id 更新，且**整组分录行重写**）：单子的行序就是它印出来的样子，
 *    逐行 diff 只会让「行号」与「单子上的第 N 行」慢慢对不上。
 */
@Injectable()
export class FinanceSlipStoreService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * 列举已保存的单子（按单据日期倒序，同一天按保存时间倒序）。
   *
   * 默认只回**没删的**：软删掉的是「录错作废」，翻列表时不该混在里面。
   */
  async list(query: { kind?: string; page: number; pageSize: number; counterparty?: string }) {
    const where = {
      deletedAt: null,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.counterparty?.trim() ? { counterpartyName: { contains: query.counterparty.trim(), mode: "insensitive" as const } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.financeSlip.findMany({
        where,
        include: { lines: { orderBy: { lineNo: "asc" } } },
        orderBy: [{ slipDate: "desc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.financeSlip.count({ where }),
    ]);
    return paginated(rows.map((row) => this.toSlip(row)), query.page, query.pageSize, total);
  }

  /** 取一张单子（列表与编辑器打开时都用它）。已删除的按 404 处理：软删就是「作废了」。 */
  async get(id: string) {
    const row = await this.prisma.financeSlip.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!row) throw this.notFound("FINANCE_SLIP_NOT_FOUND", "这张单据不存在或已被删除");
    return this.toSlip(row);
  }

  /**
   * 新建或覆盖一张单子。
   *
   * `id` 给了就是覆盖（编辑器里第二次点保存走这条）：**必须带 id 更新而不是又新建一张** ——
   * 不然财务点两次保存就得到两张一模一样的单子，而她分不出哪张是最后改的。
   */
  async save(slip: FinanceSlip, sourceEntryIds: string[] | undefined, user: CurrentUser, id?: string) {
    const problems = validateFinanceSlipShape(slip);
    if (problems.length) {
      throw new UnprocessableEntityException({
        code: problems[0].code,
        message: problems.map((problem) => problem.message).join("；"),
        details: problems.map((problem) => ({ code: problem.code, ...(problem.details[0] ?? {}) })),
      });
    }
    const data = this.headerData(slip);
    const lines = slip.lines.map((line, index) => this.lineData(line, index + 1));

    const row = await this.prisma.$transaction(async (tx) => {
      if (id) {
        const exists = await tx.financeSlip.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
        if (!exists) throw this.notFound("FINANCE_SLIP_NOT_FOUND", "这张单据不存在或已被删除");
        // 整组重写分录行：行号就是单子上的第 N 行，逐行 diff 会让它与实际印出来的序列错位。
        await tx.financeSlipLine.deleteMany({ where: { slipId: id } });
        return tx.financeSlip.update({
          where: { id },
          data: {
            ...data,
            ...(sourceEntryIds ? { sourceEntryIds } : {}),
            ...this.audit.update(user),
            lines: { create: lines },
          },
          include: { lines: { orderBy: { lineNo: "asc" } } },
        });
      }
      return tx.financeSlip.create({
        data: {
          ...data,
          ...(sourceEntryIds ? { sourceEntryIds } : {}),
          ...this.audit.create(user),
          lines: { create: lines },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
    });

    const totals = slipTotals(slip.lines);
    await this.audit.record(`${slip.kind}_slip.save`, `${slip.kind}_slip`, user.id, row.id, {
      slip_no: row.slipNo,
      counterparty_name: row.counterpartyName,
      currency: row.currency,
      exchange_rate: row.exchangeRate?.toString() ?? null,
      amount_cny: row.amountCny?.toString() ?? null,
      amount: totals.debit,
      line_count: row.lines.length,
      // 覆盖保存要在审计里看得出来（「这张单子被谁在什么时候改过」是事后唯一能查的东西）。
      created: !id,
    });
    return this.toSlip(row);
  }

  /**
   * 删除一张单子（**逻辑**删除）。删了就是「这张作废了」，列表与再打开都看不到它。
   *
   * 删除原因必填（与全站逻辑删除同一条纪律）：单据是财务会拿去找银行/入账的纸，
   * 事后必须说得清「那张编号 XXX 的单子为什么没了」。
   */
  async remove(id: string, reason: string, user: CurrentUser) {
    const text = (reason ?? "").trim();
    if (!text) throw this.invalid("FINANCE_SLIP_DELETE_REASON_REQUIRED", "请填写删除原因");
    const row = await this.prisma.financeSlip.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw this.notFound("FINANCE_SLIP_NOT_FOUND", "这张单据不存在或已被删除");
    await this.prisma.financeSlip.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record(`${row.kind}_slip.delete`, `${row.kind}_slip`, user.id, id, {
      slip_no: row.slipNo,
      counterparty_name: row.counterpartyName,
      reason: text,
    });
    return { id, deleted: true };
  }

  // ------------------------------------------------------------------ 行 ↔ 表

  /** 表头 → 数据库列。空串照原样存（模板上「没填」就是一格空白，不是 NULL 也不是 0）。 */
  private headerData(slip: FinanceSlip) {
    return {
      kind: slip.kind,
      slipNo: slip.slip_no.trim(),
      slipDate: new Date(`${slip.slip_date}T00:00:00.000Z`),
      slipMethod: slip.slip_method.trim(),
      counterpartyName: slip.counterparty_name.trim(),
      currency: (slip.currency ?? "").trim() || "CNY",
      // 空串 → NULL：空单元格与「填了 0」是两件事（全站的「空 ≠ 0」纪律）。
      exchangeRate: (slip.exchange_rate ?? "").trim() || null,
      amountCny: (slip.amount_cny ?? "").trim() || null,
      ourBankName: (slip.our_bank_name ?? "").trim(),
      ourBankAccount: (slip.our_bank_account ?? "").trim(),
      counterpartyBankName: (slip.counterparty_bank_name ?? "").trim(),
      counterpartyBankAccount: (slip.counterparty_bank_account ?? "").trim(),
      attachmentCount: slip.attachment_count,
      remark: (slip.remark ?? "").trim(),
      maker: (slip.maker ?? "").trim(),
    };
  }

  /** 一行分录 → 数据库行。`debit`/`credit` 空串存 NULL（见 `headerData` 的同一条理由）。 */
  private lineData(line: FinanceSlipLine, lineNo: number) {
    return {
      lineNo,
      summary: (line.summary ?? "").trim(),
      generalSubject: (line.general_subject ?? "").trim(),
      detailSubject: (line.detail_subject ?? "").trim(),
      debit: (line.debit ?? "").trim() || null,
      credit: (line.credit ?? "").trim() || null,
      remark: (line.remark ?? "").trim(),
    };
  }

  /** 数据库行 → 纯函数要的形状（与预填同一形状，编辑器因此可以直接打开一张已保存的单子）。 */
  private toSlip(row: {
    id: string; kind: string; slipNo: string; slipDate: Date; slipMethod: string; counterpartyName: string;
    currency: string; exchangeRate: unknown; amountCny: unknown;
    ourBankName: string; ourBankAccount: string; counterpartyBankName: string; counterpartyBankAccount: string;
    attachmentCount: number; remark: string; maker: string;
    sourceEntryIds: unknown; createdAt: Date; updatedAt: Date;
    lines: Array<{ summary: string; generalSubject: string; detailSubject: string; debit: unknown; credit: unknown; remark: string }>;
  }): SavedFinanceSlip {
    return {
      id: row.id,
      kind: row.kind as FinanceSlipKind,
      slip_no: row.slipNo,
      // 只取日期部分：`slip_date` 是 DATE 列，但读回来仍是 UTC 零点的 Date，
      // 直接 toISOString() 在 UTC+8 的机器上会差一天（那正是全站日期字段的统一处理）。
      slip_date: row.slipDate.toISOString().slice(0, 10),
      slip_method: row.slipMethod,
      counterparty_name: row.counterpartyName,
      currency: row.currency,
      exchange_rate: row.exchangeRate === null || row.exchangeRate === undefined ? "" : String(row.exchangeRate),
      amount_cny: row.amountCny === null || row.amountCny === undefined ? "" : String(row.amountCny),
      our_bank_name: row.ourBankName,
      our_bank_account: row.ourBankAccount,
      counterparty_bank_name: row.counterpartyBankName,
      counterparty_bank_account: row.counterpartyBankAccount,
      attachment_count: row.attachmentCount,
      remark: row.remark,
      maker: row.maker,
      lines: row.lines.map((line) => ({
        summary: line.summary,
        general_subject: line.generalSubject,
        detail_subject: line.detailSubject,
        debit: line.debit === null || line.debit === undefined ? "" : String(line.debit),
        credit: line.credit === null || line.credit === undefined ? "" : String(line.credit),
        remark: line.remark,
      })),
      source_entry_ids: Array.isArray(row.sourceEntryIds) ? (row.sourceEntryIds as string[]) : [],
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
}

/**
 * 已保存的单子在接口上的形状：**就是预填的那张单子 + 存档信息**。
 *
 * 为什么刻意与预填同形状（`FinanceSlip` 加三个字段）：前端打开一张已保存的单子走的
 * 就是「打开一张预填结果」那条路（同一个编辑器组件）。多一层壳（`{ slip: {...} }` 里再分
 * `header` / `lines`）会让前端多两处转换，而转换一多，「编辑时丢了一个字段」就只是时间问题。
 */
export type SavedFinanceSlip = FinanceSlip & {
  id: string;
  /** 预填时勾选的条目 id（追溯用，只读）。 */
  source_entry_ids: string[];
  created_at: string;
  updated_at: string;
};
