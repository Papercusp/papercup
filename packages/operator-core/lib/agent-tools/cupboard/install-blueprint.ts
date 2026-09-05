/**
 * cupboard:install-blueprint — install a blueprint from the Cupboard
 * (cupboard-agent-tool-coverage-2026-07-14 P-005).
 *
 * The agent-callable face of `installBlueprintFromCupboard` — the SAME core the
 * loopback POST /cupboard/install-blueprint route calls (D-001 reuse-first, no
 * fork): git-clone the listing's repo, validate the blueprint, and place it under
 * ~/.papercusp/blueprints/<id>/ (the installed tier that shadows the built-in of
 * the same id). With installPlugins:true the blueprint's Cupboard-resolvable
 * plugin deps auto-install (consent-gated); declared work-blueprint deps pull
 * their providers in (spawned-blueprint closure).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:install-blueprint',
  capability: 'harness:write',
  description:
    "Install a blueprint from the Cupboard: give a listingId (resolves the repo + ref from the listing) OR a githubUrl directly; the operator git-clones the repo, validates <listingRef>/blueprint.yaml (schema + semantics + dep-validation), and places it under ~/.papercusp/blueprints/<id>/ where it shadows the built-in of the same id. installPlugins:true consents to auto-install the blueprint's Cupboard-resolvable plugin deps; declared work-blueprint deps are pulled in too. The response reports the installed blueprint + any dep-closure installs.",
  guidance: {
    when: "Installing a blueprint from the Cupboard so it becomes available to harness:create — the user found a blueprint listing (cupboard:search / blueprint:catalog) and wants it installed.",
    notWhen:
      "Browsing installable blueprints (blueprint:catalog); creating a harness from an ALREADY-installed blueprint (harness:create); installing a plugin (cupboard:install-plugin) or app-template (templates:new-app); publishing a blueprint (blueprint:publish).",
    chaining:
      'Find the listing first (cupboard:search / blueprint:catalog) for its listingId. After install, harness:create can use the blueprint. Set installPlugins:true to also pull the blueprint\'s declared plugin deps.',
    seeAlso: [
      'blueprint:catalog (browse installable blueprints)',
      'harness:create (create a harness from the installed blueprint)',
      'cupboard:install-plugin (install a plugin instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id — resolves the repo URL + listing_ref from the listing.'),
    githubUrl: z.string().max(500).optional().describe('Install a repo directly instead of resolving a listing (listingRef = the blueprint subdir).'),
    listingRef: z.string().max(200).optional().describe('Within-repo blueprint discriminator (the subdir to look in first).'),
    installPlugins: z
      .boolean()
      .optional()
      .describe("Consent to auto-install the blueprint's Cupboard-resolvable plugin deps."),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    if (!args.listingId && !args.githubUrl) {
      return text({ ok: false, error: 'listingId or githubUrl required' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'blueprint',
      subject,
    });
    if (!gate.ok) {
      return text({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installBlueprintFromCupboard } = await import('../../cupboard/install-blueprint-io');
    const outcome = await installBlueprintFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      installPlugins: args.installPlugins === true,
    });

    if (!outcome.ok) {
      return text({ ok: false, error: outcome.error, detail: outcome.detail, status: outcome.status });
    }
    const r = outcome.result;
    return text({
      ok: true,
      id: r.id,
      version: r.version,
      abstract: r.abstract,
      installedTo: r.installedTo,
      dependencies: r.dependencies,
      ...(r.pluginInstalls.length > 0 ? { pluginInstalls: r.pluginInstalls } : {}),
      ...(r.blueprintInstalls.length > 0 ? { blueprintInstalls: r.blueprintInstalls } : {}),
    });
  },
});
