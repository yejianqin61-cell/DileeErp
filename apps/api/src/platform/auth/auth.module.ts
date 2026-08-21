import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuditModule } from "../audit/audit.module";

@Global()
@Module({ imports: [AuditModule], controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
