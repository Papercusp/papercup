/**
 * release:deploy — the agent-facing manual deploy lever + gate-unblock diagnosis
 * (release-pipeline-resilience-2026-06-09 P-015 / deploy-trigger-and-gate-unblock-2026-06-21).
 *
 * The gap it closes: deploy is AUTO-on-green only (no manual trigger), and the gate is
 * whole-tree all-or-nothing — so a gate-clean change is hostage to ANY red anywhere, with no
 * sanctioned expedite or escape (2026-06-21 incident: the work-item-ledger change was
 * gate-clean but couldn't reach :3070 for hours behind two UNRELATED reds).
 *
 * Ops (SAFE-by-default; deploy-trigger D-001/D-003):
 *   - status  — READ-ONLY. "What's blocking my deploy?" in one call: gate green/red, stalled/
 *               wedged, release-fixer status, how far the live :3070 is behind the green pin,
 *               and the decision-tree recommendation. Call this FIRST when a change isn't live.
 *   - trigger — expedite a GREEN-but-stalled deploy. Refuses unless there is green code ahead
 *               of the live deploy (it can only ever ship the green pin). Dry-run unless
 *               confirm:true. Audited.
 *   - force   — operator/queen/architect ONLY, loud + audited: deploy an UN-GREEN commit past a
 *               red gate. REQUIRES naming the red tests being accepted (acknowledgeRedTests) +
 *               a reason. The deliberate, rare escape for the no-users testing window — NEVER an
 *               agent's reflex. Prefer fixing the reds; quarantine a confirmed-unrelated red by
 *               hand; force last.
 *
 * The fire-path is a thin wrapper over the EXISTING deploy chokepoint
 * (apps/operator/lib/release/deploy-cli.ts) launched DETACHED — see release-deploy-launch.ts
 * for why (the deploy restarts the very :3070 operator hosting this tool). `quarantine` is
 * deliberately NOT an op here: per owner-confirmed deploy-trigger D-003 the tool wraps
 * deploy-cli (plan/execute/force) with no new gate-correctness logic, and quarantine edits the
 * protected quarantine.txt + must open a de-quarantine follow-up — an accountable by-hand /
 * release-fixer action (release-pipeline-resilience D-003), not a reflexive op. The guidance
 * below teaches fix-reds > quarantine-by-hand > owner-force.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { readDeployStatus, launchDetachedDeploy, type DeployStatus } from '../../release-deploy-launch';
import { fireGitSyncNow } from '../../harness/git-sync/git-sync-action';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

const json = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

/** Append a forensic audit_log row for a manual deploy invocation. Fire-and-forget; never
 *  throws (the deploy already fired) — mirrors flag-audit.ts's canonical full-column shape. */
async function recordDeployAudit(op: string, actor: string, details: Record<string, unknown>): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'release:deploy', op, JSON.stringify(details), activeWorkspaceId()],
    );
  } catch (err) {
     
    console.warn('[release:deploy] audit write failed:', (err as Error)?.message);
  }
}

/** The subset of the status surfaced in tool replies (full status under `status`). */
function statusBrief(s: DeployStatus) {
  return {
    state: s.state,
    gate: { green: s.gate.green, consecutiveReds: s.gate.consecutiveReds, fireStale: s.gate.fireStale },
    deployedBehindGreenPin: s.deploy.deployedBehindReady,
    canTriggerGreen: s.canTriggerGreen,
    recommendation: s.recommendation,
  };
}

export default defineTool({
  name: 'release:deploy',
  profile: 'engineer',
  description:
    'Manually FIRE / TRIGGER / RUN-NOW / deploy-on-demand: the manual lever to push a committed, green change LIVE to :3070 now instead of waiting for the ~half-hourly timer, plus "why isn\'t my change live?" diagnosis. (This is the DEPLOY trigger; git-sync, the auto-commit/push routine, has no fire-now verb.) op:status (read-only — gate red/green/stalled, release-fixer status, how far :3070 is behind the green pin, + a recommendation; call FIRST when a gate-clean change isn\'t live). op:trigger (expedite a GREEN-but-stalled deploy; refuses unless green code is ahead; dry-run unless confirm:true; audited). op:force (operator/queen/architect ONLY, loud+audited: deploy an UN-GREEN commit past a red gate — needs acknowledgeRedTests + reason; rare no-users-window escape). Fired DETACHED.',
  guidance: {
    when:
      'A committed, gate-clean change isn\'t live on :3070 — {op:status} to see why. GREEN-but-stalled → {op:trigger,confirm:true} (safe; only ships the green pin). Gate RED on UNRELATED tests → FIX the reds first (even out of lane).',
    notWhen:
      'Never force as a reflex to "get my change out" — force ships KNOWN-BROKEN code (route-around-the-broken-thing); owner/operator-gated, no-users window only. Prefer fix-reds > quarantine-a-confirmed-unrelated-red-by-hand > owner-force; never silently wait. Threshold tuning → release:checkpoint-config; per-path probe → dev:pipeline_position.',
    chaining:
      'dev:pipeline_position{path} → release:deploy{op:status} → {op:trigger,confirm:true} (green-but-stalled) OR fix the reds.',
    seeAlso: [
      'release:checkpoint-run (re-run the gate verdict before deploying)',
      'dev:pipeline_position (locate your commit in the pipeline first)',
      'release:checkpoint-config (the gate config)',
    ],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // Broad invoke allowlist (status is the read every role reaches for); the WRITE ops self-gate
  // inside the handler (trigger needs confirm; force needs operator-config-write role).
  agentRoles: [...SU_ROLES, 'bee', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('status') }),
    z.object({
      op: z.literal('trigger'),
      confirm: z.boolean().optional().describe('false/absent ⇒ DRY RUN (preview what would deploy). true ⇒ fire the detached green deploy.'),
    }),
    z.object({
      op: z.literal('force'),
      reason: hardText(LIMITS.SHORT_TITLE, { min: 8 }).describe('Why a force (un-green) deploy is justified — loudly audited.'),
      acknowledgeRedTests: z
        .array(z.string().min(1))
        .min(1)
        .describe('The specific red test(s)/failure(s) you are KNOWINGLY shipping past — naming them is required.'),
      commit: z
        .string()
        .regex(/^[0-9a-fA-F]{7,40}$/)
        .optional()
        .describe('The commit sha to ship past the red gate. Omitted ⇒ the current staging HEAD (shown in the dry-run preview).'),
      confirm: z.boolean().optional().describe('false/absent ⇒ DRY RUN. true ⇒ fire the detached force deploy.'),
    }),
  ]),
  async handler(args, ctx) {
    // ── status: read-only, always allowed ──
    if (args.op === 'status') {
      const status = await readDeployStatus();
      return json({ ok: true, op: 'status', ...status });
    }

    const { ownerLabel } = readIdentity(ctx);
    const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
    // Step 0 (WI-1320): a REAL (confirmed) deploy commits the latest staging FIRST via git-sync,
    // so it ships CURRENT work — not a stale tree when git-sync is lagging/wedged (the
    // force-deploy-ships-stale-staging asymmetry). Best-effort (never block the deploy on it),
    // then re-read status because staging HEAD may have advanced (force resolves stagingHeadSha).
    // A dry-run (confirm absent/false) does NOT commit — it only previews.
    let status = await readDeployStatus();
    if ((args as { confirm?: boolean }).confirm === true) {
      // Wrap the WHOLE step (slug resolution + fire + re-read) — it must NEVER fail the deploy.
      try {
        await fireGitSyncNow(operatorHomeHarnessSlug(), activeWorkspaceId());
        const refreshed = await readDeployStatus();
        if (refreshed) status = refreshed;
      } catch (e) {
         
        console.warn('[release:deploy] pre-deploy git-sync fire failed (continuing with current staging):', (e as Error)?.message);
      }
    }

    // ── trigger: expedite a GREEN-but-stalled deploy ──
    if (args.op === 'trigger') {
      if (!status.canTriggerGreen) {
        return json({
          ok: false,
          op: 'trigger',
          refused: true,
          reason:
            status.state === 'gate-red'
              ? 'gate_red — there is no green pin ahead of the live deploy to ship. Fix the reds first (release:deploy{op:status} for detail); trigger can only expedite GREEN code.'
              : status.nothingToDeploy
                ? 'nothing_to_deploy — the live :3070 is already at the green pin.'
                : `not_green_deployable (${status.state}) — ${status.recommendation}`,
          status: statusBrief(status),
        });
      }
      if (!args.confirm) {
        return json({
          ok: true,
          op: 'trigger',
          dry_run: true,
          would_deploy: { greenPinSha: status.deploy.greenPinSha, commitsAhead: status.deploy.deployedBehindReady },
          note: 'Pass confirm:true to fire the detached green deploy (restarts :3070; only ships the green pin). The deploy reports its own outcome (broadcast + pipeline event + release:deployed/deploy-failed events).',
          status: statusBrief(status),
        });
      }
      const launch = await launchDetachedDeploy({});
      await recordDeployAudit('trigger', actor, {
        mode: 'trigger',
        greenPinSha: status.deploy.greenPinSha,
        commitsAhead: status.deploy.deployedBehindReady,
        launched: launch.launched,
        unit: launch.unit,
        reason: launch.reason,
      });
      return json({
        ok: launch.launched,
        op: 'trigger',
        launched: launch.launched,
        unit: launch.unit,
        logPath: launch.logPath,
        ...(launch.reason ? { reason: launch.reason } : {}),
        note: launch.launched
          ? 'Green deploy started (detached). Watch /admin/git or await release:deployed / deploy-failed — this connection survives (the deploy restarts :3070, not this tool).'
          : 'Deploy NOT launched — likely a deploy is already in flight (the manual + auto-serve share one transient unit). Re-check release:deploy{op:status} shortly.',
      });
    }

    // ── force: operator-gated un-green escape ──
    // args.op === 'force'
    if (!isOperatorConfigWriteRole(ctx.role)) {
      return json({
        ok: false,
        op: 'force',
        refused: true,
        reason: `role_forbidden — release:deploy{op:force} requires operator, queen, or architect role (you are role:${ctx.role ?? 'unknown'}). Forcing ships KNOWN-BROKEN code; it is an owner-authorized escape, never an agent's reflex. Prefer fixing the reds.`,
        status: statusBrief(status),
      });
    }
    const commit = args.commit ?? status.deploy.stagingHeadSha ?? undefined;
    if (!commit) {
      return json({
        ok: false,
        op: 'force',
        refused: true,
        reason: 'no_commit — could not resolve the staging HEAD to force-deploy; pass an explicit `commit` sha.',
        status: statusBrief(status),
      });
    }
    if (!args.confirm) {
      return json({
        ok: true,
        op: 'force',
        dry_run: true,
        would_force_deploy: {
          commit,
          acknowledgeRedTests: args.acknowledgeRedTests,
          reason: args.reason,
          currentGate: statusBrief(status),
        },
        warning:
          'FORCE ships an UN-GREEN commit past the gate (KNOWN-BROKEN code). This is the rare no-users-window escape — prefer fixing the reds. Pass confirm:true to fire; the action is loudly audited + notifies the owner.',
      });
    }
    // Fire: loud audit + owner notification BEFORE the detached deploy (which then broadcasts its own outcome).
    await recordDeployAudit('force', actor, {
      mode: 'force',
      commit,
      acknowledgeRedTests: args.acknowledgeRedTests,
      reason: args.reason,
      gateAtForce: statusBrief(status),
    });
    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        importance: 'urgent',
        title: '⚠ FORCE deploy triggered',
        body: `${actor} force-deployed ${commit.slice(0, 12)} past a red gate. Accepting reds: ${args.acknowledgeRedTests.join(', ')}. Reason: ${args.reason}`,
      });
    } catch (err) {
       
      console.warn('[release:deploy] force notifyAttention failed:', (err as Error)?.message);
    }
    const launch = await launchDetachedDeploy({ force: true, commit });
    return json({
      ok: launch.launched,
      op: 'force',
      launched: launch.launched,
      unit: launch.unit,
      commit,
      acknowledgeRedTests: args.acknowledgeRedTests,
      logPath: launch.logPath,
      ...(launch.reason ? { reason: launch.reason } : {}),
      note: launch.launched
        ? 'FORCE deploy started (detached) — audited + owner-notified. Watch /admin/git; the deploy reports its outcome (broadcast + pipeline event).'
        : 'Force deploy NOT launched — likely a deploy is already in flight. Re-check release:deploy{op:status}.',
    });
  },
});
