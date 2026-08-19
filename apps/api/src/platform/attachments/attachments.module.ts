import { Module } from "@nestjs/common";
import { AttachmentsController } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";
import { AuditModule } from "../audit/audit.module";
import { AuthorizationModule } from "../authorization/authorization.module";

@Module({ imports: [AuditModule, AuthorizationModule], controllers: [AttachmentsController], providers: [AttachmentsService] })
export class AttachmentsModule {}
