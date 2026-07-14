/**
 * Context authority for reusable code recipes.
 *
 * Recipes are globally discoverable capabilities, but their scripts often embed
 * concrete fleet/plan/harness/item/resource ids. A semantic match is not enough
 * to authorize recommending one of those scripts in a different lane. This
 * module derives the bound identities from the CURRENT stored script, matches
 * them against the caller's live context, and stamps the recommendation with a
 * content revision that recipes:run can revalidate.
 */
import { createHash } from 'node:crypto';
import { checkScript, ensureParseCheckReady, type StaticToolCall } from '@papercusp/tooldef';

export interface RecipeAuthorityRefs {
  workspaces: string[];
  fleets: string[];
  plans: string[];
  harnesses: string[];
  items: string[];
  resources: string[];
}

export interface RecipeAuthorityContext {
  workspace?: string | null;
  fleet?: string | null;
  plan?: string | null;
  harness?: string | null;
  items?: string[] | null;
  resources?: string[] | null;
}

export interface RecipeAuthorityDescriptor {
  refs: RecipeAuthorityRefs;
  /** Opaque dispatch/SQL/shell or dynamically scoped args cannot be proven safe. */
  unresolved: boolean;
  bound: boolean;
}

export interface RecipeAuthorityProof {
  version: 1;
  revision: string;
  context: RecipeAuthorityContext;
}

export interface RecipeAuthorityRecommendation {
  proof: RecipeAuthorityProof;
  refs: RecipeAuthorityRefs;
}

const emptyRefs = (): RecipeAuthorityRefs => ({
  workspaces: [],
  fleets: [],
  plans: [],
  harnesses: [],
  items: [],
  resources: [],
});

const normPart = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
const splitTool = (tool: string): { ns: string; verb: string } => {
  const colon = tool.indexOf(':');
  const dot = tool.indexOf('.');
  const at = colon >= 0 ? colon : dot;
  return at < 0
    ? { ns: normPart(tool), verb: '' }
    : { ns: normPart(tool.slice(0, at)), verb: normPart(tool.slice(at + 1)) };
};

const strings = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap(strings);
};

const add = (target: Set<string>, value: unknown): void => {
  for (const item of strings(value)) target.add(item);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const SCOPE_NAMESPACES = new Set(['plans', 'workitems', 'fleet', 'harness', 'locks', 'resource', 'resources']);
const OPAQUE_TOOLS = new Set(['dev:pgquery', 'capability:bash', 'capability:script', 'code:run']);

/** Collect known authority keys from one statically projected argument object. */
function collectArgs(
  tool: string,
  value: unknown,
  out: Record<keyof RecipeAuthorityRefs, Set<string>>,
): void {
  const args = asRecord(value);
  if (!args) return;
  const normalized = new Map(Object.entries(args).map(([key, val]) => [normPart(key), val]));
  const { ns } = splitTool(tool);

  add(out.workspaces, normalized.get('workspace') ?? normalized.get('workspaceid'));
  add(out.fleets, normalized.get('fleet') ?? normalized.get('fleetslug'));
  add(out.plans, normalized.get('plan') ?? normalized.get('planslug'));
  add(out.harnesses, normalized.get('harness') ?? normalized.get('harnessslug'));
  add(out.items, normalized.get('item') ?? normalized.get('itemid'));
  add(out.items, normalized.get('itemids'));
  add(out.resources, normalized.get('resource') ?? normalized.get('resourceid'));
  add(out.resources, normalized.get('resources'));

  if (ns === 'plans') add(out.plans, normalized.get('slug'));
  if (ns === 'workitems') add(out.items, normalized.get('id') ?? normalized.get('ids'));
  if (ns === 'fleet') add(out.fleets, normalized.get('slug') ?? normalized.get('id'));
  if (ns === 'harness') add(out.harnesses, normalized.get('slug') ?? normalized.get('id'));
  if (ns === 'locks' || ns === 'resource' || ns === 'resources') {
    add(out.resources, normalized.get('name'));
  }

  const itemRows = normalized.get('items');
  if (Array.isArray(itemRows)) {
    for (const row of itemRows) {
      if (typeof row === 'string') {
        out.items.add(row);
        continue;
      }
      const rec = asRecord(row);
      if (!rec) continue;
      add(out.items, rec.item ?? rec.itemId ?? rec.item_id ?? rec.id);
    }
  }
}

function inspectCall(
  call: StaticToolCall,
  out: Record<keyof RecipeAuthorityRefs, Set<string>>,
): boolean {
  const normalizedTool = call.tool.includes(':')
    ? `${normPart(call.tool.split(':', 1)[0])}:${normPart(call.tool.slice(call.tool.indexOf(':') + 1))}`
    : `${splitTool(call.tool).ns}:${splitTool(call.tool).verb}`;
  const { ns } = splitTool(call.tool);

  // A statically projected tools:invoke is transparent: inspect the inner tool
  // and args. A dynamic wrapper target is opaque and therefore fails closed.
  if (ns === 'tools' && splitTool(call.tool).verb === 'invoke') {
    const wrapper = asRecord(call.args);
    const innerName = wrapper?.name;
    if (typeof innerName !== 'string') return true;
    const inner: StaticToolCall = {
      tool: innerName,
      args: wrapper?.args ?? null,
      dynamicArgs: call.dynamicArgs || wrapper?.args === undefined,
    };
    return inspectCall(inner, out);
  }

  collectArgs(call.tool, call.args, out);
  if (OPAQUE_TOOLS.has(normalizedTool)) return true;
  return call.dynamicArgs && SCOPE_NAMESPACES.has(ns);
}

export async function deriveRecipeAuthority(script: string): Promise<RecipeAuthorityDescriptor> {
  await ensureParseCheckReady();
  // An empty catalog is intentional: call inspection still resolves dotted
  // members and tools.call names; authority matching normalizes both spellings.
  const analysis = checkScript(script, []);
  const sets: Record<keyof RecipeAuthorityRefs, Set<string>> = {
    workspaces: new Set(),
    fleets: new Set(),
    plans: new Set(),
    harnesses: new Set(),
    items: new Set(),
    resources: new Set(),
  };
  let unresolved = false;
  for (const call of analysis.calls) unresolved = inspectCall(call, sets) || unresolved;

  // A script that statically referenced tools but yielded no inspectable calls
  // used a dynamic/unsupported access form; do not recommend it as generic.
  if (analysis.refs.length > 0 && analysis.calls.length === 0) unresolved = true;

  const refs = emptyRefs();
  for (const key of Object.keys(refs) as Array<keyof RecipeAuthorityRefs>) {
    refs[key] = [...sets[key]].sort();
  }
  const bound = Object.values(refs).some((values) => values.length > 0);
  return { refs, unresolved, bound };
}

const hasAll = (required: readonly string[], actual: readonly string[]): boolean => {
  const set = new Set(actual);
  return required.every((value) => set.has(value));
};

export function normalizeRecipeAuthorityContext(context: RecipeAuthorityContext = {}): RecipeAuthorityContext {
  const unique = (values: string[] | null | undefined): string[] | undefined =>
    values?.length ? [...new Set(values.filter(Boolean))].sort() : undefined;
  const items = unique(context.items);
  const resources = unique(context.resources);
  return {
    ...(context.workspace ? { workspace: context.workspace } : {}),
    ...(context.fleet ? { fleet: context.fleet } : {}),
    ...(context.plan ? { plan: context.plan } : {}),
    ...(context.harness ? { harness: context.harness } : {}),
    ...(items ? { items } : {}),
    ...(resources ? { resources } : {}),
  };
}

/** Build the comparison context for code:run's near-duplicate search from the
 * source script itself. Multi-scalar scripts remain intentionally unmatched —
 * there is no single active fleet/plan/harness identity to prove. */
export function recipeAuthorityContextFromDescriptor(
  descriptor: RecipeAuthorityDescriptor,
  base: RecipeAuthorityContext = {},
): RecipeAuthorityContext {
  const one = (values: string[]): string | undefined => (values.length === 1 ? values[0] : undefined);
  return normalizeRecipeAuthorityContext({
    workspace: base.workspace ?? one(descriptor.refs.workspaces),
    fleet: base.fleet ?? one(descriptor.refs.fleets),
    plan: base.plan ?? one(descriptor.refs.plans),
    harness: base.harness ?? one(descriptor.refs.harnesses),
    items: [...(base.items ?? []), ...descriptor.refs.items],
    resources: [...(base.resources ?? []), ...descriptor.refs.resources],
  });
}

export function recipeAuthorityMatches(
  descriptor: RecipeAuthorityDescriptor,
  context: RecipeAuthorityContext = {},
): boolean {
  if (descriptor.unresolved) return false;
  const c = normalizeRecipeAuthorityContext(context);
  const scalar = (required: readonly string[], actual: string | null | undefined): boolean =>
    required.length === 0 || (Boolean(actual) && required.every((value) => value === actual));
  return (
    scalar(descriptor.refs.workspaces, c.workspace) &&
    scalar(descriptor.refs.fleets, c.fleet) &&
    scalar(descriptor.refs.plans, c.plan) &&
    scalar(descriptor.refs.harnesses, c.harness) &&
    (descriptor.refs.items.length === 0 || hasAll(descriptor.refs.items, c.items ?? [])) &&
    (descriptor.refs.resources.length === 0 || hasAll(descriptor.refs.resources, c.resources ?? []))
  );
}

export function recipeRevision(script: string, updatedAt: string): string {
  return createHash('sha256').update(updatedAt).update('\0').update(script).digest('hex');
}

export async function buildRecipeAuthorityRecommendation(input: {
  script: string;
  updatedAt: string;
  context?: RecipeAuthorityContext;
}): Promise<RecipeAuthorityRecommendation | null> {
  const descriptor = await deriveRecipeAuthority(input.script);
  if (!recipeAuthorityMatches(descriptor, input.context)) return null;
  return {
    proof: {
      version: 1,
      revision: recipeRevision(input.script, input.updatedAt),
      context: normalizeRecipeAuthorityContext(input.context),
    },
    refs: descriptor.refs,
  };
}

export async function validateRecipeAuthorityProof(input: {
  script: string;
  updatedAt: string;
  proof?: RecipeAuthorityProof | null;
  liveContext?: RecipeAuthorityContext;
}): Promise<{ ok: true; descriptor: RecipeAuthorityDescriptor } | { ok: false; error: string }> {
  const descriptor = await deriveRecipeAuthority(input.script);
  if (descriptor.unresolved) return { ok: false, error: 'authority_unresolved' };
  if (!input.proof) {
    return descriptor.bound
      ? { ok: false, error: 'authority_required' }
      : { ok: true, descriptor };
  }
  if (input.proof.version !== 1) return { ok: false, error: 'authority_version_unsupported' };
  if (input.proof.revision !== recipeRevision(input.script, input.updatedAt)) {
    return { ok: false, error: 'authority_stale_revision' };
  }
  const context = normalizeRecipeAuthorityContext({
    ...input.proof.context,
    ...(input.liveContext?.workspace ? { workspace: input.liveContext.workspace } : {}),
    ...(input.liveContext?.fleet ? { fleet: input.liveContext.fleet } : {}),
    ...(input.liveContext?.harness ? { harness: input.liveContext.harness } : {}),
  });
  if (!recipeAuthorityMatches(descriptor, context)) return { ok: false, error: 'authority_entity_mismatch' };
  return { ok: true, descriptor };
}
