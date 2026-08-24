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
 *   - `confirm: true` WITHOUT the enablement gate (`PAPERCUSP_ALLOW_DEV_RESTART=1`
 *     or per-call `authorize: true`) → REFUSED outright, before any side effect:
 *     ok:false, reason:'restart_withheld', nothing locked, nothing drained.
 *   - `confirm: true` WITH the gate → acquires + drains, then restarts.
 *
 * EI-18643120769203916: that refusal used to happen INSIDE the drain block, so an
 * un-enabled call acquired the lock, DRAINED every current user, and then reported
 * `ok:true, drained:true, restarted:false`. Two defects: it half-executed (leaving
 * the target quiesced on old code — worse than either doing nothing or restarting),
 * and `ok:true` reads as success, so an agent firing the documented call and
 * checking `ok` concluded the restart had landed. That is the likeliest driver of
 * EI-18642482762875484, where six workers re-learned the bg-host stale-runtime
 * lesson over ~5 days while the restart never actually fired.
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
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { resourceLockDomain } from '../locks/coordination-domain';
import { tryAcquireResource, tryReleaseResource, type ResourceHolder } from '../locks/su-lock-store';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { probeServiceStart } from './systemd-service-probe';
import { RESTART_TARGET_UNITS } from './restart-target-units';
import { preflightRestartTarget } from './restart-preflight';
import { DESKTOP_DEV_RESOURCE, resolveDesktopDevListener, restartDesktopDev } from './desktop-dev-restart';
import { activeWorkspaceId } from '../../workspace-registry';
import { checkGateCollision, isGateSensitiveTarget } from '../../release/gate-collision-guard';

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

type RestartTarget = 'dev' | 'staging' | 'gateway' | 'bg-host' | 'embed-sidecar' | 'mcp-proxy' | 'desktop-dev';

/**
 * Exported for the registry-parity regression test. A target added here is
 * not operable until its resource (and optional cooldown marker) is seeded by
 * a locks-package migration — WI-4780 was the production miss this prevents.
 */
export const RESTART_TARGETS: Record<RestartTarget, { unit: string; resource: string; cooldownResource?: string; blastRadius: string }> = {
  // `unit` comes from RESTART_TARGET_UNITS (systemd-service-probe) so the unit
  // names have ONE definition — read-only callers that need "which unit runs
  // this?" import that map instead of this heavyweight module.
  dev: { unit: RESTART_TARGET_UNITS.dev, resource: 'dev-server', blastRadius: 'the :3070 operator (green release checkout)' },
  staging: {
    unit: RESTART_TARGET_UNITS.staging,
    resource: 'staging-server',
    cooldownResource: 'staging-server-cooldown',
    blastRadius: 'the :3170 staging operator',
  },
  gateway: {
    unit: RESTART_TARGET_UNITS.gateway,
    resource: 'inference-gateway',
    cooldownResource: 'inference-gateway-cooldown',
    blastRadius: 'EVERY agent in the fleet — all LLM egress flows through :8788, so in-flight requests are dropped fleet-wide',
  },
  'bg-host': {
    unit: RESTART_TARGET_UNITS['bg-host'],
    resource: 'bg-host',
    cooldownResource: 'bg-host-cooldown',
    blastRadius: 'the background routines/git-sync/DBOS ticker (an in-flight git-sync commit is interrupted)',
  },
  'embed-sidecar': {
    unit: RESTART_TARGET_UNITS['embed-sidecar'],
    resource: 'embed-sidecar',
    cooldownResource: 'embed-sidecar-cooldown',
    blastRadius: 'the shared embedding sidecar (:3384) — semantic search / memory recall degrade until it is back',
  },
  'mcp-proxy': {
    unit: RESTART_TARGET_UNITS['mcp-proxy'],
    resource: 'mcp-proxy',
    cooldownResource: 'mcp-proxy-cooldown',
    blastRadius: 'the shared MCP proxy (:9071) — Papercusp tool calls fail until it is back',
  },
  'desktop-dev': {
    // This is a wrapper label, not a systemd unit. The target branch below
    // validates and signals the wrapper-owned :3270 listener directly.
    unit: 'desktop-dev-wrapper',
    resource: DESKTOP_DEV_RESOURCE,
    blastRadius: 'the owner-visible :3270 desktop dev operator (the wrapper respawns its listener child)',
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
  'mcp-proxy': GATEWAY_COOLDOWN_SEC,
};

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner, owner_label: h.owner_label, mode: h.mode, status: h.status,
});

/**
 * EI-18198340374286980: this tool's own description has always claimed
 * "coordinated (drain + coalesce + audit)" but never actually wrote an
 * `audit_log` row for a real restart — only the resource-lock holder state
 * (ephemeral) and systemd's own logs recorded that it happened. Fire-and-forget,
 * never throws (mirrors process-kill.ts / flag-audit.ts's canonical
 * full-column shape) — the restart itself must never be blocked on this.
 */
async function writeRestartAudit(
  actor: string,
  details: {
    target: RestartTarget;
    unit: string;
    viaEnv: boolean;
    viaAuthorizeArg: boolean;
    reason: string | null;
    fenceSeq: number;
    phantomCoalesceBroken: boolean;
    /** EI-19385475092979200: what the gate was doing when this restart fired, and
     *  whether the collision guard was deliberately overridden. Recorded so a later
     *  gate red can be ATTRIBUTED to this restart instead of read as a regression. */
    gateCollision?: { kind: string; overridden: boolean; runElapsedSec: number | null } | null;
  },
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'dev:restart', details.target, JSON.stringify(details), activeWorkspaceId()],
    );
  } catch (err) {
    // Best-effort: the restart already fired: never block/fail it on the audit write.

    console.warn('[dev:restart] audit write failed:', (err as Error)?.message);
  }
}

export default defineTool({
  name: 'dev:restart',
  description:
    'Coordinated restart with drain/coalesce/audit. Targets: "dev" :3070 (default), "staging" :3170, "desktop-dev" wrapper :3270, "gateway" :8788, "bg-host" routines/git-sync, "embed-sidecar" :3384, "mcp-proxy" :9071. Dry-run unless confirm:true; restart needs PAPERCUSP_ALLOW_DEV_RESTART=1 or audited authorize:true. Cooldown ~2m; bg-host ~13m.',
  guidance: {
    when: 'Load integration-tree edits into long-running hosts (no deploy). desktop-dev kills only the verified wrapper-owned :3270 listener; its wrapper respawns it. Route: desktop → "desktop-dev"; inference-gateway → "gateway"; routines/git-sync → "bg-host"; embeddings → "embed-sidecar"; MCP proxy/transport → "mcp-proxy"; shared server → "staging" (probe :3170).',
    notWhen: 'Just probing. desktop-dev targets only the :3270 Tauri wrapper, not :3070/:3170. Gateway restarts drop in-flight LLM requests fleet-wide; check gateway:status. ⚠ bg-host kills its whole cgroup (spawner, desktop sidecars, pg_dump); its lock drain cannot reach child processes, so blast radius is systemd-sized (EI-19479764372783341). Never raw systemctl restart these targets; that bypasses drain/debounce (WI-4221). gateway/bg-host/embed-sidecar are refused during green-checkpoint runs; use override_gate_collision:true only when needed.',
    chaining: 'dry → review holders → { confirm:true, authorize:true, reason:"<why>", target } → restart (or coalesced:true; probe directly). Gateway: status → restart → status.',
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
  // EI-18803497769946984: this handler drains, then shells out to systemctl, and never
  // reads ctx.tx — and its own timeoutSec is already well past Postgres's
  // idle_in_transaction_session_timeout (60s), so holding the ambient workspace tx
  // across the wait guarantees the backend is killed and the call fails as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
    target: z.enum(['dev', 'staging', 'gateway', 'bg-host', 'embed-sidecar', 'mcp-proxy', 'desktop-dev']).optional(),
    /** EI-18198340374286980: in-band alternative to the operator-process-env
     *  PAPERCUSP_ALLOW_DEV_RESTART=1 gate, which an agent cannot set for a
     *  server it did not itself spawn. Only takes effect with confirm:true —
     *  confirm+drain is the deliberate-action gate; this only lifts the env
     *  backstop. Every real restart it enables is written to audit_log. */
    authorize: z.boolean().optional(),
    /** EI-19385475092979200: proceed even though a green-checkpoint run is in
     *  flight (or is about to fire). A gate-sensitive restart is SOFT-blocked,
     *  not hard-blocked — a genuinely wedged sidecar mid-run must still be
     *  restartable — but the override has to be deliberate and stated. */
    override_gate_collision: z
      .boolean()
      .optional()
      .describe(
        'Restart a gate-sensitive target (embed-sidecar/gateway/bg-host) even though a green-checkpoint run is in flight or imminent. Only pass when the target is genuinely wedged and cannot wait — a restart mid-run can starve the gate into a FALSE red that gets misdiagnosed as a regression.',
      ),
    /** EI-18661647550414959: restart a target whose tree cannot boot. Only pass when
     *  the restart is itself the remedy — otherwise this hands you the crash-loop the
     *  preflight just predicted. */
    override_boot_integrity: z
      .boolean()
      .optional()
      .describe(
        "Restart even though the target's tree is missing packages it needs to boot. Only when the restart IS the remedy — otherwise it crash-loops the host.",
      ),
    /** Short free-text reason, recorded on the audit_log row when a real
     *  restart fires (either enablement route). Optional but encouraged when
     *  using `authorize` in place of the env gate. */
    reason: z
      .string()
      .max(300)
      .optional()
      .describe(
        'Short free-text reason (MAX 300 chars — keep it to one line; a longer diagnosis belongs on the work-item) recorded on the audit_log row. Expected whenever you pass authorize:true.',
      ),
  }),
  async handler(args, ctx) {
    const target: RestartTarget = args.target ?? 'dev';
    const cfg = RESTART_TARGETS[target];
    // ⚠ This IS a raw `systemctl --user restart` — the coordination this tool adds
    // (drain + coalesce + audit + cooldown) is real, but it is ALL lock-shaped: the
    // drain acquires exclusive(<target>-server), i.e. it drains AGENTS USING the
    // resource. It has no notion of the unit's CGROUP CHILDREN, and KillMode is
    // control-group, so the blast radius here is IDENTICAL to the raw command the
    // docs tell agents to use this instead of. Measured 2026-08-04 on bg-host
    // (EI-19479764372783341): TasksCurrent=208 — 5x desktop sidecar/serve.mjs,
    // 4x spawner-sidecar.ts, any in-flight pg_dump, all killed with the unit.
    // Root cause is on the SPAWN side, not here: managedSpawn confines via
    // `systemd-run --user --scope` (a SIBLING transient unit, survives a restart),
    // but fleet/spawner-sidecar-spawn.ts:194 uses a raw spawn(…,{detached:false})
    // and inherits this cgroup. Do NOT "fix" this by widening the drain — a lock
    // drain cannot reach a child process. Fix the spawn site.
    const restartCmd = target === 'desktop-dev'
      ? 'SIGKILL verified desktop-dev listener on :3270 (wrapper respawns it)'
      : `systemctl --user restart ${cfg.unit}`;
    // EI-13307: per-target, not global — computed up front so both the
    // dry-run note and the real debounce path below quote the SAME window.
    const cooldownSec = COOLDOWN_SEC[target] ?? STAGING_COOLDOWN_SEC;

    // Dry run — ctx-free, takes no lock, drains nobody.
    if (!args.confirm) {
      if (target === 'desktop-dev') {
        // EI-21365722353248238: use the exact same read-only identity resolver
        // as the confirmed path. The old preview emitted a hard-coded
        // "verified" command without checking the listener, so a preview could
        // promise a restart that the immediately-following confirmed call would
        // refuse as desktop_dev_identity_mismatch.
        const listenerPreview = await resolveDesktopDevListener();
        return json({
          ok: true,
          dry_run: true,
          target,
          would_run: listenerPreview.ok ? restartCmd : null,
          listener_identity: {
            checked: true,
            verified: listenerPreview.ok,
            would_block: !listenerPreview.ok,
            ...(listenerPreview.pid === undefined ? {} : { pid: listenerPreview.pid }),
            ...(listenerPreview.reason ? { reason: listenerPreview.reason } : {}),
            note: listenerPreview.note,
          },
          note: `${listenerPreview.ok ? 'Read-only check verified' : 'Read-only check would refuse before draining/signaling'} the owner-visible :3270 listener. Pass confirm:true to acquire exclusive(desktop-dev-server), drain current users, and — only when the identity check passes — SIGKILL that child so the wrapper respawns it. The wrapper and unrelated processes are never signaled. confirm:true alone is not enough — pass authorize:true + a short reason, or set PAPERCUSP_ALLOW_DEV_RESTART=1.`,
        });
      }
      const cooldownNote = cfg.cooldownResource
        ? ` If a peer restarted this target within the last ~${Math.round(cooldownSec / 60)}min, the restart is coalesced (skipped) instead of re-run.${
            target === 'bg-host'
              ? " bg-host's window is wider than the others: a restart freezes the cross-machine peer-log rails for ~13min while the substrate rejoins (EI-13307/EI-13317), so a fresh restart mid-rejoin would just restart the outage."
              : ''
          }`
        : '';
      // EI-19385475092979200: report the gate-collision state in the PREVIEW too. A dry run is
      // where an agent decides whether to act now or wait, so telling it "the gate fires in 40s"
      // here is what prevents the confirm call from being made at all — strictly better than
      // refusing that call afterwards. Read-only; never blocks the dry run.
      const preview = await checkGateCollision(target, args.override_gate_collision === true);
      // EI-18661647550414959: same reasoning as the gate-collision preview above — the dry
      // run is where the decision is actually made, so "this tree cannot boot" belongs HERE,
      // where it costs nothing, not only in the refusal afterwards.
      const bootPreview = await preflightRestartTarget(target);
      return json({
        ok: true,
        dry_run: true,
        target,
        would_run: restartCmd,
        boot_integrity: {
          checked: bootPreview.checked,
          would_block: !bootPreview.ok,
          tree: bootPreview.lockRoot,
          ...(bootPreview.missing.length ? { missing: bootPreview.missing } : {}),
          ...(bootPreview.reason ? { reason: bootPreview.reason } : {}),
        },
        ...(isGateSensitiveTarget(target)
          ? { gate_collision: { kind: preview.kind, would_block: preview.blocked, ...preview.detail } }
          : {}),
        note: `Pass confirm:true to acquire exclusive(${cfg.resource}), drain current users, then restart. DISRUPTS all agents.${cooldownNote} confirm:true ALONE is not enough — the real restart also needs the enablement gate: pass authorize:true + a short \`reason\` (≤300 chars) in the same call, or set PAPERCUSP_ALLOW_DEV_RESTART=1 on the operator process. Without it the call is REFUSED outright (ok:false, nothing drained).${
          preview.blocked ? ` ⚠ ${preview.note}` : ''
        }`,
      });
    }

    const { ownerId, ownerLabel, coordinationDomain: callerDomain } = readIdentity(ctx);
    // EI-18676514870990022: cfg.resource ('dev-server' for the "dev" target)
    // is HOST-GLOBAL — it names the one shared :3070 operator, not a physical
    // file tree — so it must resolve to hostGlobalLockDomain() regardless of
    // which checkout this call happened to load from, exactly like
    // 'release-deploy' (EI-18674647773291145 Defect 2). Every other current
    // target (staging/gateway/bg-host/embed-sidecar) is NOT in
    // HOST_GLOBAL_RESOURCES yet, so this is a no-op for them — falls straight
    // through to the same callerDomain as before.
    const coordinationDomain = resourceLockDomain(cfg.resource);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabledByEnv = process.env.PAPERCUSP_ALLOW_DEV_RESTART === '1';
    // EI-18198340374286980: an agent cannot set PAPERCUSP_ALLOW_DEV_RESTART on
    // the already-running operator process (no per-call env injection, and
    // restarting the operator to add it is circular) — `authorize:true` is the
    // in-band equivalent, gated the same way (capability + confirm + drain)
    // and, unlike the raw-systemctl bypass it replaces, always audited below.
    const enabledByArg = args.authorize === true;
    const enabled = enabledByEnv || enabledByArg;

    // EI-18643120769203916: refuse BEFORE any side effect. This check used to
    // live INSIDE guardResource, so a call without the enablement gate acquired
    // exclusive(<resource>), DRAINED every current user, and then reported
    // `ok:true, drained:true, restarted:false`. Two defects in one:
    //   1. It half-executed — the target was left QUIESCED and still running
    //      old code, an end state strictly worse than either doing nothing or
    //      restarting.
    //   2. `ok:true` reads as success. An agent that fires the documented call
    //      and checks `ok` concludes the restart landed. That is the likeliest
    //      driver of EI-18642482762875484 (six workers re-learned the bg-host
    //      stale-runtime lesson over ~5 days while the restart never fired).
    // A withheld restart is a REFUSAL, not a partial success: no lock, no
    // drain, ok:false.
    if (!enabled) {
      return json({
        ok: false,
        target,
        reason: 'restart_withheld',
        restarted: false,
        drained: false,
        note: `Restart REFUSED — the enablement gate is not set, and NOTHING was done: no lock taken, no drain, ${cfg.unit} left running exactly as it was. To actually restart it, re-call with { confirm: true, authorize: true, reason: '<why, ≤300 chars>' } (audited), or set PAPERCUSP_ALLOW_DEV_RESTART=1 on the operator process.`,
      });
    }

    // EI-18661647550414959: refuse to restart a host whose tree cannot boot. Placed HERE
    // deliberately — after the enablement refusal (cheaper still, and no probe) but BEFORE
    // the gate-collision probe, the cooldown marker and the drain, because this is the one
    // check that must happen while the target is STILL RUNNING. Once the drain starts we
    // have already begun disrupting agents for a restart that would only crash-loop.
    // Refusing here leaves the host up on old-but-working code, which is strictly the best
    // available end state (cf. the EI-18643120769203916 half-execution defect above).
    //
    // Soft block, mirroring override_gate_collision: a genuinely wedged host whose remedy
    // IS the restart must stay restartable via override_boot_integrity. Fails OPEN — an
    // unreadable tree reports checked:false and proceeds, and is NEVER treated as clean.
    const bootIntegrity = target === 'desktop-dev' ? null : await preflightRestartTarget(target);
    if (bootIntegrity && !bootIntegrity.ok && args.override_boot_integrity !== true) {
      return json({
        ok: false,
        target,
        reason: 'boot_integrity_inconsistent',
        restarted: false,
        drained: false,
        boot_integrity: {
          checked: bootIntegrity.checked,
          tree: bootIntegrity.lockRoot,
          missing: bootIntegrity.missing,
          ...(bootIntegrity.reason ? { skipped: bootIntegrity.reason } : {}),
        },
        note:
          `Restart REFUSED — NOTHING was done: no lock taken, no drain, ${cfg.unit} left running exactly as it was ` +
          `on its current (working) code. ${bootIntegrity.note} Restarting now would take ${cfg.unit} down and ` +
          `crash-loop it instead of bringing it back. Fix the tree first, then re-run this call. If the restart is ` +
          `itself the remedy, re-call with override_boot_integrity:true.`,
      });
    }

    // EI-19385475092979200: refuse a gate-sensitive restart while a green-checkpoint run is in
    // flight (or is within the two-sided window around a scheduled fire). Placed HERE
    // deliberately — after the enablement refusal (which is cheaper and needs no probe) and
    // BEFORE the cooldown marker is claimed, so a withheld restart never leaves a cooldown
    // marker held for a restart that did not happen (the EI-11137 phantom-coalesce wedge).
    // Fails OPEN: any probe failure proceeds, saying so. Soft block — `override_gate_collision`
    // is the stated way through, because a genuinely wedged host mid-run must stay restartable.
    const gate = await checkGateCollision(target, args.override_gate_collision === true);
    if (gate.blocked) {
      return json({
        ok: false,
        target,
        reason: `gate_collision_${gate.kind.replace(/-/g, '_')}`,
        restarted: false,
        drained: false,
        gate_collision: { kind: gate.kind, ...gate.detail },
        note: gate.note,
      });
    }

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
        // coordinationDomain is the resourceLockDomain(cfg.resource) computed
        // above (host-global for 'dev-server', unchanged for everything else) —
        // see that declaration's comment for why.
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
        // NOTE: the `!enabled` refusal happens BEFORE this guard is ever entered
        // (EI-18643120769203916) — reaching here means a real restart is
        // authorized, so the drain we just performed is always followed through.
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
        if (target === 'desktop-dev') {
          const desktopRestart = await restartDesktopDev();
          if (!desktopRestart.ok) {
            await releaseCooldownOnAbort();
            return json({
              ok: false,
              target,
              drained: true,
              restarted: false,
              reason: desktopRestart.reason ?? 'desktop_dev_restart_failed',
              ...(desktopRestart.pid === undefined ? {} : { listenerPid: desktopRestart.pid }),
              note: desktopRestart.note,
            });
          }
          void writeRestartAudit(ownerId, {
            target,
            unit: cfg.unit,
            viaEnv: enabledByEnv,
            viaAuthorizeArg: enabledByArg,
            reason: args.reason ?? null,
            fenceSeq: fence.seq,
            phantomCoalesceBroken: false,
            gateCollision: null,
          });
          return json({
            ok: true,
            target,
            drained: true,
            restarted: true,
            listenerPid: desktopRestart.pid,
            fence_seq: fence.seq,
            enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
            audited: true,
            verifyWith: 'dev:listening_ports { port: 3270 } (expect a new owner-visible hono-host listener under dev-operator-ifneeded.sh)',
            note: desktopRestart.note,
          });
        }
        // EI-11137: capture the pre-restart MainPID so the caller can VERIFY a
        // real cycle happened (the restart is detached+delayed, so we cannot
        // confirm it synchronously — but a changed MainPID proves it landed).
        const before = await probeServiceStart(cfg.unit);
        // Audit BEFORE spawning (mirrors process-kill.ts: a record must exist
        // even if signaling crashes the process tree). Fire-and-forget — never
        // blocks the restart.
        void writeRestartAudit(ownerId, {
          target,
          unit: cfg.unit,
          viaEnv: enabledByEnv,
          viaAuthorizeArg: enabledByArg,
          reason: args.reason ?? null,
          fenceSeq: fence.seq,
          phantomCoalesceBroken: phantomCoalesceBroken !== null,
          gateCollision: isGateSensitiveTarget(target)
            ? { kind: gate.kind, overridden: gate.overridden, runElapsedSec: gate.detail.runElapsedSec }
            : null,
        });
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
          enabledVia: enabledByEnv ? 'env' : 'authorize_arg',
          audited: true,
          ...(phantomCoalesceBroken ? { phantomCoalesceBroken } : {}),
          ...(gate.overridden ? { gateCollisionOverridden: { kind: gate.kind, ...gate.detail } } : {}),
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
          }${gate.overridden || gate.kind === 'probe-failed' ? ` ⚠ ${gate.note}` : ''}`,
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
