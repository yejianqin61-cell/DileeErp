import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuthenticationGuard } from "./authentication.guard";
import { ModulePermissionGuard } from "./module-permission.guard";

@Module({ imports: [AuthModule], providers: [AuthenticationGuard, ModulePermissionGuard], exports: [AuthenticationGuard, ModulePermissionGuard] })
export class AuthorizationModule {}
