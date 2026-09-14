import { Global, Module } from "@nestjs/common";
import { CurrencyService } from "./currency.service";

/**
 * 币种字典是跨模块（销售、采购、财务、人事）的公共口径，
 * 设为 @Global 让各业务模块无需逐个 imports 即可注入 CurrencyService。
 */
@Global()
@Module({ providers: [CurrencyService], exports: [CurrencyService] })
export class CurrencyModule {}
