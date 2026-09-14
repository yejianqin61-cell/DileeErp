const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { FormsService } = require("../../dist/platform/forms/forms.service.js");

const USER = { id: "11111111-1111-1111-1111-111111111111", username: "tester", display_name: "Tester" };

// Hand written fake Prisma following the repository convention (no real database).
// `calls` records every model interaction so tests can assert the query shape and,
// for reverse cases, assert that no write was attempted.
function fakePrisma(overrides = {}) {
  const calls = { findMany: [], findFirst: [], create: [], update: [], audit: [] };
  const prisma = {
    calls,
    formDefinition: {
      async findMany(args) {
        calls.findMany.push(args);
        return overrides.findMany ? overrides.findMany(args) : [];
      },
      async findFirst(args) {
        calls.findFirst.push(args);
        return overrides.findFirst ? overrides.findFirst(args) : null;
      },
      async create(args) {
        calls.create.push(args);
        return overrides.create ? overrides.create(args) : { id: "def-1", status: "draft", ...args.data };
      },
      async update(args) {
        calls.update.push(args);
        return overrides.update ? overrides.update(args) : { id: args.where.id, ...args.data };
      },
    },
    auditEvent: {
      async create(args) {
        calls.audit.push(args);
        return overrides.auditCreate ? overrides.auditCreate(args) : { id: "audit-1" };
      },
    },
    // Not used by FormsService today, stubbed so the fake stays a faithful client
    // (row-lock helpers are part of the project's usual Prisma client surface).
    $transaction: async (fn) => fn(prisma),
    $queryRaw: async () => [],
    $executeRawUnsafe: async () => 0,
  };
  return prisma;
}

// Uses the real AuditService on top of the fake client so audit writes are asserted
// through the actual production code path instead of a hand written audit stub.
function buildService(overrides = {}) {
  const prisma = fakePrisma(overrides);
  const audit = new AuditService(prisma);
  return { prisma, audit, service: new FormsService(prisma, audit) };
}

function assertNestError(code, status) {
  return (error) => {
    assert.equal(typeof error.getResponse, "function", `expected a Nest HttpException, got ${error}`);
    assert.equal(error.getResponse().code, code);
    assert.equal(error.getStatus(), status);
    return true;
  };
}

test("forms.list_without_form_key_returns_only_active_definitions", async () => {
  const rows = [{ id: "def-1", formKey: "sales_intake", version: 2, fields: [] }];
  const { prisma, service } = buildService({ findMany: () => rows });

  const result = await service.list();

  assert.deepEqual(result, rows);
  assert.deepEqual(prisma.calls.findMany[0], {
    where: { deletedAt: null },
    include: { fields: { orderBy: { sortOrder: "asc" } } },
    orderBy: [{ formKey: "asc" }, { version: "desc" }],
  });
});

test("forms.list_with_form_key_scopes_the_query_to_that_key", async () => {
  const { prisma, service } = buildService();

  await service.list("sales_intake");

  assert.deepEqual(prisma.calls.findMany[0].where, { deletedAt: null, formKey: "sales_intake" });
  assert.equal(prisma.calls.findMany[0].include.fields.orderBy.sortOrder, "asc");
});

test("forms.list_with_empty_form_key_is_treated_as_no_filter", async () => {
  const { prisma, service } = buildService();

  await service.list("");

  // Empty string is falsy, so the optional filter is dropped and every form key is returned.
  assert.deepEqual(prisma.calls.findMany[0].where, { deletedAt: null });
  assert.equal("formKey" in prisma.calls.findMany[0].where, false);
});

test("forms.get_missing_or_soft_deleted_definition_throws_not_found", async () => {
  const { prisma, service } = buildService({ findFirst: () => null });

  await assert.rejects(() => service.get("missing-id"), assertNestError("FORM_DEFINITION_NOT_FOUND", 404));
  assert.deepEqual(prisma.calls.findFirst[0], {
    where: { id: "missing-id", deletedAt: null },
    include: { fields: { orderBy: { sortOrder: "asc" } } },
  });
  assert.equal(prisma.calls.create.length, 0);
  assert.equal(prisma.calls.update.length, 0);
});

test("forms.get_returns_definition_with_fields_ordered_by_sort_order", async () => {
  const row = { id: "def-9", formKey: "sales_intake", version: 3, status: "draft", fields: [{ fieldKey: "a" }] };
  const { service } = buildService({ findFirst: () => row });

  const result = await service.get("def-9");

  assert.deepEqual(result, row);
});

test("forms.create_first_version_of_a_form_key_starts_at_one", async () => {
  const { prisma, service } = buildService({ findFirst: () => null });

  const result = await service.create({ form_key: "sales_intake", name: "销售录入" }, USER);

  assert.deepEqual(prisma.calls.findFirst[0], {
    where: { formKey: "sales_intake", deletedAt: null },
    orderBy: { version: "desc" },
  });
  const data = prisma.calls.create[0].data;
  assert.equal(data.formKey, "sales_intake");
  assert.equal(data.name, "销售录入");
  assert.equal(data.version, 1);
  assert.equal(data.createdBy, USER.id);
  assert.equal(data.updatedBy, USER.id);
  assert.deepEqual(data.fields.create, []);
  assert.deepEqual(prisma.calls.create[0].include, { fields: { orderBy: { sortOrder: "asc" } } });
  assert.equal(result.id, "def-1");
  assert.deepEqual(prisma.calls.audit[0].data, {
    action: "form_definition.create",
    entityType: "form_definition",
    actorId: USER.id,
    entityId: "def-1",
    details: { form_key: "sales_intake", version: 1 },
  });
});

test("forms.create_next_version_increments_the_latest_active_version", async () => {
  const { prisma, service } = buildService({ findFirst: () => ({ id: "def-7", formKey: "sales_intake", version: 7, deletedAt: null }) });

  await service.create({ form_key: "sales_intake", name: "销售录入 v8" }, USER);

  assert.equal(prisma.calls.create[0].data.version, 8);
  assert.equal(prisma.calls.audit[0].data.details.version, 8);
});

test("forms.create_applies_field_defaults_for_optional_attributes", async () => {
  const { prisma, service } = buildService();

  await service.create(
    { form_key: "sales_intake", name: "销售录入", fields: [{ field_key: "customer_name", label: "客户名称", field_type: "text" }] },
    USER,
  );

  const field = prisma.calls.create[0].data.fields.create[0];
  assert.equal(field.fieldKey, "customer_name");
  assert.equal(field.label, "客户名称");
  assert.equal(field.fieldType, "text");
  assert.equal(field.isRequired, false);
  assert.equal(field.sortOrder, 0);
  assert.deepEqual(field.options, {});
  assert.equal(field.createdBy, USER.id);
  assert.equal(field.updatedBy, USER.id);
});

test("forms.create_preserves_explicit_field_metadata", async () => {
  const { prisma, service } = buildService();

  await service.create(
    {
      form_key: "sales_intake",
      name: "销售录入",
      fields: [
        { field_key: "amount", label: "金额", field_type: "number", is_required: true, sort_order: 5, options: { min: 0, precision: 2 } },
        { field_key: "note", label: "备注", field_type: "textarea", is_required: false, sort_order: 6 },
      ],
    },
    USER,
  );

  const fields = prisma.calls.create[0].data.fields.create;
  assert.equal(fields.length, 2);
  assert.equal(fields[0].isRequired, true);
  assert.equal(fields[0].sortOrder, 5);
  assert.deepEqual(fields[0].options, { min: 0, precision: 2 });
  assert.equal(fields[1].isRequired, false);
  assert.equal(fields[1].sortOrder, 6);
});

test("forms.create_null_options_fall_back_to_empty_object", async () => {
  const { prisma, service } = buildService();

  await service.create(
    { form_key: "sales_intake", name: "销售录入", fields: [{ field_key: "note", label: "备注", field_type: "text", options: null }] },
    USER,
  );

  assert.deepEqual(prisma.calls.create[0].data.fields.create[0].options, {});
});

test("forms.create_without_fields_is_still_a_valid_definition", async () => {
  const { prisma, service } = buildService();

  await service.create({ form_key: "sales_intake", name: "空表单" }, USER);

  assert.equal(prisma.calls.create.length, 1);
  assert.deepEqual(prisma.calls.create[0].data.fields.create, []);
});

test("forms.create_accepts_field_key_at_the_length_boundaries", async () => {
  const { prisma, service } = buildService();

  await service.create(
    {
      form_key: "sales_intake",
      name: "边界",
      fields: [
        { field_key: "a", label: "最短", field_type: "text" },
        { field_key: `a${"b".repeat(79)}`, label: "最长", field_type: "text" },
      ],
    },
    USER,
  );

  const keys = prisma.calls.create[0].data.fields.create.map((field) => field.fieldKey);
  assert.equal(keys[0], "a");
  assert.equal(keys[1].length, 80);
});

test("forms.create_rejects_invalid_field_keys_without_touching_the_database", async () => {
  const invalidKeys = [
    ["Sales", "uppercase first letter"],
    ["1abc", "leading digit"],
    ["_abc", "leading underscore"],
    ["ab-c", "hyphen"],
    ["ab c", "space"],
    ["", "empty string"],
    ["a".repeat(81), "81 characters, one over the limit"],
    [123, "non-string value"],
  ];

  for (const [key, reason] of invalidKeys) {
    const { prisma, service } = buildService();
    await assert.rejects(
      () => service.create({ form_key: "sales_intake", name: "非法", fields: [{ field_key: key, label: "标签", field_type: "text" }] }, USER),
      assertNestError("INVALID_FORM_FIELD", 409),
      `expected rejection for ${reason}`,
    );
    // Validation runs before any read/write: no definition row and no audit row is produced.
    assert.equal(prisma.calls.findFirst.length, 0, `findFirst must not run for ${reason}`);
    assert.equal(prisma.calls.create.length, 0, `create must not run for ${reason}`);
    assert.equal(prisma.calls.audit.length, 0, `audit must not be recorded for ${reason}`);
  }
});

test("forms.create_rejects_missing_label_or_field_type", async () => {
  const invalidFields = [
    [{ field_key: "ok_key", label: "", field_type: "text" }, "empty label"],
    [{ field_key: "ok_key", label: "标签", field_type: "" }, "empty field_type"],
    [{ field_key: "ok_key", label: undefined, field_type: "text" }, "missing label"],
    [{ field_key: "ok_key", label: "标签", field_type: undefined }, "missing field_type"],
  ];

  for (const [field, reason] of invalidFields) {
    const { prisma, service } = buildService();
    await assert.rejects(
      () => service.create({ form_key: "sales_intake", name: "非法", fields: [field] }, USER),
      assertNestError("INVALID_FORM_FIELD", 409),
      `expected rejection for ${reason}`,
    );
    assert.equal(prisma.calls.create.length, 0, `create must not run for ${reason}`);
    assert.equal(prisma.calls.audit.length, 0, `audit must not run for ${reason}`);
  }
});

test("forms.create_rejects_duplicate_field_keys_without_writing", async () => {
  const { prisma, service } = buildService();

  await assert.rejects(
    () =>
      service.create(
        {
          form_key: "sales_intake",
          name: "重复字段",
          fields: [
            { field_key: "customer_name", label: "客户", field_type: "text" },
            { field_key: "customer_name", label: "客户副本", field_type: "text" },
          ],
        },
        USER,
      ),
    assertNestError("INVALID_FORM_FIELD", 409),
  );
  assert.equal(prisma.calls.findFirst.length, 0);
  assert.equal(prisma.calls.create.length, 0);
  assert.equal(prisma.calls.audit.length, 0);
});

test("forms.create_accepts_whitespace_only_label_without_trimming", async () => {
  const { prisma, service } = buildService();

  await service.create(
    { form_key: "sales_intake", name: "空白标签", fields: [{ field_key: "note", label: "   ", field_type: "text" }] },
    USER,
  );

  // Observed behaviour: only falsiness is checked, so a blank label is persisted verbatim.
  assert.equal(prisma.calls.create[0].data.fields.create[0].label, "   ");
});

test("forms.create_accepts_negative_sort_order_without_range_check", async () => {
  const { prisma, service } = buildService();

  await service.create(
    { form_key: "sales_intake", name: "负排序", fields: [{ field_key: "note", label: "备注", field_type: "text", sort_order: -1 }] },
    USER,
  );

  // Observed behaviour: sort_order has no lower bound validation in the service.
  assert.equal(prisma.calls.create[0].data.fields.create[0].sortOrder, -1);
});

test("forms.publish_draft_definition_sets_published_status", async () => {
  const { prisma, service } = buildService({ findFirst: () => ({ id: "def-1", formKey: "sales_intake", version: 1, status: "draft" }) });

  const result = await service.publish("def-1", USER);

  assert.equal(prisma.calls.update.length, 1);
  assert.deepEqual(prisma.calls.update[0], { where: { id: "def-1" }, data: { status: "published", updatedBy: USER.id } });
  assert.equal(result.status, "published");
  assert.deepEqual(prisma.calls.audit[0].data, {
    action: "form_definition.publish",
    entityType: "form_definition",
    actorId: USER.id,
    entityId: "def-1",
    details: { form_key: "sales_intake", version: 1 },
  });
});

test("forms.publish_non_draft_definition_is_rejected_without_writing", async () => {
  for (const status of ["published", "archived", ""]) {
    const { prisma, service } = buildService({ findFirst: () => ({ id: "def-1", formKey: "sales_intake", version: 1, status }) });

    await assert.rejects(() => service.publish("def-1", USER), assertNestError("INVALID_STATE_TRANSITION", 422), `status=${status}`);

    assert.equal(prisma.calls.update.length, 0, `update must not run for status=${status}`);
    assert.equal(prisma.calls.audit.length, 0, `audit must not run for status=${status}`);
  }
});

test("forms.publish_missing_definition_throws_not_found_without_writing", async () => {
  const { prisma, service } = buildService({ findFirst: () => null });

  await assert.rejects(() => service.publish("missing-id", USER), assertNestError("FORM_DEFINITION_NOT_FOUND", 404));
  assert.equal(prisma.calls.update.length, 0);
  assert.equal(prisma.calls.audit.length, 0);
});

test("forms.publish_does_not_require_the_definition_to_be_the_latest_version", async () => {
  // A newer version (v2) is already published while v1 is still a draft.
  const { prisma, service } = buildService({ findFirst: () => ({ id: "def-v1", formKey: "sales_intake", version: 1, status: "draft" }) });

  const result = await service.publish("def-v1", USER);

  // Observed behaviour: publish only checks status === "draft"; the (form_key, version)
  // uniqueness lives in the database and is never re-checked here, so an older draft can
  // be published next to a newer published version.
  assert.equal(result.status, "published");
  assert.equal(prisma.calls.update[0].data.status, "published");
  assert.equal("version" in prisma.calls.update[0].data, false);
});

test("forms.create_version_collides_with_a_soft_deleted_definition_KNOWN_DEFECT", async () => {
  // The DB unique index is unconditional: CREATE UNIQUE INDEX "form_definitions_form_key_version_key"
  // ON "form_definitions"("form_key", "version")
  // (apps/api/prisma/migrations/20260821150000_bom_material_details/migration.sql:51).
  // The version lookup, however, filters deletedAt: null, so a soft deleted row is invisible
  // and its version number is handed out a second time.
  const rows = [{ id: "old-1", formKey: "sales_intake", version: 1, status: "draft", deletedAt: new Date() }];
  const { prisma, service } = buildService({
    findFirst: () => null, // soft deleted row is filtered out by the production query
    create: (args) => {
      const collides = rows.some((row) => row.formKey === args.data.formKey && row.version === args.data.version);
      if (collides) {
        const error = new Error("Unique constraint failed on the fields: (`form_key`,`version`)");
        error.code = "P2002";
        throw error;
      }
      rows.push({ id: "new-1", ...args.data });
      return { id: "new-1", ...args.data };
    },
  });

  // Rejected with a raw Prisma error instead of allocating version 2.
  await assert.rejects(() => service.create({ form_key: "sales_intake", name: "再次创建" }, USER), (error) => error.code === "P2002");
  assert.equal(prisma.calls.create[0].data.version, 1, "version 1 is reused even though a (soft deleted) version 1 row exists");
  assert.equal(prisma.calls.audit.length, 0, "the failing create must not record an audit event");
});

test("forms.create_forwards_null_field_key_without_rejecting_KNOWN_DEFECT", async () => {
  // KNOWN_DEFECT (service layer): the regex is applied to a coerced value, so a missing or
  // null field_key becomes "undefined"/"null" and matches /^[a-z][a-z0-9_]{0,79}$/.
  // The HTTP DTO blocks this today (@Matches rejects non-strings), but the service guard,
  // which is the last line of defence for direct/internal callers, does not.
  const { prisma, service } = buildService();

  await service.create(
    { form_key: "sales_intake", name: "空字段键", fields: [{ field_key: null, label: "标签", field_type: "text" }] },
    USER,
  );

  assert.equal(prisma.calls.create[0].data.fields.create[0].fieldKey, null);
});

test("forms.create_definition_is_written_before_audit_and_is_not_rolled_back", async () => {
  let createCount = 0;
  const { service } = buildService({
    create: (args) => {
      createCount += 1;
      return { id: "def-1", ...args.data };
    },
    auditCreate: () => {
      throw new Error("audit backend unavailable");
    },
  });

  // Observed behaviour: create() is not wrapped in a transaction, so an audit failure
  // surfaces after the definition row has already been written.
  await assert.rejects(() => service.create({ form_key: "sales_intake", name: "无审计" }, USER), /audit backend unavailable/);
  assert.equal(createCount, 1);
});
