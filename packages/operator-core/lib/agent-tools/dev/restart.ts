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

/**
 * EI-10896: the SHARED long-running hosts beyond the operator. Every one of these executes source
 * straight from the STAGING tree (tsx, no build step), so an edit to their code is on their disk
 * IMMEDIATELY but is NOT loaded until the process restarts — no deploy is involved at all. Before
 * this, none of them had a sanctioned restart path: the target enum was ['dev','staging'], so the
 * ONLY way to land a gateway fix was the exact raw `systemctl --user restart` this tool's own
 * guidance forbids. A rule you can only obey by not doing your job gets broken — so the rule now
 * has a tool behind it.
 *
 * The GATEWAY is the most shared process in the system (every agent's LLM egress flows through it),
 * which makes coalescing matter MORE here than for :3170, not less: N agents each landing a gateway
 * fix would otherwise mean N fleet-wide outages. It gets a cooldown marker for exactly that reason.
 */
const GATEWAY_COOLDOWN_SEC = 120;

type RestartTarget = 'dev' | 'staging' | 'gateway' | 'bg-host' | 'embed-sidecar';

const TARGETS: Record<RestartTarget, { unit: string; resource: string; cooldownResource?: string; blastRadius: string }> = {
  dev: { unit: 'papercup-dev-api.service', resource: 'dev-server', blastRadius: 'the :3070 operator (green release checkout)' },
  staging: {
    unit: 'papercup-staging-api.service',
    resource: 'staging-server',
    cooldownResource: 'staging-server-cooldown',
    blastRadius: 'the :3170 staging operator',
  },
  gateway: {
    unit: 'papercup-inference-gateway.service',
    resource: 'inference-gateway',
    cooldownResource: 'inference-gateway-cooldown',
    blastRadius: 'EVERY agent in the fleet — all LLM egress flows through :8788, so in-flight requests are dropped fleet-wide',
  },
  'bg-host': {
    unit: 'papercup-bg-host.service',
    resource: 'bg-host',
    cooldownResource: 'bg-host-cooldown',
    blastRadius: 'the background routines/git-sync/DBOS ticker (an in-flight git-sync commit is interrupted)',
  },
  'embed-sidecar': {
    unit: 'papercup-embed-sidecar.service',
    resource: 'embed-sidecar',
    cooldownResource: 'embed-sidecar-cooldown',
    blastRadius: 'the shared embedding sidecar (:3384) — semantic search / memory recall degrade until it is back',
  },
};

/** Per-target cooldown window (EI-10896). Only targets with a cooldownResource coalesce. */
const COOLDOWN_SEC: Partial<Record<RestartTarget, number>> = {
  staging: STAGING_COOLDOWN_SEC,
  gateway: GATEWAY_COOLDOWN_SEC,
  'bg-host': GATEWAY_COOLDOWN_SEC,
  'embed-sidecar': GATEWAY_COOLDOWN_SEC,
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
    'Restart a SHARED long-running host, coordinated (drain + coalesce + audit) — the sanctioned alternative to a raw `systemctl restart`. Targets: "dev" (the :3070 operator, default) · "staging" (the :3170 operator) · "gateway" (the inference gateway on :8788 — EVERY agent\'s LLM egress) · "bg-host" (routines/git-sync ticker) · "embed-sidecar" (:3384 embeddings). DRY RUN unless confirm:true. With confirm: acquires exclusive(<resource>), drains current users (wait:{max_drain_sec}), restarts, then releases (broadcasts "back up"). Every target except "dev" also DEBOUNCES (WI-4221/EI-10896): a restart requested within ~2min of a peer\'s real restart of the SAME target is coalesced (reported coalesced:true, not re-run) instead of firing a redundant outage — this matters MOST for the gateway, where N agents landing N fixes would otherwise mean N fleet-wide outages. The real restart requires PAPERCUSP_ALLOW_DEV_RESTART=1 on the host. WHEN IS A RESTART EVEN THE RIGHT MOVE? The gateway / bg-host / embed-sidecar run tsx STRAIGHT FROM THE STAGING TREE (no build, no deploy), so your edit is already on their disk and a RESTART — not a deploy — is what loads it. Do NOT wait on the release pipeline for those.',
  guidance: {
    when: 'To LOAD a code edit into a long-running host: target:"staging" for the :3170 operator (CLAUDE.md\'s "test a server-side edit live" workflow), target:"gateway" for an inference-gateway edit (packages/operator-core/lib/inference-gateway/**, libs/papercusp-shared/src/resilience/** — it runs tsx from the staging tree, so a restart is the ONLY way to load your change; no deploy is involved), target:"bg-host" for a routines/git-sync edit, target:"embed-sidecar" for an embeddings edit, target:"dev" for the :3070 operator. Run dry first to see who is using it; then confirm to drain + restart.',
    notWhen: 'Just probing the server — that needs no restart. Never restart casually on a shared box; it disrupts every agent using it (a gateway restart drops in-flight LLM requests for the WHOLE fleet — prefer a low-load moment and check gateway:status first). NEVER shell out to a raw `systemctl --user restart` for ANY of these units — it bypasses the drain AND the debounce, which is exactly the uncoordinated-churn defect (WI-4221) this tool exists to fix; EI-10896 added the non-operator targets precisely so that rule is followable.',
    chaining: 'dev:restart (dry) → review holders → dev:restart { confirm: true, max_drain_sec, target } → the service drops + comes back (or, within the cooldown window, a coalesced:true no-op — a peer already restarted it, so just probe directly). For the gateway: gateway:status (confirm in-flight is low) → dev:restart { target:"gateway", confirm:true } → gateway:status (confirm it is back and the admission state looks right).',
    seeAlso: [
      'dev:service_health (check what is down first)',
      'gateway:status (in-flight/admission state — read BEFORE and AFTER a gateway restart)',
      'dev:pipeline_position (is my edit live? — tells you whether a restart or a deploy is what you need)',
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
    target: z.enum(['dev', 'staging', 'gateway', 'bg-host', 'embed-sidecar']).optional(),
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
    const cooldownSec = COOLDOWN_SEC[target] ?? STAGING_COOLDOWN_SEC;
    if (enabled && cfg.cooldownResource) {
      const cd = cfg.cooldownResource;
      const cooldown = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryAcquireResource(tx, {
          coordinationDomain,
          resource: cd,
          mode: 'exclusive',
          owner: ownerId,
          ownerLabel,
          reason: `${target} restart cooldown (WI-4221 / EI-10896)`,
          ttlSec: cooldownSec,
        }),
      );
      if (!cooldown.ok) {
        const holder = cooldown.holders.find((h) => h.mode === 'exclusive');
        return json({
          ok: true,
          target,
          restarted: false,
          coalesced: true,
          note: `${cfg.unit} was restarted within the last ~${cooldownSec}s${
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
