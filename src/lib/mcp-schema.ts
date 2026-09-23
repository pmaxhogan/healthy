// Turns one MCP tool's real JSON input schema (from GET /api/mcp/tools/schema)
// into a starting point for the "Try a tool" panel's argument editor.
//
// Only `required` properties are prefilled. Every tool in this server accepts
// far more optional arguments than required ones (`health_systems`, `raw`, `limit`,
// a date window -- see worker/mcp/args.ts), and a skeleton that included all of
// them would be a wall of placeholders the owner has to delete, not a starting
// point. What must be filled in is what is worth showing.

/** The handful of JSON Schema keys this module reads. Anything else is ignored. */
export interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  [key: string]: unknown;
}

/** One representative value for a property's declared type. */
function placeholderFor(propertySchema: JsonSchemaLike): unknown {
  const type = Array.isArray(propertySchema.type) ? propertySchema.type[0] : propertySchema.type;
  switch (type) {
    case "string": {
      return "";
    }
    case "integer":
    case "number": {
      return 0;
    }
    case "boolean": {
      return false;
    }
    case "array": {
      return [];
    }
    case "object": {
      return {};
    }
    default: {
      return null;
    }
  }
}

/**
 * `{}` when a tool needs nothing but its shared, optional arguments; otherwise
 * one key per required property, each set to a placeholder of the right JS type.
 */
export function buildArgsSkeleton(schema: JsonSchemaLike): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const skeleton: Record<string, unknown> = {};
  for (const key of required) {
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (propertySchema !== undefined) skeleton[key] = placeholderFor(propertySchema);
  }
  return skeleton;
}
