import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "./platform/database/database.module";
import { InventoryModule } from "./platform/inventory/inventory.module";
import { AuthModule } from "./platform/auth/auth.module";
import { AuthorizationModule } from "./platform/authorization/authorization.module";
import { AuditModule } from "./platform/audit/audit.module";
import { DictionariesModule } from "./platform/dictionaries/dictionaries.module";
import { StateMachineModule } from "./platform/state-machine/state-machine.module";
import { AttachmentsModule } from "./platform/attachments/attachments.module";
import { validateEnvironment } from "./platform/config/validate-environment";
import { SalesModule } from "./modules/sales/sales.module";
import { FormsModule } from "./platform/forms/forms.module";
import { ProcurementModule } from "./modules/procurement/procurement.module";
import { ProductionModule } from "./modules/production/production.module";
import { FinanceModule } from "./modules/finance/finance.module";
import { HrModule } from "./modules/hr/hr.module";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }), DatabaseModule, InventoryModule, AuthModule, AuthorizationModule, AuditModule, DictionariesModule, StateMachineModule, AttachmentsModule, FormsModule, ProcurementModule, ProductionModule, SalesModule, FinanceModule, HrModule],
  controllers: [HealthController],
})
export class AppModule {}
