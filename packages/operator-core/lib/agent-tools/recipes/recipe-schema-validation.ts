import {
  checkScript,
  ensureParseCheckReady,
  extractPayloadTier,
  type ProjectedTool,
} from '@papercusp/tooldef';

export interface RecipeSchemaIssue {
  tool: string;
  path: string;
  message: string;
}

export interface RecipeSchemaValidation {
  ok: boolean;
  issues: RecipeSchemaIssue[];
  /** Canonical current-catalog tool names resolved statically from the script. */
  staticToolNames: string[];
}

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const equalJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || !isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] && equalJson(left[key], right[key]),
  );
};

function validateValue(value: unknown, schema: JsonSchema, path: string): string[] {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) {
    if (alternatives.some((candidate) => validateValue(value, candidate, path).length === 0)) return [];
    return [`${path} does not match any current schema alternative`];
  }

  if (schema.enum && !schema.enum.some((candidate) => equalJson(value, candidate))) {
    return [`${path} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`];
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) return [`${path} must be an object`];
    const issues: string[] = [];
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push(`${path}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path}.${key} is not accepted by the current tool schema`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) issues.push(...validateValue(value[key], child, `${path}.${key}`));
    }
    return issues;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    return schema.items ? value.flatMap((item, index) => validateValue(item, schema.items!, `${path}[${index}]`)) : [];
  }

  if (schema.type === 'string' && typeof value !== 'string') return [`${path} must be a string`];
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return [`${path} must be a number`];
  if (schema.type === 'integer' && (!Number.isInteger(value))) return [`${path} must be an integer`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path} must be a boolean`];
  return [];
}

const mcpName = (tool: ProjectedTool): string | undefined => tool.expose.mcp?.name;

/** Validate statically-known calls against the live projected tool catalog. */
export async function validateRecipeScriptAgainstCatalog(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): Promise<RecipeSchemaValidation> {
  await ensureParseCheckReady();
  const analysis = checkScript(script, tools, allowed);
  const byName = new Map<string, ProjectedTool>();
  for (const tool of tools) {
    const name = mcpName(tool);
    if (name) byName.set(name, tool);
  }
  // Unknown/disallowed references remain the runtime facade's concern: the
  // existing orchestration parser reports those with the caller's role-scoped
  // allow-set. This guard focuses on the failure class that survives name
  // resolution: literal arguments accepted when the recipe was saved but no
  // longer accepted by the current tool schema.
  const issues: RecipeSchemaIssue[] = [];

  for (const call of analysis.calls) {
    if (call.dynamicArgs || call.args == null) continue;
    const name = call.tool.includes(':') ? call.tool : [...byName.keys()].find((candidate) => candidate?.replace(':', '.') === call.tool);
    const tool = name ? byName.get(name) : undefined;
    if (!name || !tool) continue;
    // `payloadTier` is a framework-reserved control. The real projected-tool
    // dispatcher extracts it before validating the tool's published schema, so
    // recipe preflight must validate the same schema-visible argument shape.
    const { input: schemaArgs } = extractPayloadTier(call.args);
    for (const message of validateValue(schemaArgs, tool.inputSchema as JsonSchema, 'args')) {
      issues.push({ tool: name, path: 'args', message });
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    staticToolNames: [...new Set(analysis.calls.map((call) => call.tool))].sort(),
  };
}
