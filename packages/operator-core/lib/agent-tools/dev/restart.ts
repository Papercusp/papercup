/**
 * dev:restart — the blessed path to restart the operator dev server (P-027).
 *
 * The canonical wrapper for the destructive "restart the dev server" action:
 * it acquires exclusive(dev-server) with a drain (existing users finish,
 * new ones are refused), then restarts, then releases (which broadcasts
 * "back up"). Use this instead of a raw `systemctl restart` so peers are
 * coordinated.
 *
 * Safe by default on a shared box:
 *   - No `confirm` → DRY RUN. Reports what it would do; takes NO lock,
 *     drains nobody, restarts nothing.
 *   - `confirm: true` → acquires + drains, then restarts ONLY if
 *     `PAPERCUSP_ALLOW_DEV_RESTART=1`; otherwise it drains and reports that
 *     the restart was withheld (the env gate is the shared-box backstop).
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import type { ResourceHolder } from '../locks/su-lock-store';

const RESTART_CMD = 'systemctl --user restart papercup-dev-api.service';
const MAX_DRAIN_SEC = 300;
const DEFAULT_DRAIN_SEC = 120;

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner, owner_label: h.owner_label, mode: h.mode, status: h.status,
});

export default defineTool({
  name: 'dev:restart',
  description:
    'Restart the operator dev server, coordinated. DRY RUN unless confirm:true. With confirm, acquires exclusive(dev-server) and drains current users (wait:{max_drain_sec}) before restarting, then releases (broadcasts "back up"). The real restart also requires PAPERCUSP_ALLOW_DEV_RESTART=1 on the host. Prefer this over a raw systemctl restart.',
  guidance: {
    when: 'You need to restart the dev server (e.g. to pick up a lib/** edit). Run dry first to see who is using it; then confirm to drain + restart.',
    notWhen: 'Just probing the server — that needs no restart. Never restart casually on a shared box; it disrupts every agent using the app.',
    chaining: 'dev:restart (dry) → review holders → dev:restart { confirm: true, max_drain_sec } → connection drops as it restarts.',
  },
  capability: 'locks:write',
  timeoutSec: MAX_DRAIN_SEC + 30,
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
  }),
  async handler(args, ctx) {
    // Dry run — ctx-free, takes no lock, drains nobody.
    if (!args.confirm) {
      return json({
        ok: true,
        dry_run: true,
        would_run: RESTART_CMD,
        note: 'Pass confirm:true to acquire exclusive(dev-server), drain current users, then restart. DISRUPTS all agents. The real restart also requires PAPERCUSP_ALLOW_DEV_RESTART=1.',
      });
    }

    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabled = process.env.PAPERCUSP_ALLOW_DEV_RESTART === '1';

    const outcome = await guardResource(
      {
        coordinationDomain,
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: 'dev-server',
        mode: 'exclusive',
        maxDrainSec: args.max_drain_sec ?? DEFAULT_DRAIN_SEC,
        reason: 'dev-server restart',
      },
      async (fence) => {
        if (!enabled) {
          return json({
            ok: true,
            drained: true,
            restarted: false,
            note: 'Drain complete, but restart WITHHELD — set PAPERCUSP_ALLOW_DEV_RESTART=1 to enable the real restart.',
          });
        }
        // D-001 fencing: re-verify we still hold the effective exclusive at our
        // fence immediately before the destructive restart. A paused/zombie
        // holder whose lease lapsed and was re-granted is rejected here rather
        // than restarting out from under the agent that now owns the resource.
        const fc = await fence.assertCurrent();
        if (!fc.current) {
          return json({
            ok: false,
            restarted: false,
            reason: `stale_fence_${fc.reason}`,
            fence_seq: fence.seq,
            live_fence_seq: fc.live_fence_seq,
            note: 'Restart ABORTED — our exclusive(dev-server) lease was superseded while we held it. Re-acquire before retrying.',
          });
        }
        // Detached + delayed so this response returns before the service dies.
        const child = spawn('sh', ['-c', `sleep 1; ${RESTART_CMD}`], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return json({
          ok: true,
          drained: true,
          restarted: true,
          fence_seq: fence.seq,
          note: 'Restart scheduled (~1s) — this connection will drop as the operator restarts.',
        });
      },
    );

    if (outcome.acquired) return outcome.result;
    return json({
      ok: false,
      reason: `resource_${outcome.reason}`,
      resource: 'dev-server',
      holders: outcome.holders.map(holderJson),
    });
  },
});
