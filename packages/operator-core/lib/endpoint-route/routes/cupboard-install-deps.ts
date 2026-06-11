/**
 * POST /cupboard/install-deps — close the install loop
 * (`tool-distribution-discovery-2026-06-08` P-002 / D-002).
 *
 * The deliberate one-click "install everything this needs" action. Given a
 * declared dep set (or a blueprint id to read deps from), resolve each
 * Cupboard-installable tool/pack/plugin to its providing listing and INSTALL it
 * — transitively, recursing on each installed unit's own deps — instead of just
 * reporting it advisorily like the shipped gate. Wraps the pure
 * `resolveAndInstallDeps` core with the real install IO.
 *
 * Body: { deps?: {tools,packs,plugins}, blueprintId?, blueprint?, harness?, acceptCapabilities? }
 *   - deps        install exactly these declared deps
 *   - blueprintId resolve a blueprint (local→installed→built-in) and install ITS deps
 *   - blueprint   an inline blueprint object (alternative to blueprintId)
 *   - harness + acceptCapabilities → grant installed units' caps for that harness
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate, like the
 * sibling cupboard routes.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { resolveAndValidate } from '../../agent-tools/blueprint/_resolve';
import { derivePackCatalog } from '../../cupboard/pack-catalog';
import { resolveAndInstallDeps, type DepSet } from '../../cupboard/resolve-and-install';
import { installCupboardUnitFromListing } from '../../cupboard/install-io';

const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-deps',
  auth: 'loopback',
  timeoutSec: 180,
  // Close the install loop: resolve a blueprint's (or an explicit set of)
  // tool/pack/plugin deps to their Cupboard listings and INSTALL them — the
  // deliberate one-click "install missing deps" action (the harness:create gate
  // only REPORTS installable deps; autoInstallDeps:true does both in one call).
  // (HTTP-route defineTools carry no `guidance` block — that's MCP-tool only.)
  async handler(req) {
    let body: {
      deps?: { tools?: unknown; packs?: unknown; plugins?: unknown };
      blueprintId?: string;
      blueprint?: Record<string, unknown>;
      harness?: string;
      acceptCapabilities?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    let declared: DepSet | null = null;
    if (body.deps) {
      declared = {
        tools: asStrArray(body.deps.tools),
        packs: asStrArray(body.deps.packs),
        plugins: asStrArray(body.deps.plugins),
      };
    } else if (body.blueprintId || body.blueprint) {
      const resolver = operatorResolveExtends({});
      const childObj: Record<string, unknown> = body.blueprint ?? { id: 'install-deps-probe', extends: body.blueprintId };
      const validation = resolveAndValidate(childObj, resolver);
      if (validation.parseError || !validation.ok) {
        return Response.json(
          { ok: false, error: 'blueprint invalid', parseError: validation.parseError, errors: validation.validation?.errors },
          { status: 422 },
        );
      }
      if (body.blueprintId && resolver(body.blueprintId) == null) {
        return Response.json({ ok: false, error: `unknown blueprint "${body.blueprintId}"` }, { status: 404 });
      }
      const d = validation.blueprint!.dependencies;
      declared = { tools: d?.tools ?? [], packs: d?.packs ?? [], plugins: d?.plugins ?? [] };
    }
    if (!declared) {
      return Response.json({ ok: false, error: 'pass `deps`, `blueprintId`, or `blueprint`' }, { status: 400 });
    }

    const harness = typeof body.harness === 'string' ? body.harness.trim() : undefined;
    const acceptCapabilities = body.acceptCapabilities === true;

    const result = await resolveAndInstallDeps(declared, {
      deriveCatalog: () => derivePackCatalog({ harnessSlug: harness }),
      installUnit: (u) => installCupboardUnitFromListing(u, { harness, acceptCapabilities }),
    });
    return Response.json(result);
  },
});
