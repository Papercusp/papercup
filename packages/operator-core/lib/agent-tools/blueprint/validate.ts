/**
 * blueprint:validate — check a blueprint (a built-in id, or inline YAML/JSON)
 * against the schema + the semantic validator (reachability, termination, guards,
 * bounded recursion). Returns errors + warnings instead of throwing, so an agent
 * can iterate on an authored blueprint.
 *
 * harness-blueprint-orchestration-2026-06-03 P-007 / B1.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { COORD_ROLES } from '../coordination/roles';
import { parseBlueprintSource, resolveAndValidate, type ResolveResult } from './_resolve';

function summarize(r: ResolveResult) {
  if (r.parseError) return { ok: false, parseError: r.parseError };
  const bp = r.blueprint!;
  return {
    ok: r.ok,
    errors: r.validation!.errors,
    warnings: r.validation!.warnings,
    summary: {
      id: bp.id,
      version: bp.version,
      workItemKind: bp.workItem.kind,
      roles: bp.roles.map((x) => x.id),
      // `edges` is absent on a program-mode spine (coord-op steps + gate) — show
      // its step ids instead so the summary is non-empty for vote/deliberate.
      spineVerbs: Object.keys(bp.spine.edges ?? {}),
      spineSteps: (bp.spine.steps ?? []).map((s) => s.id),
      requiresRepo: bp.knobs.requiresRepo,
    },
  };
}

export default defineTool({
  name: 'blueprint:validate',
  description:
    'Validate a Harness Blueprint — a built-in id (e.g. "coding") OR inline YAML/JSON. Returns {ok, errors, warnings, summary} (errors/warnings instead of throwing) so you can iterate. Checks the Zod schema + reachability/termination/guards/bounded-recursion.',
  guidance: {
    when: 'Before persisting a blueprint you authored (with blueprint:create/extend) or to inspect a built-in. Always validate before writing .papercusp/blueprint.yaml or calling harness:create.',
    notWhen: 'To run a blueprint — that is the orchestrator. To create a harness — harness:create.',
    chaining: 'blueprint:create/extend → blueprint:validate → (write .papercusp/blueprint.yaml or harness:create).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('A built-in blueprint id (coding, base, …)'),
      source: z.string().min(1).optional().describe('Inline blueprint as YAML or JSON'),
    })
    .refine((a) => a.id != null || a.source != null, { message: 'pass either id or source' }),
  async handler(args) {
    let result: ResolveResult;
    if (args.id != null) {
      try {
        const loaded = loadBuiltinBlueprint(args.id);
        result = { ok: loaded.validation.ok, blueprint: loaded.blueprint, validation: loaded.validation };
      } catch (e) {
        result = { ok: false, parseError: e instanceof Error ? e.message : String(e) };
      }
    } else {
      try {
        result = resolveAndValidate(parseBlueprintSource(args.source!));
      } catch (e) {
        result = { ok: false, parseError: e instanceof Error ? e.message : String(e) };
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(summarize(result)) }] };
  },
});
