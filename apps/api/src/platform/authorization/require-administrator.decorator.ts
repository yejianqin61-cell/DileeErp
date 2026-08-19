import { SetMetadata } from "@nestjs/common";

export const REQUIRE_ADMINISTRATOR = "require_administrator";
export const RequireAdministrator = () => SetMetadata(REQUIRE_ADMINISTRATOR, true);
