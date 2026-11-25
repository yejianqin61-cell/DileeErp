import { Prisma } from "@prisma/client";

type SchemaModel = { name: string; fields: readonly { name: string }[] };

export function splitNeededFields(fields: readonly string[], models: readonly SchemaModel[] = Prisma.dmmf.datamodel.models): { verified: string[]; unverified: string[] } {
  const known = new Set(models.flatMap((model) => model.fields.map((field) => `${model.name}.${field.name}`)));
  const unique = [...new Set(fields)];
  return { verified: unique.filter((field) => known.has(field)), unverified: unique.filter((field) => !known.has(field)) };
}
