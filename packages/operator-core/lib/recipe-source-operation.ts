/** Narrow source adapters for the existing recipe capture/replay rail. No source
 * text or sample binding value is included in the returned public definition. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { fingerprintSqlIntent, type SqlIntentScope } from './bash-substitution/sql-intent-fingerprint';
import { EXAMPLE_LIFETIME_MS } from './agent-opportunities/privacy';
import { redactSensitiveText, redactStructuredSensitiveValue } from './sensitive-text';
import {
  recipeSourceOperationSchema,
  validateRecipeCapabilities,
  type CurrentCallerCapabilityCatalog,
  type JsonValue,
  type RecipeBindingSchemaV1,
  type RecipeSourceOperation,
} from './recipe-contract';

type RecordValue = Record<string, unknown>;
type Scalar = string | number | boolean | null;
const object = (v: unknown): RecordValue | null => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? v as RecordValue : null;
const scalar = (v: unknown): v is Scalar => v === null || typeof v === 'string' || typeof v === 'boolean'
  || typeof v === 'number' && Number.isFinite(v);
const shell: { parse: (s: string, env: (name: string) => string) => unknown[]; quote: (args: string[]) => string } =
  createRequire(import.meta.url)('shell-quote');

export const sourceOperationScript = (family: RecipeSourceOperation['family']): string => family === 'sql'
  ? 'return await tools.dev.pgQuery(inputs.__sourceOperation);'
  : 'return await tools.capability.bash(inputs.__sourceOperation);';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = object(value);
  return record ? `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
}

export interface RecipeOperationSource {
  id: string; workspaceId: string; harness: string; at: string;
  tool: string; args: unknown;
}

/** Only already-parameterized reads and simple output-only shell commands are
 * admitted here. Unsupported syntax retains the ordinary opaque-call refusal. */
export function compileSourceOperation(source: Pick<RecipeOperationSource, 'tool' | 'args'>, scope: SqlIntentScope) {
  const args = object(source.args);
  if (!args || args._truncated === true || args._partial === true || object(args._projection)?.truncated === true) return null;
  let family: RecipeSourceOperation['family'], originals: Scalar[], fixed: Record<string, JsonValue>;
  if (source.tool === 'dev:pg_query') {
    if (typeof args.sql !== 'string' || args.sql.length > 64_000 || args.describe !== undefined
      || args.positiveControlSql !== undefined) return null;
    const intent = fingerprintSqlIntent(args.sql, scope);
    if (intent.status !== 'supported' || intent.secretValuesDropped) return null;
    if (args.parameters !== undefined && (!Array.isArray(args.parameters) || args.parameters.length > 1000
      || !args.parameters.every(scalar))) return null;
    family = 'sql'; originals = (args.parameters as Scalar[] | undefined) ?? [];
    // The immutable private source retains query options; no old process/job id
    // or author credential becomes a runtime argument.
    fixed = { sql: args.sql };
    for (const key of ['maxRows', 'timeoutMs']) {
      const value = args[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
      fixed[key] = value;
    }
    for (const key of ['allowUnscoped', 'allowUnboundedJsonSearch']) {
      const value = args[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') return null;
      fixed[key] = value;
    }
  } else if (source.tool === 'capability:bash') {
    if (typeof args.command !== 'string' || !args.command || args.command.length > 64_000
      || typeof args.cwd !== 'string' || !args.cwd.startsWith('/') || args.run_in_background === true
      || /[\r\n`]|\$[({]/.test(args.command)) return null;
    let tokens: unknown[];
    try { tokens = shell.parse(args.command, () => '\0EXPANSION'); } catch { return null; }
    if (!tokens.length || tokens.some(t => typeof t !== 'string' || t.includes('\0'))) return null;
    const words = tokens as string[];
    // These builtins cannot turn a value into an executable, a path write or a
    // subprocess. printf's format stays fixed in the private source.
    const start = words[0] === 'printf' && words.length >= 2 ? 2 : words[0] === 'echo' ? 1
      : words[0] === 'pwd' && words.length === 1 ? 1 : 0;
    if (!start) return null;
    family = 'shell'; originals = words.slice(start);
    fixed = { prefix: words.slice(0, start), cwd: args.cwd };
  } else return null;
  const sourceText = canonical(source.args);
  if (canonical(redactStructuredSensitiveValue(source.args)) !== sourceText
    || redactSensitiveText(sourceText, scope.knownSecrets) !== sourceText
    || scope.knownSecrets?.some(secret => secret && sourceText.includes(secret))) return null;
  const properties: RecipeBindingSchemaV1['properties'] = {};
  const initialValues: Record<string, Scalar> = {};
  originals.forEach((value, i) => {
    const key = `value${i}`;
    properties[key] = { type: value === null ? 'json' : typeof value as 'string' | 'number' | 'boolean',
      required: true, lifetime: { kind: 'stable' } };
    initialValues[key] = value;
  });
  const bindingSchema: RecipeBindingSchemaV1 = { version: 1, properties, additionalProperties: false };
  return { family, bindingSchema, initialValues, prepare(values: Readonly<Record<string, unknown>>): Record<string, JsonValue> | null {
    if (Object.keys(values).length !== originals.length
      || originals.some((_, i) => !Object.prototype.hasOwnProperty.call(values, `value${i}`))) return null;
    const bindings = originals.map((original, i) => {
      const value = values[`value${i}`];
      return scalar(value) && (original === null || typeof value === typeof original) ? { value } : null;
    });
    if (bindings.some(b => !b)) return null;
    const current = bindings.map(b => b!.value);
    if (family === 'sql') return { ...fixed, parameters: current };
    if (!current.every(value => typeof value === 'string' && !value.includes('\0'))) return null;
    return { command: shell.quote([...(fixed.prefix as string[]), ...current as string[]]), cwd: fixed.cwd };
  } };
}

function revision(source: RecipeOperationSource, scope: SqlIntentScope): string {
  return createHmac('sha256', scope.key).update(canonical([
    'recipe-source-operation:v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, source,
  ])).digest('hex');
}

/** Called only after the host source reader verifies a settled successful
 * operation and current source permission. Never accepts a caller's receipt. */
export function describeRecipeSourceOperation(source: RecipeOperationSource, scope: SqlIntentScope, now = Date.now()) {
  if (source.workspaceId !== scope.workspaceId || !/^\d+$/.test(source.id) || !source.harness
    || !Number.isFinite(Date.parse(source.at)) || Date.parse(source.at) > now
    || Date.parse(source.at) + EXAMPLE_LIFETIME_MS <= now) return null;
  const operation = compileSourceOperation(source, scope);
  if (!operation) return null;
  const ref: RecipeSourceOperation = { version: 1, family: operation.family, invocationId: source.id,
    workspaceId: source.workspaceId, harness: source.harness, epoch: scope.epoch,
    revision: revision(source, scope), expiresAt: new Date(Date.parse(source.at) + EXAMPLE_LIFETIME_MS).toISOString() };
  // Exact contract identity, keyed within the existing source scope. Values are
  // runtime bindings; fixed SQL/format/cwd/options and binding types distinguish
  // operations even though their public adapter scripts are identical.
  const shapeValues = Object.fromEntries(Object.entries(operation.initialValues).map(([name, value]) =>
    [name, value === null ? null : typeof value === 'string' ? '' : typeof value === 'number' ? 0 : false]));
  const captureKey = createHmac('sha256', scope.key).update(canonical([
    'recipe-source-capture:v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, source.harness,
    operation.family, operation.bindingSchema, operation.prepare(shapeValues),
  ])).digest('hex');
  return { sourceOperation: ref, script: sourceOperationScript(operation.family), bindingSchema: operation.bindingSchema, captureKey };
}

/** No cache: a new authorized source read is mandatory for every disclosure and
 * dispatch. A locator/revision is integrity metadata, never permission. */
export async function resolveRecipeSourceOperation(input: {
  sourceOperation: unknown; script: string; bindingSchema: unknown;
  workspaceId: string; harness: string; scope: SqlIntentScope;
  read: (id: string) => Promise<RecipeOperationSource | null>;
  now?: number;
}) {
  const parsed = recipeSourceOperationSchema.safeParse(input.sourceOperation);
  const now = input.now ?? Date.now();
  if (!parsed.success) return null;
  const ref = parsed.data;
  if (ref.workspaceId !== input.workspaceId || ref.harness !== input.harness || ref.epoch !== input.scope.epoch
    || input.scope.workspaceId !== input.workspaceId || Date.parse(ref.expiresAt) <= now
    || input.script !== sourceOperationScript(ref.family)) return null;
  try {
    const source = await input.read(ref.invocationId);
    if (!source || source.id !== ref.invocationId || source.workspaceId !== ref.workspaceId || source.harness !== ref.harness) return null;
    const current = describeRecipeSourceOperation(source, input.scope, now);
    if (!current || canonical(current.bindingSchema) !== canonical(input.bindingSchema)
      || canonical({ ...current.sourceOperation, revision: '' }) !== canonical({ ...ref, revision: '' })
      || !timingSafeEqual(Buffer.from(ref.revision, 'hex'), Buffer.from(current.sourceOperation.revision, 'hex'))) return null;
    return compileSourceOperation(source, input.scope);
  } catch { return null; }
}

/** Runtime adapter over the existing canonical source reader. Callers supply
 * server-derived scope, never the author/proof's claimed scope. */
export async function resolveStoredSourceOperation(recipe: {
  script: string; bindingSchema?: unknown; capabilityManifest?: unknown;
}, context: { workspace?: string | null; harness?: string | null; catalog?: CurrentCallerCapabilityCatalog } = {}) {
  const sourceOperation = object(recipe.capabilityManifest)?.sourceOperation;
  if (!sourceOperation || !context.workspace || !context.harness) return null;
  // Source access and the reuser's current execution envelope are independent.
  // Discovery passes the same freshly measured catalog used by replay; internal
  // source hydration can still run after replay has already checked it.
  if (context.catalog) {
    const ref = recipeSourceOperationSchema.safeParse(sourceOperation);
    if (!ref.success || !validateRecipeCapabilities({ manifest: recipe.capabilityManifest,
      staticToolNames: [ref.data.family === 'sql' ? 'dev:pg_query' : 'capability:bash'],
      catalog: context.catalog }).ok) return null;
  }
  try {
    const { productionMiningScope } = await import('./agent-opportunities/privacy');
    const { productionOpportunityReaders } = await import('./agent-opportunities/source-readers');
    const workspaceId = context.workspace, harness = context.harness;
    const scope = productionMiningScope(workspaceId);
    const reader = productionOpportunityReaders({ workspaceId, harnessSlug: harness, sourceBoundary: scope.sourceBoundary,
      authorize: async boundary => boundary.workspaceId === context.workspace && boundary.harnessSlug === context.harness
        && boundary.sourceBoundary === scope.sourceBoundary });
    return await resolveRecipeSourceOperation({ sourceOperation, script: recipe.script, bindingSchema: recipe.bindingSchema,
      workspaceId, harness, scope, read: id => reader.readRecipeOperation({ id, scope }) });
  } catch { return null; }
}
