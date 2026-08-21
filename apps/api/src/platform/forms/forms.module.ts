import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";

@Module({ imports: [AuditModule], controllers: [FormsController], providers: [FormsService], exports: [FormsService] })
export class FormsModule {}
