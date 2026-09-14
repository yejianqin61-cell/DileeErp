import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { CURRENCY_DICTIONARY_KEY, DEFAULT_CURRENCIES, type CurrencyCatalogItem } from "./currency-catalog";

/**
 * 币种字典的平台服务。
 *
 * 决策依据：`docs/product/PRD.md`「支持多币种，币种为可配置字典」、
 * `docs/product/SRS.md`「币种……应支持授权用户通过管理接口维护，不写死在前端或后端代码中」，
 * 以及 `.agent/constitution/constitution.md` 的「Configurable Business Categories」。
 *
 * 因此币种不是枚举常量，而是 `dictionary_types.key = "currency"` 下的字典项：
 * 前端通过既有接口 `GET /dictionaries/currency/items` 取启用项渲染下拉，
 * 后端在所有写入币种的入口用本服务做一致性校验。
 */
export { CURRENCY_DICTIONARY_KEY, DEFAULT_CURRENCIES };
export type CurrencyOption = CurrencyCatalogItem;

@Injectable()
export class CurrencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** 按字典维护顺序返回启用币种。 */
  async listActive(): Promise<CurrencyOption[]> {
    return this.prisma.dictionaryItem.findMany({
      where: { deletedAt: null, isActive: true, type: { key: CURRENCY_DICTIONARY_KEY, deletedAt: null } },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { key: true, label: true, sortOrder: true },
    });
  }

  /**
   * 校验币种编码是否落在启用字典内。
   *
   * 兜底规则：字典尚未建立或无启用项时放行任意非空编码。
   * 理由是「字典缺失」属于部署/迁移状态问题，不应该把全站金额录入直接锁死；
   * 一旦字典有启用项，就以字典为唯一口径强校验。
   */
  async assertSupported(code: string | null | undefined, field = "币种"): Promise<void> {
    const value = code?.trim();
    if (!value) return;
    const active = await this.listActive();
    if (!active.length) return;
    if (active.some((item) => item.key === value)) return;
    throw new UnprocessableEntityException({
      code: "CURRENCY_NOT_SUPPORTED",
      message: `${field}「${value}」不在启用的币种字典中`,
      details: [{ currency: value, supported: active.map((item) => item.key) }],
    });
  }

  /** 宽松版本：只回答「是否受支持」，不抛异常。 */
  async isSupported(code: string | null | undefined): Promise<boolean> {
    try {
      await this.assertSupported(code);
      return Boolean(code?.trim());
    } catch {
      return false;
    }
  }
}
