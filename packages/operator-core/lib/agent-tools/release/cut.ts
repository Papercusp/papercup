/**
 * release:cut — the agent-facing LOCAL desktop-release cutter + hand-off orchestrator
 * (desktop-update-center-and-release-tooling P-5 Unit B).
 *
 * The orchestrator layer over the build-agents' primitives (their D-001): it composes
 * `papercusp-desktop/bin/release-local.sh` (the build/sign/provenance cut) and points at
 * the RELEASE-RUNBOOK verify recipes (release-verify-provenance / release-vm-preflight /
 * release-install-and-relaunch-verify) as the ship-gate sequence. It gives the cut what
 * `release:deploy` gives the deploy: a preflight go/no-go, a DETACHED launch (a 35–60 min
 * build can't be an awaited tool call), status polling, and a structured hand-off.
 *
 * ⛔ LOCAL-only (papercusp-desktop/RELEASE-RUNBOOK.md; owner directive 2026-07-08: "we are
 * no longer using GitHub for our releases — build the installer locally and I'll upload
 * it"). Every path here runs the cut with PAPERCUSP_PUBLISH_GITHUB=0 (release-local.sh
 * skips its superseded tag-push + GitHub-Release steps) and `handoff` returns the local
 * artifact paths + sha256 for the OWNER to upload. This tool never pushes a tag, never
 * creates a GitHub Release.
 *
 * Ops (discriminated on `op`):
 *   - preflight  — READ-ONLY go/no-go: signing key, cutter + verify scripts present, no cut
 *                  already in flight, VM reminders for requested mac/windows legs.
 *   - run        — fire the LOCAL cut DETACHED (survives compaction/relaunch). Dry-run
 *                  unless confirm:true. Heavy + owner-walled → operator-config-write role.
 *                  Audited. Refuses if a cut is already in flight.
 *   - status     — READ-ONLY: is a cut in flight? / its exit code + log tail once done.
 *                  Pass `platform` to poll ONE leg's own unit (see run-leg) instead of the
 *                  legacy whole-cut unit.
 *   - handoff    — collect the version's signed artifacts + sha256 + manifests/provenance
 *                  for the owner; flags any unsigned artifact (a ship blocker). Leg-
 *                  agnostic — collects across every platform's output under one shared
 *                  target tree regardless of whether it came from op:run or N op:run-legs.
 *   - run-leg    — WI-4233 fleet-split support: fire ONE platform leg (linux/mac/windows/
 *                  arm64) on its OWN detached unit/log/done, so N agents can each drive +
 *                  poll their own leg through this audited orchestrator instead of raw
 *                  bash. Same dry-run/confirm/role-gate/audit contract as op:run.
 *   - abort-leg  — stop one platform leg's unit (best-effort). Same role gate as run.
 *   - gate-status — READ (or, for the first caller, ESTABLISH) the shared BUILD_SHA gate
 *                  for a (version, channel): the single honest sha every leg/agent on this
 *                  box should be cutting against, so independent legs can't silently drift
 *                  onto different shas if the tree moves (git-sync) between their runs.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  launchDetachedCut,
  readCutStatus,
  collectHandoff,
  preflightCut,
  buildCutArgv,
  desktopRoot,
  isValidVersion,
  CHANNELS,
  CUT_UNIT,
  PLATFORMS,
  cutUnitFor,
  cutLogFor,
  cutDoneFor,
  legsForPlatform,
  abortLeg,
  readOrCreateGate,
  type Channel,
  type CutLegs,
  type Platform,
} from '../../release-cut-launch';

const json = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

/** Append a forensic audit_log row for a cut invocation. Fire-and-forget; never throws
 *  (mirrors release:deploy's recordDeployAudit — the canonical full-column shape). */
async function recordCutAudit(op: string, actor: string, details: Record<string, unknown>): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `relcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actor, 'release:cut', op, JSON.stringify(details), activeWorkspaceId()],
    );
  } catch (err) {

    console.warn('[release:cut] audit write failed:', (err as Error)?.message);
  }
}

const legsFrom = (a: { mac?: boolean; windows?: boolean; arm64?: boolean }): CutLegs => ({
  mac: a.mac,
  windows: a.windows,
  arm64: a.arm64,
});

export default defineTool({
  name: 'release:cut',
  profile: 'engineer',
  description:
    "CUT a LOCAL Papercusp desktop release — build + sign the installer(s) on this box for the owner to upload (⛔ LOCAL-only: never pushes a tag / creates a GitHub Release; owner directive 2026-07-08). The orchestrator over bin/release-local.sh + the RELEASE-RUNBOOK verify recipes. op:preflight (READ-ONLY go/no-go — signing key, scripts present, no cut in flight; call FIRST). op:run (fire the WHOLE cut DETACHED — a 35–60 min tri-platform build survives compaction/relaunch; dry-run unless confirm:true; operator/mug/architect role; audited). op:run-leg (fire ONE platform leg — linux/mac/windows/arm64 — on its own unit, for a fleet-split cut where N agents each drive+poll their own leg; same dry-run/confirm/role/audit contract). op:abort-leg (stop one leg's unit). op:status (poll an in-flight cut / its exit code + log tail; pass `platform` for a per-leg poll). op:gate-status (read, or as first-caller establish, the shared BUILD_SHA gate for a version+channel so independent legs can't drift onto different shas). op:handoff (collect the version's signed artifacts + sha256 + latest.json/build-provenance for the owner — leg-agnostic, collects across every platform's output; flags unsigned artifacts). Optional legs: mac (VM :2222), windows (VM :2223), arm64.",
  guidance: {
    when:
      "Cutting a new desktop release for the owner to upload. Single-agent: release:cut{op:preflight} → {op:run,version,channel,confirm:true} → poll {op:status} until done → run the RELEASE-RUNBOOK ship-gate (recipes:run release-verify-provenance) → {op:handoff,version}. Fleet-split (one agent per platform leg): each agent {op:gate-status,version,channel} first (agree on ONE buildSha) → {op:run-leg,platform,version,channel,confirm:true} → poll {op:status,platform} → once EVERY leg is done, any agent runs the ship-gate + {op:handoff,version} (collects across all legs).",
    notWhen:
      "Not for deploying the WEB operator to :3070 — that's release:deploy. Not for the green-checkpoint verdict — that's release:checkpoint-run. NEVER publish a cut to GitHub (LOCAL-only, owner directive). To verify a cut before hand-off use the recipes, not this tool.",
    chaining:
      'Whole cut: release:cut{op:preflight} → {op:run,confirm:true} → {op:status} (poll) → recipes:run{id:release-verify-provenance} → release:cut{op:handoff,version}. Fleet-split: {op:gate-status} (per agent) → {op:run-leg,confirm:true} (per agent, own platform) → {op:status,platform} (poll, per agent) → {op:handoff,version} (once all legs done).',
    seeAlso: [
      'recipes:run release-verify-provenance / release-vm-preflight / release-install-and-relaunch-verify (the RELEASE-RUNBOOK ship-gate this cut composes)',
      'release:deploy (deploy the WEB operator to :3070 — a different target)',
      'release:checkpoint-run (the green-checkpoint verdict producer)',
    ],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // Broad allowlist (preflight/status/handoff are read-only reaches); the WRITE op (run)
  // self-gates on the operator-config-write role inside the handler — cutting a real build
  // is heavy + owner-walled, mirroring release:deploy{op:force}.
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 10 } },
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('preflight'),
      mac: z.boolean().optional().describe('Include the macOS leg (build VM on SSH :2222).'),
      windows: z.boolean().optional().describe('Include the Windows leg (build VM on SSH :2223).'),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
    }),
    z.object({
      op: z.literal('run'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      mac: z.boolean().optional().describe('Include the macOS leg (build VM on SSH :2222).'),
      windows: z.boolean().optional().describe('Include the Windows leg (build VM on SSH :2223).'),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN (preview the exact command). true ⇒ fire the detached LOCAL cut.'),
    }),
    z.object({
      op: z.literal('status'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).optional().describe('Poll ONE leg (WI-4233) instead of the legacy whole-cut unit.'),
    }),
    z.object({
      op: z.literal('handoff'),
      version: z.string().min(1).describe('The version whose cut artifacts to collect for the owner.'),
    }),
    z.object({
      op: z.literal('run-leg'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).describe('Which platform leg to fire on its own unit.'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN (preview the exact command). true ⇒ fire the detached LOCAL leg.'),
    }),
    z.object({
      op: z.literal('abort-leg'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).describe('Which platform leg to stop.'),
    }),
    z.object({
      op: z.literal('gate-status'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease).'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
    }),
  ]),
  async handler(args, ctx) {
    // ── preflight: read-only go/no-go ──
    if (args.op === 'preflight') {
      const result = preflightCut(legsFrom(args));
      return json({
        ok: true,
        op: 'preflight',
        ...result,
        note: result.go
          ? "Ready to cut. release:cut{op:run,version,channel,confirm:true} fires it detached. LOCAL-only — hand the owner the artifacts (op:handoff), never publish to GitHub."
          : `Not ready — resolve the blocker(s) first: ${result.blockers.join('; ')}`,
      });
    }

    // ── status: read-only poll (whole-cut, or one leg with `platform`) ──
    if (args.op === 'status') {
      const status = readCutStatus({ platform: args.platform });
      const unit = cutUnitFor(args.platform);
      const legNote = args.platform ? `leg '${args.platform}' (unit ${unit})` : `unit ${unit}`;
      const note =
        status.state === 'running'
          ? `A cut is in flight (${legNote}). Poll again; the log tail is above. Do NOT start a second cut${args.platform ? ' for this leg' : ''}.`
          : status.state === 'done'
            ? `The last ${legNote} finished OK. ${args.platform ? "Once every leg is done, verify (recipes:run release-verify-provenance) then release:cut{op:handoff,version}." : 'Verify it (recipes:run release-verify-provenance), then release:cut{op:handoff,version} to collect the artifacts for the owner.'}`
            : status.state === 'failed'
              ? `The last ${legNote} FAILED (exit ${status.exitCode}). Inspect the log tail above / ${status.logPath}; fix and re-run.`
              : `No cut in flight and no recent result for ${legNote} on this host.`;
      return json({ ok: true, op: 'status', ...(args.platform ? { platform: args.platform } : {}), ...status, note });
    }

    // ── handoff: collect the LOCAL deliverable ──
    if (args.op === 'handoff') {
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'handoff',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix.`,
        });
      }
      const h = collectHandoff(args.version);
      if (!h.found) {
        return json({
          ok: false,
          op: 'handoff',
          found: false,
          version: args.version,
          targetRoot: h.targetRoot,
          reason: `no ${args.version} artifacts under ${h.targetRoot} — cut it first (release:cut{op:run}) or check the version.`,
        });
      }
      return json({
        ok: true,
        op: 'handoff',
        ...h,
        shipGate:
          h.unsignedNames.length > 0
            ? `⚠ ${h.unsignedNames.length} artifact(s) are UNSIGNED (${h.unsignedNames.join(', ')}) — the updater can't verify them. Do NOT hand these over; re-cut with the signing key present.`
            : 'All artifacts are signed. Run the ship-gate (recipes:run release-verify-provenance) before hand-off.',
        note: 'LOCAL-only hand-off: give the OWNER these local paths + sha256 to upload. Never publish to GitHub.',
      });
    }

    // ── gate-status: read, or (first caller) establish, the shared BUILD_SHA gate ──
    if (args.op === 'gate-status') {
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'gate-status',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix.`,
        });
      }
      const { ownerLabel } = readIdentity(ctx);
      const { gate, created } = readOrCreateGate(args.version, args.channel as Channel, ownerLabel);
      return json({
        ok: true,
        op: 'gate-status',
        created,
        ...gate,
        note: created
          ? `Gate established: buildSha=${gate.buildSha}${gate.dirty ? ' (DIRTY — the -dirty guard will refuse a leg unless PAPERCUSP_ALLOW_DIRTY=1)' : ''}. Every peer's op:gate-status for ${args.version}/${args.channel} now reads back this SAME sha — pass it to your fleet so every leg cuts against it.`
          : `Existing gate (derived by ${gate.derivedBy} at ${gate.derivedAt}) — buildSha=${gate.buildSha}. If YOUR leg's own release-local.sh run reports a DIFFERENT sha, STOP: the tree moved between legs (git-sync) — do not mix artifacts from different shas into one hand-off.`,
      });
    }

    // ── abort-leg: stop one platform leg's unit (operator-gated) ──
    if (args.op === 'abort-leg') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'abort-leg',
          refused: true,
          reason: `role_forbidden — release:cut{op:abort-leg} requires operator, mug, or architect role (you are role:${ctx.role ?? 'unknown'}).`,
        });
      }
      const platform = args.platform as Platform;
      const result = abortLeg(platform);
      const { ownerLabel } = readIdentity(ctx);
      await recordCutAudit('abort-leg', `${ownerLabel} (role:${ctx.role ?? 'unknown'})`, { platform, ...result });
      return json({
        ok: result.stopped,
        op: 'abort-leg',
        platform,
        ...result,
        note: result.stopped
          ? `Stop requested for the ${platform} leg (unit ${result.unit}). Its log/done files (${cutLogFor(platform)} / ${cutDoneFor(platform)}) are left for post-mortem — the next op:run-leg for this platform clears the done sentinel itself.`
          : `Stop failed (${result.reason ?? 'unknown'}) — the unit may already be inactive; check release:cut{op:status,platform:'${platform}'}.`,
      });
    }

    // ── run-leg: fire ONE platform leg detached (operator-gated write, WI-4233) ──
    if (args.op === 'run-leg') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `role_forbidden — release:cut{op:run-leg} requires operator, mug, or architect role (you are role:${ctx.role ?? 'unknown'}). Cutting a real build is heavy + owner-walled. preflight/status/handoff/gate-status are open.`,
        });
      }
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).`,
        });
      }
      const channel = args.channel as Channel;
      const platform = args.platform as Platform;
      const legs = legsForPlatform(platform);

      const pre = preflightCut(legs, { platform });
      const inFlight = pre.checks.find((c) => c.name === 'no-cut-in-flight');
      if (inFlight && !inFlight.ok) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `cut_in_flight — ${inFlight.detail}`,
        });
      }

      if (!args.confirm) {
        const argv = buildCutArgv(desktopRoot(), args.version, channel, legs, '<PATH>', platform);
        return json({
          ok: true,
          op: 'run-leg',
          dry_run: true,
          platform,
          version: args.version,
          channel,
          legs,
          localOnly: true,
          unit: cutUnitFor(platform),
          preflight: { go: pre.go, blockers: pre.blockers },
          wouldRun: `systemd-run ${argv.join(' ')}`,
          note: pre.go
            ? `Pass confirm:true to fire the detached LOCAL ${platform} leg (unit ${cutUnitFor(platform)}). Then poll release:cut{op:status,platform:'${platform}'}.`
            : `⚠ preflight is NOT green for this leg — resolve first: ${pre.blockers.join('; ')}. confirm:true would fire anyway.`,
        });
      }

      const { ownerLabel } = readIdentity(ctx);
      const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
      const launch = await launchDetachedCut({ version: args.version, channel, legs, platform });
      await recordCutAudit('run-leg', actor, {
        platform,
        version: args.version,
        channel,
        legs,
        localOnly: true,
        launched: launch.launched,
        unit: launch.unit,
        ...(launch.reason ? { reason: launch.reason } : {}),
      });
      return json({
        ok: launch.launched,
        op: 'run-leg',
        platform,
        launched: launch.launched,
        version: args.version,
        channel,
        legs,
        localOnly: true,
        unit: launch.unit,
        logPath: launch.logPath,
        ...(launch.reason ? { reason: launch.reason } : {}),
        note: launch.launched
          ? `LOCAL ${platform} leg started (detached). Poll release:cut{op:status,platform:'${platform}'}. Once EVERY leg is done: recipes:run release-verify-provenance → release:cut{op:handoff,version} (handoff already collects across every leg's artifacts under the shared target tree).`
          : `Leg NOT launched — likely already in flight (see reason). Re-check release:cut{op:status,platform:'${platform}'}.`,
      });
    }

    // ── run: fire the detached LOCAL cut (operator-gated write) ──
    // args.op === 'run'
    if (!isOperatorConfigWriteRole(ctx.role)) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `role_forbidden — release:cut{op:run} requires operator, mug, or architect role (you are role:${ctx.role ?? 'unknown'}). Cutting a real build is heavy + owner-walled. preflight/status/handoff are open.`,
      });
    }
    if (!isValidVersion(args.version)) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).`,
      });
    }
    const channel = args.channel as Channel;
    const legs = legsFrom(args);

    // Refuse to start a second cut over an in-flight one (structured, so the caller waits).
    const pre = preflightCut(legs);
    const inFlight = pre.checks.find((c) => c.name === 'no-cut-in-flight');
    if (inFlight && !inFlight.ok) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `cut_in_flight — ${inFlight.detail}`,
      });
    }

    if (!args.confirm) {
      const argv = buildCutArgv(desktopRoot(), args.version, channel, legs, '<PATH>');
      return json({
        ok: true,
        op: 'run',
        dry_run: true,
        version: args.version,
        channel,
        legs,
        localOnly: true,
        preflight: { go: pre.go, blockers: pre.blockers },
        wouldRun: `systemd-run ${argv.join(' ')}`,
        note: pre.go
          ? 'Pass confirm:true to fire the detached LOCAL cut (PAPERCUSP_PUBLISH_GITHUB=0 — no GitHub publish). Then poll release:cut{op:status}. ~35–60 min for a tri-platform cut.'
          : `⚠ preflight is NOT green — resolve first: ${pre.blockers.join('; ')}. confirm:true would fire anyway.`,
      });
    }

    const { ownerLabel } = readIdentity(ctx);
    const actor = `${ownerLabel} (role:${ctx.role ?? 'unknown'})`;
    const launch = await launchDetachedCut({ version: args.version, channel, legs });
    await recordCutAudit('run', actor, {
      version: args.version,
      channel,
      legs,
      localOnly: true,
      launched: launch.launched,
      unit: launch.unit,
      ...(launch.reason ? { reason: launch.reason } : {}),
    });
    return json({
      ok: launch.launched,
      op: 'run',
      launched: launch.launched,
      version: args.version,
      channel,
      legs,
      localOnly: true,
      unit: launch.unit,
      logPath: launch.logPath,
      ...(launch.reason ? { reason: launch.reason } : {}),
      note: launch.launched
        ? 'LOCAL cut started (detached, ~35–60 min). Poll release:cut{op:status}; this connection is not tied to the build. When done: recipes:run release-verify-provenance → release:cut{op:handoff,version}.'
        : 'Cut NOT launched — likely a cut is already in flight (see reason). Re-check release:cut{op:status}.',
    });
  },
});
