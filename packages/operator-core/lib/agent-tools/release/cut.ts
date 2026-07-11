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
 *   - preflight — READ-ONLY go/no-go: signing key, cutter + verify scripts present, no cut
 *                 already in flight, VM reminders for requested mac/windows legs.
 *   - run       — fire the LOCAL cut DETACHED (survives compaction/relaunch). Dry-run
 *                 unless confirm:true. Heavy + owner-walled → operator-config-write role.
 *                 Audited. Refuses if a cut is already in flight.
 *   - status    — READ-ONLY: is a cut in flight? / its exit code + log tail once done.
 *   - handoff   — collect the version's signed artifacts + sha256 + manifests/provenance
 *                 for the owner; flags any unsigned artifact (a ship blocker).
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
  type Channel,
  type CutLegs,
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
    "CUT a LOCAL Papercusp desktop release — build + sign the installer(s) on this box for the owner to upload (⛔ LOCAL-only: never pushes a tag / creates a GitHub Release; owner directive 2026-07-08). The orchestrator over bin/release-local.sh + the RELEASE-RUNBOOK verify recipes. op:preflight (READ-ONLY go/no-go — signing key, scripts present, no cut in flight; call FIRST). op:run (fire the cut DETACHED — a 35–60 min tri-platform build survives compaction/relaunch; dry-run unless confirm:true; operator/mug/architect role; audited). op:status (poll an in-flight cut / its exit code + log tail). op:handoff (collect the version's signed artifacts + sha256 + latest.json/build-provenance for the owner; flags unsigned artifacts). Optional legs: mac (VM :2222), windows (VM :2223), arm64.",
  guidance: {
    when:
      'Cutting a new desktop release for the owner to upload. release:cut{op:preflight} → {op:run,version,channel,confirm:true} → poll {op:status} until done → run the RELEASE-RUNBOOK ship-gate (recipes:run release-verify-provenance) → {op:handoff,version} and give the owner the local paths + sha256.',
    notWhen:
      "Not for deploying the WEB operator to :3070 — that's release:deploy. Not for the green-checkpoint verdict — that's release:checkpoint-run. NEVER publish a cut to GitHub (LOCAL-only, owner directive). To verify a cut before hand-off use the recipes, not this tool.",
    chaining:
      'release:cut{op:preflight} → {op:run,confirm:true} → {op:status} (poll) → recipes:run{id:release-verify-provenance} → release:cut{op:handoff,version}.',
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
    z.object({ op: z.literal('status') }),
    z.object({
      op: z.literal('handoff'),
      version: z.string().min(1).describe('The version whose cut artifacts to collect for the owner.'),
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

    // ── status: read-only poll ──
    if (args.op === 'status') {
      const status = readCutStatus();
      const note =
        status.state === 'running'
          ? `A cut is in flight (unit ${CUT_UNIT}). Poll again; the log tail is above. Do NOT start a second cut.`
          : status.state === 'done'
            ? 'The last cut finished OK. Verify it (recipes:run release-verify-provenance), then release:cut{op:handoff,version} to collect the artifacts for the owner.'
            : status.state === 'failed'
              ? `The last cut FAILED (exit ${status.exitCode}). Inspect the log tail above / ${status.logPath}; fix and re-run.`
              : 'No cut in flight and no recent result on this host.';
      return json({ ok: true, op: 'status', ...status, note });
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
