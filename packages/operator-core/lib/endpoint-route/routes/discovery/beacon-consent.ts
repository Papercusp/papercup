/**
 * /api/discovery/beacon-consent — the HTTP face of the per-Hive beacon-publish
 * consent (hive-network-surface-2026-06-11 P-005, brief B-07; contract C-2).
 *
 *   GET  ?hiveId=<slug>        → { ok, hiveId, consent }   (absent = false, D-002)
 *   POST { hiveId, consent }   → { ok, hiveId, consent }
 *
 * The desktop hive header strip's beacon toggle drives this — the secondary
 * surface for the publish-flow consent question. Writes route through the shared
 * `beacon-consent` accessor so the value federates to every Swarm of the Hive.
 *
 * `auth: 'loopback'` (auth-tier Wave 1), exactly like /discovery/set-pot — the
 * desktop webview is cookie-less and the loopback bind is the perimeter.
 */
import { defineTool } from '@papercusp/agent-mcp';

const getBeaconConsent = defineTool({
  method: 'GET',
  path: '/discovery/beacon-consent',
  auth: 'loopback',
  async handler(req) {
    const hiveId = String(new URL(req.url).searchParams.get('hiveId') ?? '').trim();
    if (!hiveId) {
      return Response.json({ error: 'hiveId required', code: 'invalid_args' }, { status: 400 });
    }
    const { getBeaconPublishConsent } = await import('../../../beacon-consent');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const consent = await getBeaconPublishConsent(activeWorkspaceId(), hiveId).catch(() => false);
    return Response.json({ ok: true, hiveId, consent });
  },
});

const setBeaconConsent = defineTool({
  method: 'POST',
  path: '/discovery/beacon-consent',
  auth: 'loopback',
  async handler(req) {
    let body: { hiveId?: string; consent?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const hiveId = String(body.hiveId ?? '').trim();
    if (!hiveId) {
      return Response.json({ error: 'hiveId required', code: 'invalid_args' }, { status: 400 });
    }
    if (typeof body.consent !== 'boolean') {
      return Response.json(
        { error: 'consent must be a boolean', code: 'invalid_args' },
        { status: 400 },
      );
    }
    const { setBeaconPublishConsent } = await import('../../../beacon-consent');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    try {
      await setBeaconPublishConsent(activeWorkspaceId(), hiveId, body.consent);
    } catch (e) {
      // setHiveSetting rejects when the hive doesn't exist (logical scope, no FK).
      const msg = e instanceof Error ? e.message : String(e);
      const notFound = /no Hive/.test(msg);
      return Response.json(
        { error: msg, code: notFound ? 'hive_not_found' : 'set_failed' },
        { status: notFound ? 404 : 502 },
      );
    }
    return Response.json({ ok: true, hiveId, consent: body.consent });
  },
});

export default [getBeaconConsent, setBeaconConsent];
