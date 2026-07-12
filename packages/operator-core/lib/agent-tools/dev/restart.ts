/**
 * dev:restart — the blessed path to restart the operator dev server (P-027)
 * OR the staging operator (`target: 'staging'`, WI-4221).
 *
 * The canonical wrapper for the destructive "restart the dev/staging server"
 * action: it acquires exclusive(<target>-server) with a drain (existing
 * users finish, new ones are refused), then restarts, then releases (which
 * broadcasts "back up"). Use this instead of a raw `systemctl restart` so
 * peers are coordinated.
 *
 * Safe by default on a shared box:
 *   - No `confirm` → DRY RUN. Reports what it would do; takes NO lock,
 *     drains nobody, restarts nothing.
 *   - `confirm: true` → acquires + drains, then restarts ONLY if
 *     `PAPERCUSP_ALLOW_DEV_RESTART=1`; otherwise it drains and reports that
 *     the restart was withheld (the env gate is the shared-box backstop).
 *
 * WI-4221 (staging debounce/coalescing): `papercup-staging-api.service` was
 * being restarted raw (uncoordinated `systemctl`) every ~5-6min for hours —
 * every agent's own "test a live edit" workflow firing its own restart, each
 * one a real (if brief) outage AND the trigger that made EI-9748 (headless
 * children reaped by the service's cgroup on every restart) fire constantly.
 * `target: 'staging'` additionally debounces: on a REAL restart it acquires
 * `staging-server-cooldown` (exclusive, TTL=STAGING_COOLDOWN_SEC) and
 * deliberately does NOT release it — it is left to expire. A restart request
 * that lands while that cooldown is still held is COALESCED: no second
 * restart fires, the caller is told a peer already restarted recently and
 * :3170 should already be back up. `target: 'dev'` (default) is unchanged —
 * :3070 restarts are already infrequent (auto-deploy-pipeline-driven), so no
 * cooldown is applied there.
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { tryAcquireResource, tryReleaseResource, type ResourceHolder } from '../locks/su-lock-store';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';

const MAX_DRAIN_SEC = 300;
const DEFAULT_DRAIN_SEC = 120;

/** WI-4221: how long a real staging restart's cooldown marker stands before
 *  a subsequent restart request is allowed through again. Long enough to
 *  coalesce a burst of "test my edit" restarts from several agents within
 *  the same short window; short enough that a genuinely new edit a couple
 *  minutes later still gets its own restart promptly. */
const STAGING_COOLDOWN_SEC = 120;

type RestartTarget = 'dev' | 'staging';

const TARGETS: Record<RestartTarget, { unit: string; resource: string; cooldownResource?: string }> = {
  dev: { unit: 'papercup-dev-api.service', resource: 'dev-server' },
  staging: { unit: 'papercup-staging-api.service', resource: 'staging-server', cooldownResource: 'staging-server-cooldown' },
};

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner, owner_label: h.owner_label, mode: h.mode, status: h.status,
});

export default defineTool({
  name: 'dev:restart',
  description:
    'Restart the operator dev server (target:"dev", default) or the staging operator (target:"staging"), coordinated. DRY RUN unless confirm:true. With confirm, acquires exclusive(<target>-server) and drains current users (wait:{max_drain_sec}) before restarting, then releases (broadcasts "back up"). staging additionally DEBOUNCES (WI-4221): a restart requested within ~2min of a peer\'s real staging restart is coalesced (skipped, not re-run) instead of firing a redundant one. The real restart also requires PAPERCUSP_ALLOW_DEV_RESTART=1 on the host. Prefer this over a raw systemctl restart.',
  guidance: {
    when: 'You need to restart the dev server (e.g. to pick up a lib/** edit), or — target:"staging" — the staging operator (:3170) to pick up a live server-side edit per CLAUDE.md\'s "test a server-side edit live" workflow. Run dry first to see who is using it; then confirm to drain + restart.',
    notWhen: 'Just probing the server — that needs no restart. Never restart casually on a shared box; it disrupts every agent using the app. Never shell out to a raw `systemctl --user restart papercup-staging-api.service` — it bypasses the drain AND the debounce, which is exactly the uncoordinated-churn defect (WI-4221) this tool exists to fix.',
    chaining: 'dev:restart (dry) → review holders → dev:restart { confirm: true, max_drain_sec, target } → connection drops as it restarts (or, for staging within the cooldown window, a coalesced:true no-op — probe :3170 directly, a peer already restarted it).',
    seeAlso: [
      'dev:service_health (check what is down first)',
      'dev:processes (see the running processes)',
    ],
  },
  capability: 'locks:write',
  timeoutSec: MAX_DRAIN_SEC + 30,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
    target: z.enum(['dev', 'staging']).optional(),
  }),
  async handler(args, ctx) {
    const target: RestartTarget = args.target ?? 'dev';
    const cfg = TARGETS[target];
    const restartCmd = `systemctl --user restart ${cfg.unit}`;

    // Dry run — ctx-free, takes no lock, drains nobody.
    if (!args.confirm) {
      return json({
        ok: true,
        dry_run: true,
        target,
        would_run: restartCmd,
        note: `Pass confirm:true to acquire exclusive(${cfg.resource}), drain current users, then restart. DISRUPTS all agents.${
          cfg.cooldownResource
            ? ' If a peer restarted this target within the last ~2min, the restart is coalesced (skipped) instead of re-run.'
            : ''
        } The real restart also requires PAPERCUSP_ALLOW_DEV_RESTART=1.`,
      });
    }

    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabled = process.env.PAPERCUSP_ALLOW_DEV_RESTART === '1';

    // WI-4221 debounce: for a cooldown-bearing target (staging), try to claim
    // the cooldown marker FIRST, before touching the drain-gate at all. If a
    // peer's real restart already holds it (their restart landed within the
    // last STAGING_COOLDOWN_SEC), coalesce — no drain, no restart, no
    // redundant outage. We deliberately do NOT release this marker on our
    // own successful restart below; it is left to expire via its TTL, which
    // IS the debounce window.
    let cooldownLockId: string | null = null;
    if (enabled && cfg.cooldownResource) {
      const cd = cfg.cooldownResource;
      const cooldown = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryAcquireResource(tx, {
          coordinationDomain,
          resource: cd,
          mode: 'exclusive',
          owner: ownerId,
          ownerLabel,
          reason: `${target}-server restart cooldown (WI-4221)`,
          ttlSec: STAGING_COOLDOWN_SEC,
        }),
      );
      if (!cooldown.ok) {
        const holder = cooldown.holders.find((h) => h.mode === 'exclusive');
        return json({
          ok: true,
          target,
          restarted: false,
          coalesced: true,
          note: `${cfg.unit} was restarted within the last ~${STAGING_COOLDOWN_SEC}s${
            holder ? ` by ${holder.owner_label ?? holder.owner}` : ' by a peer'
          } — skipping a redundant restart. It should already be back up; probe it directly. If you still see stale behavior after a few seconds, wait for the cooldown to lapse and retry.`,
        });
      }
      cooldownLockId = cooldown.lock_id;
    }

    const releaseCooldownOnAbort = async () => {
      if (!cooldownLockId) return;
      await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryReleaseResource(tx, { coordinationDomain, owner: ownerId, lockId: cooldownLockId! }),
      ).catch(() => {});
    };

    const outcome = await guardResource(
      {
        coordinationDomain,
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: cfg.resource,
        mode: 'exclusive',
        maxDrainSec: args.max_drain_sec ?? DEFAULT_DRAIN_SEC,
        reason: `${cfg.resource} restart`,
      },
      async (fence) => {
        if (!enabled) {
          return json({
            ok: true,
            target,
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
          await releaseCooldownOnAbort();
          return json({
            ok: false,
            target,
            restarted: false,
            reason: `stale_fence_${fc.reason}`,
            fence_seq: fence.seq,
            live_fence_seq: fc.live_fence_seq,
            note: `Restart ABORTED — our exclusive(${cfg.resource}) lease was superseded while we held it. Re-acquire before retrying.`,
          });
        }
        // Detached + delayed so this response returns before the service dies.
        const child = spawn('sh', ['-c', `sleep 1; ${restartCmd}`], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return json({
          ok: true,
          target,
          drained: true,
          restarted: true,
          fence_seq: fence.seq,
          note: 'Restart scheduled (~1s) — this connection will drop as the operator restarts.',
        });
      },
    );

    if (outcome.acquired) return outcome.result;
    await releaseCooldownOnAbort();
    return json({
      ok: false,
      target,
      reason: `resource_${outcome.reason}`,
      resource: cfg.resource,
      holders: outcome.holders.map(holderJson),
    });
  },
});
