/**
 * POST /api/discovery/join-pot — join a discovered hive AS A HIVE
 * (hive-from-repo-hardening-2026-06-11 P-007 / D-007).
 *
 * Body: { hiveId, title?, hivePubkey?, memberLinks: string[] }
 * Composes the existing per-member-link join for every link, then
 * materializes the joiner-side registry VIEW (a `remote_hive`-flagged
 * kind:'hive' entry + hive_slug on the joined members) so the Harnesses tab
 * groups them. This is what the directory panel's Join drives now; the
 * per-link POST /api/harness/join-link stays the underlying mechanic.
 *
 * Loopback + long timeout: N member joins = N read-only clones.
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/discovery/join-pot',
  // The formal Wave-1 tier (auth-posture standing gate) — N member joins =
  // N read-only clones, desktop-webview-only like its discovery siblings.
  auth: 'loopback',
  timeoutSec: 600,
  async handler(req) {
    let body: { hiveId?: string; title?: string; hivePubkey?: unknown; memberLinks?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const hiveId = String(body.hiveId ?? '').trim();
    const memberLinks = Array.isArray(body.memberLinks)
      ? body.memberLinks.filter((l): l is string => typeof l === 'string' && l.length > 0)
      : [];
    if (!hiveId || memberLinks.length === 0) {
      return Response.json(
        { error: 'hiveId and memberLinks[] required', code: 'invalid_args' },
        { status: 400 },
      );
    }
    if (memberLinks.length > 64) {
      return Response.json(
        { error: 'too many member links (max 64)', code: 'invalid_args' },
        { status: 400 },
      );
    }
    const { joinHiveAsView } = await import('../../../harness/join-hive');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const res = await joinHiveAsView({
      hiveId,
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
      ...(typeof body.hivePubkey === 'string' && body.hivePubkey.trim()
        ? { hivePubkey: body.hivePubkey.trim() }
        : {}),
      memberLinks,
      workspaceId: activeWorkspaceId(),
    });
    if (!res.ok) {
      const status = res.error === 'invalid_member_links' ? 400 : 502;
      return Response.json(
        { error: res.error ?? 'join failed', code: res.error, members: res.members },
        { status },
      );
    }
    // Bust the registry caches so the new view + members group immediately.
    try {
      const { bustProjectsLiteCache } = await import('../../../harness/projects-lite');
      bustProjectsLiteCache();
    } catch {
      /* best-effort */
    }
    return Response.json(res);
  },
});
