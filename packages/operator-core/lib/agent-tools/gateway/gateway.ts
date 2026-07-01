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
import { activeWorkspaceId } from '../../workspace-registry';
import { setOwnerPin, clearOwnerPin } from '../../deployment/account-owner-pins';

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
    seeAlso: [
      'gateway:reload (apply pool changes live)',
      'accounts:register (edit the pool)',
      'accounts:pin (route an agent to a specific account)',
    ],
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

export const accountsPinTool = defineTool({
  name: 'accounts:pin',
  description:
    "Pin an agent to a pool account on the inference gateway, LIVE (no respawn). `agent` = the TARGET agent's owner/spawn id — pass your OWN id to pin yourself, or another agent's id to pin them. `account` = a pool account id (see gateway:status / accounts:list). `hard:true` ⇒ NEVER fail over off it (waits / 429s on that account); default (soft) prefers it but yields if it is paused/exhausted. The gateway routes that agent's SUBSEQUENT requests to the account, overriding its spawn-time pin. CAUTION: concentrating many agents on one account rate-throttles it — prefer accounts with headroom (gateway:status) and spread load. In-memory: re-apply after a gateway restart. Returns {ok, ownerId, pin}.",
  guidance: {
    when: 'Dynamically routing an agent (yourself or another) to a specific pool account without respawning it.',
    notWhen: 'Steering which account NEW spawns get fleet-wide — that is accounts:set-session-override.',
    chaining: 'gateway:status (pick an account with headroom) → accounts:pin { agent, account } → accounts:unpin to revert.',
    seeAlso: [
      'accounts:unpin (revert the pin)',
      'gateway:status (pick an account with headroom)',
      'accounts:set-session-override (steer NEW spawns fleet-wide instead)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().min(1).describe("target agent's owner/spawn id (pass your own id to pin yourself)"),
    account: z.string().min(1).describe('pool account id to route the agent to'),
    hard: z.boolean().optional().describe('true ⇒ never fail over off the account (default: soft, yields if paused/exhausted)'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ agent, account, hard, workspace }, ctx) {
    const ws = workspace ?? ctx?.workspaceId ?? ctx?.principal?.workspaceId ?? activeWorkspaceId();
    try {
      const cfg = (await fetch(`${gwBase()}/admin/config`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json())
        .catch(() => ({}))) as { accounts?: string[] };
      if (Array.isArray(cfg.accounts) && !cfg.accounts.includes(account)) {
        return fail({ error: `account '${account}' is not in the gateway pool`, accounts: cfg.accounts });
      }
      // DURABLE write FIRST (the DB store is the source of truth — survives a gateway restart), THEN push to
      // the running gateway for IMMEDIATE effect. If the live push fails, the pin is still durable and loads
      // on the gateway's next poll / restart, so we report success-with-warning rather than failing.
      const pin = await setOwnerPin(ws, agent, { account, hard: !!hard });
      const r = await fetch(`${gwBase()}/admin/owner-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerId: agent, account, hard: !!hard }),
        signal: AbortSignal.timeout(10000),
      }).catch((e) => ({ ok: false, status: 0, _e: errMsg(e) }) as unknown as Response);
      void import('../../sync-sse').then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
      return ok({
        ownerId: agent,
        pin,
        appliedLive: r.ok,
        ...(r.ok ? {} : { warn: `pin saved durably but live apply to the gateway failed (it will load on the next poll/restart)` }),
      });
    } catch (e) {
      return fail({ error: `accounts:pin failed: ${errMsg(e)}` });
    }
  },
});

export const accountsUnpinTool = defineTool({
  name: 'accounts:unpin',
  description:
    'Remove a dynamic account pin set by accounts:pin (LIVE). `agent` = the target agent owner/spawn id. The agent reverts to its spawn-time routing (its static x-papercusp-account header, or the pool default). Returns {ok, ownerId, cleared}.',
  guidance: {
    when: 'Reverting an accounts:pin so the agent routes normally again.',
    notWhen: 'It was never dynamically pinned (no-op — cleared:false).',
    chaining: 'accounts:pin … → accounts:unpin { agent }.',
    seeAlso: [
      'accounts:pin (pin an agent to an account)',
      'gateway:status (confirm live routing)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().min(1).describe('target agent owner/spawn id to unpin'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler({ agent, workspace }, ctx) {
    const ws = workspace ?? ctx?.workspaceId ?? ctx?.principal?.workspaceId ?? activeWorkspaceId();
    try {
      const cleared = await clearOwnerPin(ws, agent); // durable clear first
      const r = await fetch(`${gwBase()}/admin/owner-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerId: agent, clear: true }),
        signal: AbortSignal.timeout(10000),
      }).catch((e) => ({ ok: false, status: 0, _e: errMsg(e) }) as unknown as Response);
      void import('../../sync-sse').then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
      return ok({ ownerId: agent, cleared, appliedLive: r.ok });
    } catch (e) {
      return fail({ error: `accounts:unpin failed: ${errMsg(e)}` });
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
    seeAlso: [
      'gateway:status (confirm the reload took effect)',
      'accounts:register (add an account to the pool)',
      'accounts:remove (remove one)',
    ],
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
