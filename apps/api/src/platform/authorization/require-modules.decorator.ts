import { SetMetadata } from "@nestjs/common";
import type { ModuleKey } from "./module-key";

export const REQUIRED_MODULES = "required_modules";
export const RequireModules = (...modules: ModuleKey[]) => SetMetadata(REQUIRED_MODULES, modules);
