import { SetMetadata } from "@nestjs/common";
import type { ModuleKey } from "./module-key";

export const REQUIRED_ANY_MODULES = "required_any_modules";
export const RequireAnyModules = (...modules: ModuleKey[]) => SetMetadata(REQUIRED_ANY_MODULES, modules);
