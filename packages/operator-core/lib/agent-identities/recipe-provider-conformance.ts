/** P004 recipe admission. Reuses orchestrate:inspect; never executes a recipe.
 * Persistence belongs to the existing conformance report, and runtime admission
 * still belongs to P013. A successful inspection alone is not an execution grant.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { listAllProjectedTools, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { classifyDurableCall, roleScopedToolNames, type ProjectedTool } from '@papercusp/tooldef';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { CapabilityClassVerb } from '../capability-class-registry-store';
import { isCompilableSchema } from '../json-schema-validation';
import { inspectOrchestration } from '../agent-tools/orchestration/inspect';
import { currentCallerRecipeCatalog, inspectScriptContract,
  ORCHESTRATION_RECURSION_EXCLUSIONS } from '../agent-tools/orchestration/contract-preflight';
import type { SavedRecipeAdapter, SavedRecipeSelector } from '../agent-tools/orchestration/saved-recipe-adapter';
import { orchestrationSourceArgsSchema } from '../agent-tools/orchestration/public-contract';

const pinSchema = orchestrationSourceArgsSchema.shape.inspectionPin.unwrap().extend({
  recipeRevision: z.string().regex(/^[0-9a-f]{64}$/),
});
export type IdentityRecipeInspectionPin = z.infer<typeof pinSchema>;

const inspectionSchema = z.object({
  ok: z.literal(true),
  normalized: z.object({
    recipe: z.object({ id: z.string().min(1), revision: z.string().min(1) }),
    script: z.object({ source: z.string().min(1).max(20_000) }),
    staticToolCalls: z.array(z.object({ tool: z.string(), args: z.unknown(), dynamicArgs: z.boolean() })).max(200),
    durability: z.object({ pin: pinSchema }),
    execution: z.object({ mode: z.literal('server'), lifecycle: z.literal('foreground') }),
  }),
});

export type IdentityRecipeConformance = {
  ok: true;
  recipe: { id: string; revision: string };
  inspectionPin: IdentityRecipeInspectionPin;
  toolNames: string[];
  requiredCapabilities: string[];
  outputSchema: Record<string, unknown>;
} | {
  ok: false;
  code: 'authority-unavailable' | 'output-schema-mismatch' | 'inspection-failed' |
    'inspection-pin-stale' | 'dynamic-tool-target' | 'tool-unavailable' |
    'effect-not-read' | 'egress-capability' | 'capability-denied';
};

/** External network rights have two existing spellings: capability:net for
 * host fetch and net:* for plugin confinement. Wildcard tool requirements
 * cannot prove absence of egress either. */
function hasEgress(capability: string): boolean {
  return capability === '*' || capability === 'capability:*' || capability === 'capability:net' ||
    capability === 'net' || capability.startsWith('net:');
}

/** Inspect only direct, literal facade targets. The general script parser also
 * permits aliases/higher-order calls which its static call census cannot prove
 * complete. Such scripts remain ordinary recipes; identity admission refuses
 * them. No eval, alternate executor, or new tool-name resolver is introduced.
 */
async function hasIndirectFacadeUse(source: string): Promise<boolean> {
  const loaded = await import('typescript');
  const ts = loaded.default ?? loaded;
  const file = ts.createSourceFile('identity-recipe.ts', source, ts.ScriptTarget.Latest, true);
  let indirect = false;
  const literal = (node: import('typescript').Node | undefined): string | null =>
    node && ts.isStringLiteralLike(node) ? node.text : null;
  function visit(node: import('typescript').Node): void {
    // Dynamic code and reflection have no complete static tool-call census.
    if ((ts.isIdentifier(node) && ['eval', 'Function', 'Reflect', 'globalThis'].includes(node.text)) ||
        (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
        (ts.isElementAccessExpression(node) &&
          (literal(node.argumentExpression) === null || literal(node.argumentExpression) === 'constructor')) ||
        node.kind === ts.SyntaxKind.ImportKeyword) indirect = true;
    // In tools.tools.invoke the second identifier is a property name, not a
    // second reference to the facade root.
    if (ts.isIdentifier(node) && node.text === 'tools' &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      let current: import('typescript').Node = node;
      const parts: string[] = [];
      while (current.parent &&
        ((ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) ||
         (ts.isElementAccessExpression(current.parent) && current.parent.expression === current))) {
        const parent = current.parent;
        const key = ts.isPropertyAccessExpression(parent) ? parent.name.text : literal(parent.argumentExpression);
        if (key === null) { indirect = true; break; }
        parts.push(key);
        current = parent;
      }
      const call = current.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== current ||
          !((parts.length === 2 && parts[0] !== 'call') ||
            (parts.length === 1 && parts[0] === 'call' && literal(call.arguments[0]) !== null))) {
        indirect = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return indirect;
}

/** Installation-time inspection under the wearer, narrowed by declared needs
 * and the host's pot/role ceiling. Tools/recipes deps are trusted host seams,
 * never values accepted from an identity package.
 */
export async function inspectIdentityRecipeProvider(input: {
  recipe: SavedRecipeSelector & { revision: string };
  bindings?: { values: Record<string, unknown> };
  contract: CapabilityClassVerb;
  outputSchema: Record<string, unknown>;
  declaredNeeds: readonly string[];
  capabilityCeiling: ReadonlySet<string>;
  context: UnifiedToolContext;
  expectedPin?: IdentityRecipeInspectionPin;
}, deps: { tools?: readonly ProjectedTool[]; recipes?: SavedRecipeAdapter } = {}): Promise<IdentityRecipeConformance> {
  const refuse = (code: Extract<IdentityRecipeConformance, { ok: false }>['code']) => ({ ok: false as const, code });
  const ctx = input.context;
  if (!ctx.principal || !ctx.role || !ctx.workspaceId || ctx.principal.workspaceId !== ctx.workspaceId ||
      ctx.signal.aborted) return refuse('authority-unavailable');
  if (!input.contract.outputSchema || !isCompilableSchema(input.contract.outputSchema) ||
      canonicalJson(input.contract.outputSchema) !== canonicalJson(input.outputSchema)) {
    return refuse('output-schema-mismatch');
  }
  const sets = [ctx.principal.capabilities, new Set(input.declaredNeeds), input.capabilityCeiling];
  const candidates = new Set(sets.flatMap((set) => [...set]));
  const capabilities = new Set([...candidates].filter((cap) => sets.every((set) => set.has(cap) || set.has('*'))));
  const context: UnifiedToolContext = {
    ...ctx, isSuperuser: false, gateBypass: undefined,
    principal: { ...ctx.principal, capabilities },
  };
  const tools = deps.tools ?? listAllProjectedTools();
  // A nested general-purpose runner would escape this recipe's inspected call
  // set. Keep the canonical recursion exclusions and cover the saved-recipe door.
  const allowed = roleScopedToolNames(tools, ctx.role,
    new Set([...ORCHESTRATION_RECURSION_EXCLUSIONS, 'recipes:run']));
  const inspected = await inspectOrchestration({
    recipe: input.recipe, ...(input.bindings ? { bindings: input.bindings } : {}),
    execution: { mode: 'server', lifecycle: 'foreground' }, capture: { mode: 'never' },
  }, context, {
    ...(deps.recipes ? { recipes: deps.recipes } : {}), projectedTools: tools,
    inspectScript: (args) => inspectScriptContract({ ...args,
      surface: { tools, allowed, catalog: currentCallerRecipeCatalog(tools, allowed) },
    }),
  });
  if (ctx.signal.aborted) return refuse('authority-unavailable');
  const parsed = inspectionSchema.safeParse((inspected as { data?: unknown }).data);
  if (!parsed.success) return refuse('inspection-failed');
  const normalized = parsed.data.normalized;
  const pin = normalized.durability.pin;
  if (normalized.recipe.id !== input.recipe.id || normalized.recipe.revision !== input.recipe.revision ||
      pin.recipeRevision !== input.recipe.revision ||
      pin.sourceSha256 !== createHash('sha256').update(normalized.script.source).digest('hex') ||
      (input.expectedPin && canonicalJson(input.expectedPin) !== canonicalJson(pin))) {
    return refuse('inspection-pin-stale');
  }
  if (await hasIndirectFacadeUse(normalized.script.source)) return refuse('dynamic-tool-target');
  const byName = new Map(tools.map((tool) => [tool.expose.mcp?.name, tool]));
  const required = new Set<string>();
  const names = new Set<string>();
  for (const call of normalized.staticToolCalls) {
    let name = call.tool;
    let args = call.args;
    const seen = new Set<string>();
    // Resolve every tools:invoke hop, not merely the first one. Metadata on the
    // wrapper cannot launder the target's effect, network rights or capabilities.
    for (;;) {
      const tool = byName.get(name);
      if (!tool || !allowed.has(name) || seen.has(name)) return refuse('tool-unavailable');
      seen.add(name);
      names.add(name);
      for (const cap of tool.capabilities) {
        if (hasEgress(cap)) return refuse('egress-capability');
        if (!capabilities.has(cap) && !capabilities.has('*')) return refuse('capability-denied');
        required.add(cap);
      }
      if (name === 'tools:invoke') {
        if (call.dynamicArgs || !args || typeof args !== 'object' || Array.isArray(args) ||
            !('name' in args) || typeof args.name !== 'string') return refuse('dynamic-tool-target');
        const nested = args as { name: string; args?: unknown };
        name = nested.name.trim();
        args = nested.args;
        continue;
      }
      // General dry-run classifiers may fall back on static metadata after an
      // error. A read-only identity needs affirmative per-call evidence instead.
      if (tool.effectForCall) {
        if (call.dynamicArgs) return refuse('effect-not-read');
        try { if (tool.effectForCall(args) !== 'read') return refuse('effect-not-read'); }
        catch { return refuse('effect-not-read'); }
      }
      if (classifyDurableCall(tool, name, args, tools) !== 'read-only') return refuse('effect-not-read');
      break;
    }
  }
  return { ok: true, recipe: normalized.recipe, inspectionPin: pin,
    toolNames: [...names].sort(), requiredCapabilities: [...required].sort(),
    outputSchema: JSON.parse(canonicalJson(input.contract.outputSchema)) as Record<string, unknown> };
}
