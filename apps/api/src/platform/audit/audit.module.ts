import { Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { AuditActorService } from "./audit-actor.service";

@Module({ providers: [AuditService, AuditActorService], exports: [AuditService, AuditActorService] })
export class AuditModule {}
