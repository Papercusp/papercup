/**
 * /learning-packs/* — the HTTP faces the Learnings view drives
 * (learning-packs-2026-06-11 P-009/P-010/P-013). Thin over
 * lib/learning-packs/manage — the SAME classify→review→apply contract as the
 * learning_packs:* MCP verbs: install/upgrade return `review_required` + the
 * per-item report when clashes exist and no resolutions were given; the UI
 * renders the side-by-side cards and re-submits with explicit resolutions.
 *
 * All loopback (mutating, Wave-1 rule) + flag-gated (LEARNING_PACKS).
 */
import { FLAGS } from '@papercusp/flags';
import { defineTool } from '@papercusp/agent-mcp';
import { gateApiRoute } from '../../require-flag';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';

type InstallBody = {
  hive?: string;
  pack?: string;
  resolutions?: Array<{ itemId: string; action: 'install' | 'skip' | 'replace' | 'keep-both' }>;
  acceptDefaults?: boolean;
};

function badRequest(msg: string): Response {
  return Response.json({ ok: false, error: msg }, { status: 400 });
}

const install = defineTool({
  method: 'POST',
  path: '/learning-packs/install',
  auth: 'loopback',
  // Classification = N searches + ≤N judge calls; give it headroom.
  timeoutSec: 180,
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.LEARNING_PACKS);
    if (gated) return gated;
    let body: InstallBody = {};
    try { body = (await req.json()) as InstallBody; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId) return badRequest('hive and pack are required');

    const { loadLearningPack } = await import('../../learning-packs/load-packs');
    const loaded = await loadLearningPack(packId);
    if (!loaded) return Response.json({ ok: false, error: 'pack_not_found' }, { status: 404 });

    const { classifyPackInstall, applyPackInstall } = await import('../../learning-packs/manage');
    const review = await classifyPackInstall({ hiveSlug: hive, pack: loaded.pack });
    const hasClashes = review.duplicates + review.conflicts > 0;
    if (hasClashes && !body.resolutions && body.acceptDefaults !== true) {
      return Response.json({ ok: false, reason: 'review_required', review });
    }
    const result = await applyPackInstall({
      workspaceId: activeWorkspaceId(),
      hiveSlug: hive,
      pack: loaded.pack,
      review,
      ...(body.resolutions ? { resolutions: body.resolutions } : {}),
      createdBy: (await getSessionUserOrDefault(req.headers)).id,
    });
    return Response.json(result);
  },
});

const upgrade = defineTool({
  method: 'POST',
  path: '/learning-packs/upgrade',
  auth: 'loopback',
  timeoutSec: 180,
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.LEARNING_PACKS);
    if (gated) return gated;
    let body: InstallBody = {};
    try { body = (await req.json()) as InstallBody; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId) return badRequest('hive and pack are required');

    const { loadLearningPack } = await import('../../learning-packs/load-packs');
    const loaded = await loadLearningPack(packId);
    if (!loaded) return Response.json({ ok: false, error: 'pack_not_found' }, { status: 404 });

    const { planPackUpgrade, applyPackInstall } = await import('../../learning-packs/manage');
    const plan = await planPackUpgrade({ hiveSlug: hive, pack: loaded.pack });
    if (plan.newItems.items.length === 0) {
      return Response.json({ ok: true, upToDate: true, ...plan });
    }
    const hasClashes = plan.newItems.duplicates + plan.newItems.conflicts > 0;
    if (hasClashes && !body.resolutions && body.acceptDefaults !== true) {
      return Response.json({ ok: false, reason: 'review_required', review: plan.newItems, plan });
    }
    const result = await applyPackInstall({
      workspaceId: activeWorkspaceId(),
      hiveSlug: hive,
      pack: loaded.pack,
      review: plan.newItems,
      ...(body.resolutions ? { resolutions: body.resolutions } : {}),
      createdBy: (await getSessionUserOrDefault(req.headers)).id,
    });
    return Response.json({ ...result, installedVersions: plan.installedVersions, availableVersion: plan.availableVersion });
  },
});

const uninstall = defineTool({
  method: 'POST',
  path: '/learning-packs/uninstall',
  auth: 'loopback',
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.LEARNING_PACKS);
    if (gated) return gated;
    let body: { hive?: string; pack?: string; keepEdited?: boolean } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId) return badRequest('hive and pack are required');

    const { loadLearningPack } = await import('../../learning-packs/load-packs');
    const { uninstallPack } = await import('../../learning-packs/manage');
    const loaded = await loadLearningPack(packId);
    const result = await uninstallPack({
      hiveSlug: hive,
      packId,
      pack: loaded?.pack ?? null,
      ...(body.keepEdited !== undefined ? { keepEdited: body.keepEdited === true } : {}),
    });
    return Response.json(result);
  },
});

const setEnabled = defineTool({
  method: 'POST',
  path: '/learning-packs/set-enabled',
  auth: 'loopback',
  async handler(req) {
    const gated = await gateApiRoute(req, FLAGS.LEARNING_PACKS);
    if (gated) return gated;
    let body: { hive?: string; pack?: string; enabled?: boolean } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty */ }
    const hive = String(body.hive ?? '').trim();
    const packId = String(body.pack ?? '').trim();
    if (!hive || !packId || typeof body.enabled !== 'boolean') {
      return badRequest('hive, pack and enabled are required');
    }
    const { setPackEnabled } = await import('../../learning-packs/manage');
    const result = await setPackEnabled({
      workspaceId: activeWorkspaceId(),
      hiveSlug: hive,
      packId,
      enabled: body.enabled,
    });
    return Response.json({ ...result, pack: packId, enabled: body.enabled });
  },
});

export default [install, upgrade, uninstall, setEnabled];
