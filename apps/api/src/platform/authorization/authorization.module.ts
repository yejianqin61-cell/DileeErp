import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuthenticationGuard } from "./authentication.guard";
import { ModulePermissionGuard } from "./module-permission.guard";
import { AdminUsersController } from "./admin-users.controller";

@Global()
@Module({ imports: [AuthModule], controllers: [AdminUsersController], providers: [AuthenticationGuard, ModulePermissionGuard], exports: [AuthenticationGuard, ModulePermissionGuard] })
export class AuthorizationModule {}
