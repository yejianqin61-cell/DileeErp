import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "./platform/database/database.module";
import { AuthModule } from "./platform/auth/auth.module";
import { AuthorizationModule } from "./platform/authorization/authorization.module";
import { AuditModule } from "./platform/audit/audit.module";
import { DictionariesModule } from "./platform/dictionaries/dictionaries.module";
import { StateMachineModule } from "./platform/state-machine/state-machine.module";
import { AttachmentsModule } from "./platform/attachments/attachments.module";
import { validateEnvironment } from "./platform/config/validate-environment";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }), DatabaseModule, AuthModule, AuthorizationModule, AuditModule, DictionariesModule, StateMachineModule, AttachmentsModule],
  controllers: [HealthController],
})
export class AppModule {}
