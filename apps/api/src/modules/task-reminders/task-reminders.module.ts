import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { TaskRemindersController } from "./task-reminders.controller";
import { TaskRemindersService } from "./task-reminders.service";

@Module({ imports: [AuditModule], controllers: [TaskRemindersController], providers: [TaskRemindersService] })
export class TaskRemindersModule {}
