import { Injectable } from "@nestjs/common";
import type { CurrentUser } from "../auth/auth.service";

@Injectable()
export class AuditService {
  create(user: CurrentUser) { return { createdBy: user.id, updatedBy: user.id }; }
  update(user: CurrentUser) { return { updatedBy: user.id }; }
  softDelete(user: CurrentUser) { return { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }; }
  activeWhere<T extends object>(where: T = {} as T) { return { ...where, deletedAt: null }; }
}
