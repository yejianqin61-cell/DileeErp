import { Module } from "@nestjs/common";
import { StateMachineService } from "./state-machine.service";
import { AuditModule } from "../audit/audit.module";

@Module({ imports: [AuditModule], providers: [StateMachineService], exports: [StateMachineService] })
export class StateMachineModule {}
