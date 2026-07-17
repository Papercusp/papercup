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
 *
 * EI-11137 (phantom-coalesce fix): a held cooldown marker is NOT proof a
 * restart happened — it can be held while none did (a withheld/failed restart,
 * or a stale marker perpetually re-observed on a busy fleet), and the old code
 * trusted it blindly, silently wedging EVERY subsequent restart for the TTL.
 * That bit bg-host hardest (it re-bundles the working tree ONLY on restart, so
 * fixes never went live). Before honoring a coalesce we now CROSS-CHECK the
 * service's real last-start via systemd (probeServiceStart): coalesce only when
 * the service genuinely restarted within the window; a phantom marker is
 * refused and a real restart fires. Every real-restart result also surfaces
 * `restartedFromPid` + `verifyWith` so the caller can confirm the PID cycled.
 *
 * EI-13307 (bg-host's REAL cost is ~13min, not ~2min): bg-host was sharing the
 * generic 2-minute GATEWAY_COOLDOWN_SEC used by gateway/embed-sidecar, but its
 * actual restart cost is the ~13-minute cross-machine peer-log/swarm rejoin
 * freeze (EI-13317) — a restart storm from several agents each independently
 * "fixing their own thing" a few minutes apart kept the federation rails down
 * almost continuously for over an hour (LIVE-1 drill, 2026-07-17). bg-host now
 * gets its OWN, much wider cooldown window (BG_HOST_COOLDOWN_SEC, ~13min) —
 * cooldown windows are per-target, not global — and a real (non-coalesced)
 * bg-host restart's result states the rail-freeze cost explicitly so callers
 * understand what they just did. Detecting "peer-log reader still catching
 * up" and refusing/queuing a restart during that window is NOT implemented
 * here — it depends on a health signal EI-13317 doesn't yet expose; that is
 * EI-13317's job, not this tool's.
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { tryAcquireResource, tryReleaseResource, type ResourceHolder } from '../locks/su-lock-store';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { probeServiceStart } from './systemd-service-probe';

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

/**
 * EI-13307: bg-host's REAL restart cost is not the ~10s process bounce that
 * the generic GATEWAY_COOLDOWN_SEC window was tuned for — it's the
 * ~13-minute cross-machine peer-log/swarm rejoin freeze documented in
 * EI-13317 (peer-log gossip does not reliably self-heal after a restart). A
 * 2-minute window let a restart storm from several agents, each ~10min
 * apart, keep re-triggering that freeze for over an hour (LIVE-1 drill,
 * 2026-07-17) because each new restart looked "outside the cooldown" under
 * the old window even though the prior rejoin hadn't finished. Widened to
 * the observed cost so a whole storm across that window coalesces into ONE
 * outage instead of a fresh one per restart.
 */
const BG_HOST_COOLDOWN_SEC = 13 * 60; // 780s

type RestartTarget = 'dev' | 'staging' | 'gateway' | 'bg-host' | 'embed-sidecar';

/**
 * Exported for the registry-parity regression test. A target added here is
 * not operable until its resource (and optional cooldown marker) is seeded by
 * a locks-package migration — WI-4780 was the production miss this prevents.
 */
export const RESTART_TARGETS: Record<RestartTarget, { unit: string; resource: string; cooldownResource?: string; blastRadius: string }> = {
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

/**
 * Per-target cooldown window (EI-10896). Only targets with a cooldownResource
 * coalesce. Windows are per-target, NOT global (EI-13307) — bg-host's is
 * ~13min (its real rejoin cost), everyone else's is the generic ~2min.
 */
const COOLDOWN_SEC: Partial<Record<RestartTarget, number>> = {
  staging: STAGING_COOLDOWN_SEC,
  gateway: GATEWAY_COOLDOWN_SEC,
  'bg-host': BG_HOST_COOLDOWN_SEC,
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
    'Restart a SHARED long-running host, coordinated (drain + coalesce + audit) — the sanctioned alternative to a raw `systemctl restart`. Targets: "dev" (:3070 operator, default) · "staging" (:3170 operator) · "gateway" (inference gateway :8788 — every agent\'s LLM egress) · "bg-host" (routines/git-sync) · "embed-sidecar" (:3384 embeddings). DRY RUN unless confirm:true; the real restart needs PAPERCUSP_ALLOW_DEV_RESTART=1. Every target but "dev" DEBOUNCES (per-target window): ~2min for staging/gateway/embed-sidecar, ~13min for bg-host (its real rejoin cost, EI-13307).',
  guidance: {
    when: 'To LOAD a code edit into a long-running host. KEY: gateway / bg-host / embed-sidecar run tsx STRAIGHT FROM THE STAGING TREE (no build, no deploy) — a RESTART, not the release pipeline, loads your edit; never wait on a deploy for those. Pick by what you edited: inference-gateway/** → "gateway"; routines/git-sync → "bg-host"; embeddings → "embed-sidecar"; operator server-side → "staging" (then probe :3170). Run dry first, then confirm.',
    notWhen: 'Just probing a service — no restart needed. A gateway restart drops in-flight LLM requests for the WHOLE fleet (read gateway:status first). NEVER raw `systemctl --user restart` these units — it bypasses the drain AND the debounce (WI-4221).',
    chaining: 'dev:restart (dry) → review holders → dev:restart { confirm:true, target } → service drops + returns (or coalesced:true — a peer just restarted it; probe directly). Gateway: gateway:status → restart → gateway:status.',
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
    const cfg = RESTART_TARGETS[target];
    const restartCmd = `systemctl --user restart ${cfg.unit}`;
    // EI-13307: per-target, not global — computed up front so both the
    // dry-run note and the real debounce path below quote the SAME window.
    const cooldownSec = COOLDOWN_SEC[target] ?? STAGING_COOLDOWN_SEC;

    // Dry run — ctx-free, takes no lock, drains nobody.
    if (!args.confirm) {
      const cooldownNote = cfg.cooldownResource
        ? ` If a peer restarted this target within the last ~${Math.round(cooldownSec / 60)}min, the restart is coalesced (skipped) instead of re-run.${
            target === 'bg-host'
              ? " bg-host's window is wider than the others: a restart freezes the cross-machine peer-log rails for ~13min while the substrate rejoins (EI-13307/EI-13317), so a fresh restart mid-rejoin would just restart the outage."
              : ''
          }`
        : '';
      return json({
        ok: true,
        dry_run: true,
        target,
        would_run: restartCmd,
        note: `Pass confirm:true to acquire exclusive(${cfg.resource}), drain current users, then restart. DISRUPTS all agents.${cooldownNote} The real restart also requires PAPERCUSP_ALLOW_DEV_RESTART=1.`,
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
    // EI-11137: set when we detect (and refuse to honor) a PHANTOM coalesce —
    // the cooldown marker was held but the service had NOT actually restarted.
    let phantomCoalesceBroken: {
      staleMarkerHolder: string | null;
      serviceSecondsSinceStart: number | null;
      cooldownSec: number;
    } | null = null;
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
        const holderName = holder ? (holder.owner_label ?? holder.owner) : null;
        // EI-11137: the marker alone is NOT proof a restart happened. It can be
        // held while NO real restart occurred (a withheld/failed restart, or a
        // stale marker perpetually re-observed on a busy fleet) — the old code
        // trusted it blindly and returned coalesced:true, silently wedging EVERY
        // subsequent restart for the marker's TTL. bg-host re-bundles the working
        // tree ONLY on restart, so that meant its code fixes never went live.
        // Cross-check the coalesce against the service's REAL last-start.
        const svc = await probeServiceStart(cfg.unit);
        const restartedRecently =
          svc.ok && svc.secondsSinceStart !== undefined && svc.secondsSinceStart <= cooldownSec;
        if (restartedRecently) {
          // GENUINE coalesce — a peer's restart actually landed within the window.
          const ago = Math.round(svc.secondsSinceStart!);
          return json({
            ok: true,
            target,
            restarted: false,
            coalesced: true,
            verified: true,
            restartedSecondsAgo: ago,
            mainPid: svc.mainPid ?? null,
            note: `${cfg.unit} genuinely restarted ~${ago}s ago${
              holderName ? ` (marker held by ${holderName})` : ''
            } — verified via systemd (MainPID ${svc.mainPid}). Skipping a redundant restart; probe it directly.`,
          });
        }
        if (!svc.ok) {
          // Could NOT verify (no systemd / probe failed). Fall back to trusting
          // the marker so we never fire N concurrent outages — but SAY it is
          // unverified so a stale marker is at least visible to the caller.
          return json({
            ok: true,
            target,
            restarted: false,
            coalesced: true,
            verified: false,
            note: `${cfg.unit} appears to have been restarted within the last ~${cooldownSec}s${
              holderName ? ` by ${holderName}` : ' by a peer'
            } — but this could NOT be verified against systemd. Probe it directly; if it is still stale, retry after the cooldown (~${cooldownSec}s) lapses.`,
          });
        }
        // PHANTOM: the marker is held but the service did NOT actually restart
        // within the window (its main process is older than the cooldown, or
        // there is no live main process). This is exactly the wedge EI-11137
        // fixes — do NOT coalesce. Fall through and fire a REAL restart: the
        // stale marker expires on its own TTL, and once our restart lands systemd
        // reflects it so later callers coalesce correctly. We could not acquire
        // the marker (a peer holds it, and tryReleaseResource is owner-scoped so
        // we cannot force-release theirs), so we proceed WITHOUT it — the systemd
        // truth-check above is now the effective debounce.
        phantomCoalesceBroken = {
          staleMarkerHolder: holderName,
          serviceSecondsSinceStart: svc.secondsSinceStart ?? null,
          cooldownSec,
        };
      } else {
        cooldownLockId = cooldown.lock_id;
      }
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
        // EI-11137: capture the pre-restart MainPID so the caller can VERIFY a
        // real cycle happened (the restart is detached+delayed, so we cannot
        // confirm it synchronously — but a changed MainPID proves it landed).
        const before = await probeServiceStart(cfg.unit);
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
          restartedFromPid: before.mainPid ?? null,
          ...(phantomCoalesceBroken ? { phantomCoalesceBroken } : {}),
          verifyWith: `systemctl --user show ${cfg.unit} -p MainPID --value  (expect a NEW pid${
            before.mainPid ? ` ≠ ${before.mainPid}` : ''
          } within ~3s)`,
          note: `Restart scheduled (~1s)${
            phantomCoalesceBroken
              ? ' — this BROKE a phantom coalesce marker (the service had NOT actually restarted despite the marker being held)'
              : ''
          } — this connection will drop as the operator restarts.${
            target === 'bg-host'
              ? ' bg-host restart freezes cross-machine peer-log rails ~13min while the substrate rejoins — see EI-13317.'
              : ''
          }`,
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
