/**
 * POST /api/cupboard/install-blueprint — install a blueprint from the Cupboard
 * (official-blueprints-cupboard-publish-2026-06-05 P-004 / D-001 / D-004).
 *
 * The install logic (listing resolution + core + the plugin/spawned-blueprint dep
 * closures) lives in `cupboard/install-blueprint-io.ts`
 * (`installBlueprintFromCupboard`) — the ONE path shared with the agent-callable
 * `cupboard:install-blueprint` tool (cupboard-agent-tool-coverage-2026-07-14 P-005,
 * D-001 reuse-first). This route only parses the loopback body and maps the
 * structured result to an HTTP response.
 *
 * Body: { listingId?, githubUrl?, listingRef?, installPlugins?, potSlug?, capabilityRole?,
 *         capabilityProviderSelections?, classContractConsent? }
 * `classContractConsent` is parsed with the same schema as the agent tool
 * (portable-identity-packages P-021 / D-015).
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { installBlueprintFromCupboard } from '../../cupboard/install-blueprint-io';
import { classContractConsentSchema, type ClassContractConsent } from '../../cupboard/class-contract-payload';

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-blueprint',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: {
      listingId?: string;
      githubUrl?: string;
      listingRef?: string;
      installPlugins?: boolean;
      potSlug?: string;
      capabilityRole?: string;
      capabilityProviderSelections?: Record<string, string>;
      classContractConsent?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    if (body.capabilityRole !== undefined &&
        (typeof body.capabilityRole !== 'string' || !body.capabilityRole.trim() || body.capabilityRole.trim().length > 120)) {
      return Response.json({ ok: false, error: 'invalid_capability_role' }, { status: 400 });
    }
    let classContractConsent: ClassContractConsent | undefined;
    if (body.classContractConsent !== undefined) {
      const parsed = classContractConsentSchema.safeParse(body.classContractConsent);
      if (!parsed.success) {
        return Response.json(
          { ok: false, error: 'invalid_class_contract_consent', detail: parsed.error.issues[0]?.message },
          { status: 400 },
        );
      }
      classContractConsent = parsed.data;
    }

    const outcome = await installBlueprintFromCupboard({
      ...(typeof body.listingId === 'string' ? { listingId: body.listingId } : {}),
      ...(typeof body.githubUrl === 'string' ? { githubUrl: body.githubUrl } : {}),
      ...(typeof body.listingRef === 'string' ? { listingRef: body.listingRef } : {}),
      installPlugins: body.installPlugins === true,
      ...(typeof body.potSlug === 'string' ? { potSlug: body.potSlug } : {}),
      ...(typeof body.capabilityRole === 'string' ? { capabilityRole: body.capabilityRole.trim() } : {}),
      capabilityMode: 'interactive',
      ...(body.capabilityProviderSelections &&
      typeof body.capabilityProviderSelections === 'object' &&
      !Array.isArray(body.capabilityProviderSelections)
        ? { capabilityProviderSelections: body.capabilityProviderSelections }
        : {}),
      ...(classContractConsent ? { classContractConsent } : {}),
    });

    if (!outcome.ok) {
      return Response.json(
        {
          ok: false,
          error: outcome.error,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          ...(outcome.data === undefined ? {} : { data: outcome.data }),
        },
        { status: outcome.status },
      );
    }
    return Response.json(outcome.result);
  },
});
