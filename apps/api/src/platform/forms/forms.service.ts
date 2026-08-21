import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { CurrentUser } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";

type FieldInput = { field_key: string; label: string; field_type: string; is_required?: boolean; sort_order?: number; options?: Record<string, unknown> };

@Injectable()
export class FormsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(formKey?: string) { return this.prisma.formDefinition.findMany({ where: { deletedAt: null, ...(formKey ? { formKey } : {}) }, include: { fields: { orderBy: { sortOrder: "asc" } } }, orderBy: [{ formKey: "asc" }, { version: "desc" }] }); }

  async get(id: string) {
    const definition = await this.prisma.formDefinition.findFirst({ where: { id, deletedAt: null }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
    if (!definition) throw new NotFoundException({ code: "FORM_DEFINITION_NOT_FOUND", message: "表单定义不存在", details: [] });
    return definition;
  }

  async create(input: { form_key: string; name: string; fields?: FieldInput[] }, user: CurrentUser) {
    this.validateFields(input.fields ?? []);
    const latest = await this.prisma.formDefinition.findFirst({ where: { formKey: input.form_key, deletedAt: null }, orderBy: { version: "desc" } });
    const definition = await this.prisma.formDefinition.create({ data: { formKey: input.form_key, name: input.name, version: (latest?.version ?? 0) + 1, ...this.audit.create(user), fields: { create: (input.fields ?? []).map((field) => ({ fieldKey: field.field_key, label: field.label, fieldType: field.field_type, isRequired: field.is_required ?? false, sortOrder: field.sort_order ?? 0, options: (field.options ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) })) } }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
    await this.audit.record("form_definition.create", "form_definition", user.id, definition.id, { form_key: definition.formKey, version: definition.version });
    return definition;
  }

  async publish(id: string, user: CurrentUser) {
    const definition = await this.get(id);
    if (definition.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有草稿表单定义可以发布", details: [] });
    const updated = await this.prisma.formDefinition.update({ where: { id }, data: { status: "published", ...this.audit.update(user) } });
    await this.audit.record("form_definition.publish", "form_definition", user.id, id, { form_key: definition.formKey, version: definition.version });
    return updated;
  }

  private validateFields(fields: FieldInput[]) {
    const keys = new Set<string>();
    for (const field of fields) {
      if (!/^[a-z][a-z0-9_]{0,79}$/.test(field.field_key) || !field.label || !field.field_type || keys.has(field.field_key)) throw new ConflictException({ code: "INVALID_FORM_FIELD", message: "表单字段定义不合法或重复", details: [] });
      keys.add(field.field_key);
    }
  }
}
