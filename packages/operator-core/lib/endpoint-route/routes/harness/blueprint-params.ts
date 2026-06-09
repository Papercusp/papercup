/**
 * GET /api/harness/:slug/blueprint-params — the declared, UI-introspectable
 * settings schema for a harness, resolved from its blueprint
 * (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-008 — the spine of the
 * schema-driven settings panel; consumes the P-006 `params` declaration).
 *
 * Returns `{ blueprintId, params }` where `params` is the blueprint's declared
 * `BlueprintParams` (base universal ∪ blueprint-specific, keyed by config.json
 * instance path). The client (`BlueprintSettingsPanel`) combines this with the
 * harness's `config.json` (loaded via the existing `/spec` route / sync mirror) and
 * `resolveParamViews` to render the right controls per harness type — so a coding
 * harness shows the worker/typecheck/debugger knobs, a research/gym harness shows its
 * own, and a Cupboard-installed blueprint gets a settings panel for free (D-003).
 *
 * Resolution mirrors the runtime (orchestrator-runner `harnessBlueprintKnobs`): the
 * harness's git-canonical `.papercusp/blueprint.yaml` (base merged via `extends`).
 * A harness with no blueprint file (pre-blueprint legacy) returns `{ params: {} }` —
 * the panel then shows the no-declared-params state (the legacy hardcoded panel stays
 * available behind its own flag).
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolvePhasedProject, harnessDir } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { defineTool } from '@papercusp/agent-mcp';

const getBlueprintParams = defineTool({
  method: 'GET',
  path: '/harness/:slug/blueprint-params',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const f = join(harnessDir(project), 'blueprint.yaml');
    if (!existsSync(f)) return Response.json({ blueprintId: null, params: {} });
    try {
      const { blueprint } = loadBlueprintFromFile(f);
      return Response.json({ blueprintId: blueprint.id, params: blueprint.params });
    } catch (e) {
      // A bad blueprint never strands the settings panel — surface empty params + the error.
      return Response.json({ blueprintId: null, params: {}, error: String((e as Error)?.message ?? e) });
    }
  },
});

export default [getBlueprintParams];
