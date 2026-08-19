import { Module } from "@nestjs/common";
import { DictionariesController } from "./dictionaries.controller";
import { DictionariesService } from "./dictionaries.service";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationModule } from "../authorization/authorization.module";

@Module({ imports: [AuditModule, AuthorizationModule], controllers: [DictionariesController], providers: [DictionariesService] })
export class DictionariesModule {}
