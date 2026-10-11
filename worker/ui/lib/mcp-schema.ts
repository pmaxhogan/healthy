// Turns one MCP tool's real JSON input schema (from GET /api/mcp/tools/schema)
// into a starting point for the "Try a tool" panel's argument editor.
//
// Only `required` properties are prefilled. Every tool in this server accepts
// far more optional arguments than required ones (`health_systems`, `raw`, `limit`,
// a date window -- see worker/src/mcp/args.ts), and a skeleton that included all of
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
export function placeholderFor(propertySchema: JsonSchemaLike): unknown {
  // A value the schema itself offers beats a blank one: the first enum member, or the default.
  if (propertySchema.default !== undefined) return propertySchema.default;
  if (Array.isArray(propertySchema.enum) && propertySchema.enum.length > 0) {
    return propertySchema.enum[0];
  }
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
export function buildArgsSkeleton(
  schema: JsonSchemaLike,
  now: number = Date.now(),
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const skeleton: Record<string, unknown> = {};
  for (const key of required) {
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (propertySchema === undefined) continue;
    skeleton[key] = startingValue(key, propertySchema, now) ?? placeholderFor(propertySchema);
  }
  return skeleton;
}

const DAY_MS = 86_400_000;

/**
 * A usable first value for the two arguments every phone (Health Connect) tool
 * asks for that a blank string can never satisfy: a `start` that is a calendar
 * date (the last week) and a record `type` (steps, the commonest). Found by
 * the argument's name and the sentence that describes it; anything else is left
 * to `placeholderFor`.
 */
function startingValue(key: string, propertySchema: JsonSchemaLike, now: number): string | null {
  if (propertySchema.type !== "string" || propertySchema.enum !== undefined) return null;
  const description =
    typeof propertySchema.description === "string" ? propertySchema.description : "";
  if (key === "start" && description.includes("calendar date")) {
    return new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
  }
  return key === "type" && description.includes("Health Connect record type") ? "Steps" : null;
}
