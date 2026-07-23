import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { WorkspaceToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports provider-compatible object schemas with useful descriptions", () => {
  for (const tool of Object.values(WorkspaceToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
  }
});

it("exposes the attach tool with a label parameter and the list tool with none", () => {
  const tools = Object.values(WorkspaceToolkit.tools);
  const attach = tools.find((tool) => tool.name === "workspace_attach_repo");
  const list = tools.find((tool) => tool.name === "workspace_list_repos");
  expect(attach, "workspace_attach_repo tool must exist").toBeDefined();
  expect(list, "workspace_list_repos tool must exist").toBeDefined();
  const attachSchema = Tool.getJsonSchema(attach!) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const listSchema = Tool.getJsonSchema(list!) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  expect(attachSchema.properties?.label, "attach must accept a label").toBeDefined();
  expect(Object.keys(listSchema.properties ?? {}), "list takes no parameters").toHaveLength(0);
});
