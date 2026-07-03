/**
 * POST /api/agent-mcp/p2p-allotment-set — the owner write path for the /res
 * Resources board (p2p-work-distribution-2026-07-02 P-201).
 *
 * The /res page writes through this dedicated loopback route (the
 * p2p-settings-set shape): a thin wrapper over the p2p/resource-allotments
 * store, plus the sync invalidation so the board refreshes. Actions:
 *
 *   set    — upsert an allotment: a host hands a resource (an account pool =
 *            remote axis, or a local GPU = local axis) to a fleet with a
 *            share-% cap. Re-setting the same (fleet, kind, ref) UPDATES the
 *            cap (PK upsert), so the /res slider writes are idempotent.
 *   remove — revoke a fleet's draw on a resource (the /res chip's ×).
 *
 * Loopback-only + owner authority (the desktop /res surface is the only
 * caller). Allotments are LOCAL/per-machine (M19) — never federated. The store
 * owns all field validation + the refusal shapes; this route passes them
 * through (a store refusal → 400 { error: refusal.code, detail }).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  action?: unknown;
  fleetSlug?: unknown;
  resourceKind?: unknown;
  resourceRef?: unknown;
  sharePct?: unknown;
  axis?: unknown;
  status?: unknown;
}

const ACTIONS = ['set', 'remove'] as const;
type Action = (typeof ACTIONS)[number];

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/p2p-allotment-set',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const action = ACTIONS.includes(body.action as Action) ? (body.action as Action) : null;
    if (!action) {
      return Response.json({ ok: false, error: 'missing_action' }, { status: 400 });
    }

    // Pass identity fields through raw — the store validates non-empty + kind and
    // returns typed refusals (fleet_required / resource_required / invalid_resource_kind).
    const fleetSlug = typeof body.fleetSlug === 'string' ? body.fleetSlug : '';
    const resourceKind = typeof body.resourceKind === 'string' ? body.resourceKind : '';
    const resourceRef = typeof body.resourceRef === 'string' ? body.resourceRef : '';

    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const ws = activeWorkspaceId();

    try {
      const store = await import('../../../p2p/resource-allotments');
      const { notifySyncInvalidate } = await import('../../../sync-sse');

      if (action === 'remove') {
        const removed = await store.removeResourceAllotment({
          workspaceId: ws,
          fleetSlug,
          resourceKind,
          resourceRef,
        });
        // The /res board reads `p2p.allotments` with NO args → name-only invalidate
        // (an args-scoped emit would never match — the adding-a-sync-query gotcha).
        await notifySyncInvalidate('p2p.allotments').catch(() => {});
        return Response.json({ ok: true, workspaceId: ws, action, ...removed });
      }

      // action === 'set' — resolve the setting host's numeric GitHub id (X9:
      // display/audit only; the resource is this machine's). Best-effort → null.
      let createdByGithubUserId: number | null = null;
      try {
        const { resolveUsageActor } = await import('../../../harness/usage-actor');
        createdByGithubUserId = (await resolveUsageActor().catch(() => null))?.githubUserId ?? null;
      } catch {}

      const result = await store.setResourceAllotment({
        workspaceId: ws,
        fleetSlug,
        resourceKind,
        resourceRef,
        // NaN when absent/non-numeric → the store's invalid_share_pct refusal.
        sharePct: typeof body.sharePct === 'number' ? body.sharePct : Number.NaN,
        axis:
          body.axis && typeof body.axis === 'object' && !Array.isArray(body.axis)
            ? (body.axis as Record<string, unknown>)
            : undefined,
        status: body.status === 'paused' ? 'paused' : body.status === 'active' ? 'active' : undefined,
        createdByGithubUserId,
      });

      if (!result.ok) {
        return Response.json(
          { ok: false, error: result.refusal.code, detail: result.refusal.detail },
          { status: 400 },
        );
      }
      await notifySyncInvalidate('p2p.allotments').catch(() => {});
      return Response.json({ ok: true, workspaceId: ws, action, allotment: result.allotment });
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error)?.message ?? 'p2p_allotment_set_failed' },
        { status: 400 },
      );
    }
  },
});
