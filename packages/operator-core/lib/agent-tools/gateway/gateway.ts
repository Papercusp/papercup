/**
 * gateway:* — agent control surface for the running inference gateway (:8788), B-GWCTL
 * (gateway-live-control-and-egress-plan-2026-06-20). Thin HTTP wrappers over the gateway's
 * /admin/config + /admin/reload endpoints (B-HOT-2), so an agent can read the LIVE pool config and
 * apply an accounts:* / egress change to the RUNNING gateway WITHOUT a restart (the hot-config core,
 * B-HOT-1) — instead of the two gateway restarts an account swap used to need.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';

/** Localhost base of the running gateway. Read PER-CALL (not at module load) so tests can point it at a
 *  mock server via PAPERCUSP_GATEWAY_PORT, and so an env override is honored without a re-import. */
const gwBase = () => `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
const ok = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...p }) }] });
const fail = (p: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...p }) }] });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export const gatewayStatusTool = defineTool({
  name: 'gateway:status',
  description:
    'Read the inference gateway LIVE config (GET :8788/admin/config): the account-pool config version, the live account ids, and the admission/AIMD concurrency state. Use to see what pool + concurrency the RUNNING gateway is actually using, or to confirm a gateway:reload landed (the version bumped). Returns {ok, version, accounts, admission, aimd, ...}.',
  guidance: {
    when: 'Confirming what the running gateway is using right now, or verifying a hot-reload took effect (version bump).',
    notWhen: 'Editing the pool itself — accounts:register / accounts:remove (then gateway:reload to apply live).',
    chaining: 'accounts:register/remove → gateway:reload → gateway:status (confirm version + accounts).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const r = await fetch(`${gwBase()}/admin/config`, { signal: AbortSignal.timeout(5000) });
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return r.ok ? ok(b) : fail({ error: `gateway /admin/config → ${r.status}`, ...b });
    } catch (e) {
      return fail({ error: `gateway unreachable at ${gwBase()}: ${errMsg(e)}` });
    }
  },
});

export const gatewayReloadTool = defineTool({
  name: 'gateway:reload',
  description:
    'HOT-RELOAD the inference gateway account pool from the DB source-of-truth NOW (POST :8788/admin/reload) — applies a just-made accounts:register / accounts:remove / egress change to the RUNNING gateway immediately, NO restart (vs waiting for the gateway’s ~60s poll). Returns {ok, changed, version, accounts}; changed:false means the live pool already matched the DB.',
  guidance: {
    when: 'Right after accounts:register / accounts:remove / an egress change, to apply it live without a gateway restart.',
    notWhen: 'You can wait ~60s — the gateway polls + hot-reloads the DB pool on its own.',
    chaining: 'accounts:register → gateway:reload → gateway:status.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    try {
      const r = await fetch(`${gwBase()}/admin/reload`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return r.ok ? ok(b) : fail({ error: `gateway /admin/reload → ${r.status}`, ...b });
    } catch (e) {
      return fail({ error: `gateway unreachable at ${gwBase()}: ${errMsg(e)}` });
    }
  },
});
