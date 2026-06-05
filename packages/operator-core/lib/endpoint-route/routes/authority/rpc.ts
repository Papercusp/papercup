/**
 * POST /api/authority/rpc — the receiving endpoint for the per-harness lock
 * authority (Track B of distributed-coordination-shared-harness-2026-06-04).
 *
 * A peer that resolves a REMOTE authority for a harness routes its control op
 * (file-lock acquire/release/queue, plan-item claim lease) here via
 * HttpPeerRpcTransport. This route is the thin HTTP wrapper around the tested,
 * pure `handleAuthorityRpc` dispatch: it parses the {harnessSlug, kind, payload}
 * envelope, re-verifies THIS machine is actually the authority for that harness
 * (refusing a mis-routed op during a failover gap), runs the registered op
 * handler against the local store, and returns the result.
 *
 * auth: 'public' mirrors the sibling coord routes — the operator binds 127.0.0.1
 * by default and cross-machine access arrives over the authenticated mesh/tunnel
 * (the same posture as the lock hook POSTing to :3070). The verifyIsAuthority
 * guard is the app-level check that this machine should serialize the op at all.
 *
 * Reachability only LIGHTS UP cross-machine once a PeerAddressResolver maps a
 * peer's device_pubkey to its operator URL (the mesh mapping) and a transport is
 * registered (setPeerRpcTransport) — until then no peer routes here. The dispatch
 * itself is verified by the loopback + two-instance authority tests.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { handleAuthorityRpc, type AuthorityRpcEnvelope } from '../../../authority/authority-op-registry';
import { lockAuthorityFor } from '../../../authority/lock-authority';

export default defineTool({
  method: 'POST',
  path: '/authority/rpc',
  auth: 'public',
  async handler(req) {
    let body: AuthorityRpcEnvelope;
    try {
      body = (await req.json()) as AuthorityRpcEnvelope;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    if (!body || typeof body.harnessSlug !== 'string' || typeof body.kind !== 'string') {
      return Response.json({ ok: false, error: 'invalid_envelope' }, { status: 400 });
    }
    const result = await handleAuthorityRpc(body, {
      // Refuse an op we shouldn't serialize: a peer may have routed here during a
      // failover gap when we are no longer the authority for this harness.
      verifyIsAuthority: async (harnessSlug) => {
        const r = await lockAuthorityFor(harnessSlug);
        return r.isSelf;
      },
    });
    return Response.json(result);
  },
});
