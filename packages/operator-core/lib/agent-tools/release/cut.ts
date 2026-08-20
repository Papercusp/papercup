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
 * ⛔ Artifact cuts are LOCAL-only (papercusp-desktop/RELEASE-RUNBOOK.md; owner directive 2026-07-08: "we are
 * no longer using GitHub for our releases — build the installer locally and I'll upload
 * it"). Every path here runs the cut with PAPERCUSP_PUBLISH_GITHUB=0 (release-local.sh
 * skips its superseded tag-push + GitHub-Release steps) and `handoff` returns the local
 * artifact paths + sha256 for the OWNER to upload. `prepare-tag` is the one explicit,
 * separately confirmed remote-ref write: it creates a missing exact tag with a
 * force-with-lease expecting absence. It never creates a GitHub Release or uploads bytes.
 *
 * Ops (discriminated on `op`):
 *   - preflight  — READ-ONLY go/no-go: signing key, cutter + verify scripts present, no cut
 *                  already in flight, VM reminders for requested mac/windows legs.
 *   - prepare-tag — explicitly create the exact release tag required by the dogfood pin.
 *                  Dry-run unless confirm:true; refuses to overwrite an existing mismatch.
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
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readIdentity } from '../locks/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadHarnessRegistry, type HarnessRegistry } from '../../harness-registry';
import {
  launchDetachedCut,
  readCutStatus,
  collectHandoff,
  preflightCut,
  buildCutArgv,
  desktopRoot,
  isValidVersion,
  isValidSourceSha,
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

const cutRootArg = z
  .string()
  .min(1)
  .describe(
    'Optional registered, clean Git worktree selector. Accepts a registered project slug, the linked worktree path, or that worktree\'s papercusp-desktop path.',
  );

interface CutWorktree {
  path: string;
  prunable: boolean;
}

export interface CutRootSelection {
  desktopRoot: string;
  selector?: string;
  worktreeRoot?: string;
}

export type CutRootResolution =
  | ({ ok: true } & CutRootSelection)
  | { ok: false; reason: string };

export interface CutRootResolutionDeps {
  loadRegistry?: (workspaceId: string) => Promise<HarnessRegistry>;
  listWorktrees?: (repoPath: string) => CutWorktree[];
  status?: (worktreePath: string) => string;
  canonicalPath?: (candidate: string) => string;
}

function parseWorktreeList(stdout: string): CutWorktree[] {
  return stdout
    .split(/\n\n+/)
    .map((block) => {
      let worktreePath = '';
      let prunable = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length).trim();
        if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      }
      return { path: worktreePath, prunable };
    })
    .filter((worktree) => worktree.path.length > 0);
}

function defaultListWorktrees(repoPath: string): CutWorktree[] {
  const stdout = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return parseWorktreeList(String(stdout));
}

function defaultWorktreeStatus(worktreePath: string): string {
  return String(
    execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    }),
  );
}

function defaultCanonicalPath(candidate: string): string {
  return path.resolve(candidate);
}

/**
 * Resolve the optional cut root without allowing an arbitrary filesystem path.
 * Explicit selectors must identify a non-prunable linked worktree belonging to a
 * project in the active harness registry, and that worktree must be clean at the
 * moment of the read. The cutter itself receives the worktree's desktop subdir.
 */
export async function resolveCutRoot(
  selector: string | undefined,
  deps: CutRootResolutionDeps = {},
): Promise<CutRootResolution> {
  if (selector === undefined) return { ok: true, desktopRoot: desktopRoot() };
  const requested = selector.trim();
  if (!requested) return { ok: false, reason: 'bad_root — selector must not be blank' };

  const loadRegistry = deps.loadRegistry ?? ((workspaceId: string) => loadHarnessRegistry(workspaceId));
  const listWorktrees = deps.listWorktrees ?? defaultListWorktrees;
  const status = deps.status ?? defaultWorktreeStatus;
  const canonical = deps.canonicalPath ?? defaultCanonicalPath;
  let registry: HarnessRegistry;
  try {
    registry = await loadRegistry(activeWorkspaceId());
  } catch (err) {
    return {
      ok: false,
      reason: `root_unavailable — could not read the active harness registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const candidates = new Map<string, CutWorktree>();
  const projects = registry.projects.filter((project) => project.path.trim().length > 0);
  for (const project of projects) {
    try {
      for (const worktree of listWorktrees(project.path)) {
        if (worktree.prunable) continue;
        candidates.set(canonical(worktree.path), worktree);
      }
    } catch {
      // A repo-less/non-Git registered project is not a valid cut-root carrier.
    }
  }

  const requestedPath = canonical(requested);
  const requestedDesktopParent = path.basename(requestedPath) === 'papercusp-desktop'
    ? canonical(path.dirname(requestedPath))
    : null;
  let selected: CutWorktree | undefined;
  if (requestedDesktopParent) selected = candidates.get(requestedDesktopParent);
  if (!selected) selected = candidates.get(requestedPath);
  if (!selected) {
    const project = projects.find((candidate) => candidate.slug === requested);
    if (project) selected = candidates.get(canonical(project.path));
  }
  if (!selected) {
    return {
      ok: false,
      reason:
        `root_not_registered — '${requested}' is not a linked worktree of any project registered in the active workspace; ` +
        'select a registered project slug or a path from `git worktree list --porcelain`.',
    };
  }

  let dirty: string;
  try {
    dirty = status(selected.path);
  } catch (err) {
    return {
      ok: false,
      reason: `root_unreadable — could not inspect git status for '${selected.path}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (dirty.trim().length > 0) {
    return {
      ok: false,
      reason: `root_not_clean — selected worktree '${selected.path}' has uncommitted changes; release cuts require a clean worktree`,
    };
  }

  return {
    ok: true,
    selector: requested,
    worktreeRoot: selected.path,
    desktopRoot: path.join(selected.path, 'papercusp-desktop'),
  };
}

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

function desktopReleaseTag(version: string, channel: Channel): string {
  return channel === 'stable' ? `desktop-v${version}` : `desktop-v${version}-${channel}`;
}

function prepareTagPreview(desktop: string, version: string, channel: Channel, sourceSha: string): string {
  const script = path.join(desktop, 'bin', 'release-local.sh');
  return (
    `PAPERCUSP_RELEASE_PREPARE_TAG_SHA='${sourceSha}' ` +
    `PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM='1' ` +
    `'${script}' '${version}' '${channel}'`
  );
}

export default defineTool({
  name: 'release:cut',
  profile: 'engineer',
  description:
    'CUT a LOCAL Papercusp desktop release — build+sign installer(s) for the owner to upload (⛔ artifacts stay LOCAL; never create a GitHub Release). Every run/run-leg requires sourceSha, the exact 40-char superproject commit the cutter must still be on; drift refuses before writes. op:prepare-tag is the separate, explicit remote-ref write required before a brand-new version: create-only force-with-lease, dry-run unless confirm:true, never overwrites a mismatched tag. Wraps bin/release-local.sh. op:preflight (go/no-go). op:run (fire the WHOLE cut detached; dry-run unless confirm:true; operator role). op:run-leg (WI-4233: fire ONE platform leg — linux/mac/windows/arm64 — on its own unit, for a fleet-split cut; same gate). op:abort-leg (stop one leg). op:status (poll; optional `platform` for a per-leg poll). op:gate-status (read/establish the shared BUILD_SHA gate for version+channel so split legs cannot drift onto different shas). op:handoff (collect signed artifacts+sha256 — leg-agnostic).',
  guidance: {
    when:
      'Cutting a desktop release. Brand-new version: preflight → prepare-tag{sourceSha,confirm:true} → run{sourceSha,confirm:true} → poll status → verify → handoff. Fleet-split (one agent per leg): prepare the tag once, then each agent gate-status first (agree on ONE buildSha) → run-leg{platform,confirm:true} → poll status{platform} → once every leg is done, handoff (collects across all legs).',
    notWhen: "Not the web operator (:3070 — release:deploy) or the green-checkpoint verdict (release:checkpoint-run). Never publish to GitHub.",
    seeAlso: [
      'recipes:run release-verify-provenance / release-vm-preflight / release-install-and-relaunch-verify (the RELEASE-RUNBOOK ship-gate this cut composes)',
      'release:deploy (deploy the WEB operator to :3070 — a different target)',
      'release:checkpoint-run (the green-checkpoint verdict producer)',
    ],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // EI-18803497769946984: every op here shells out (bin/release-local.sh, systemd
  // polls, sha256 collection) and none reads ctx.tx. Holding the dispatcher's
  // ambient workspace transaction across a child process that can outlast
  // idle_in_transaction_session_timeout (60s) gets the backend killed, and the
  // caller sees a bare "write CONNECTION_CLOSED 127.0.0.1:6432" naming neither
  // the tool nor the cause. A cut is minutes long, so this is not a near miss.
  skipWorkspaceTx: true,
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
      root: cutRootArg.optional(),
    }),
    z.object({
      op: z.literal('prepare-tag'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease).'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact 40-char superproject commit the new release tag must name.'),
      root: cutRootArg.optional(),
      confirm: z
        .boolean()
        .optional()
        .describe('false/absent ⇒ DRY RUN. true ⇒ create the missing exact remote tag under an absence lease.'),
    }),
    z.object({
      op: z.literal('run'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact 40-char superproject commit authorized for this cut.'),
      mac: z.boolean().optional().describe('Include the macOS leg (build VM on SSH :2222).'),
      windows: z.boolean().optional().describe('Include the Windows leg (build VM on SSH :2223).'),
      arm64: z.boolean().optional().describe('Include the linux-arm64 cross-compile leg.'),
      root: cutRootArg.optional(),
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
      root: cutRootArg.optional(),
    }),
    z.object({
      op: z.literal('run-leg'),
      platform: z.enum(PLATFORMS as [Platform, ...Platform[]]).describe('Which platform leg to fire on its own unit.'),
      version: z.string().min(1).describe('Release version X.Y.Z (optional -prerelease), e.g. 0.0.8 or 1.2.3-rc.1.'),
      channel: z.enum(['stable', 'beta', 'alpha']).describe('Release channel.'),
      sourceSha: z.string().regex(/^[0-9a-f]{40}$/).describe('Exact 40-char superproject commit authorized for this leg.'),
      root: cutRootArg.optional(),
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
      root: cutRootArg.optional(),
    }),
  ]),
  async handler(args, ctx) {
    // ── preflight: read-only go/no-go ──
    if (args.op === 'preflight') {
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'preflight', refused: true, reason: selected.reason });
      const result = preflightCut(legsFrom(args), { root: selected.desktopRoot });
      return json({
        ok: true,
        op: 'preflight',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        ...result,
        note: result.go
          ? "Ready to cut. release:cut{op:run,version,channel,confirm:true} fires it detached. LOCAL-only — hand the owner the artifacts (op:handoff), never publish to GitHub."
          : `Not ready — resolve the blocker(s) first: ${result.blockers.join('; ')}`,
      });
    }

    // ── prepare-tag: the one explicit remote-ref write ──
    // A LOCAL artifact cut still never publishes to GitHub. This separate op
    // satisfies the dogfood clone pin for a brand-new version without hiding a
    // remote mutation inside the build, and its empty force-with-lease refuses
    // to overwrite a ref created concurrently or at a different source.
    if (args.op === 'prepare-tag') {
      if (!isValidVersion(args.version)) {
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          reason: `bad_version '${args.version}' — expected X.Y.Z with an optional -prerelease suffix.`,
        });
      }
      if (!isValidSourceSha(args.sourceSha)) {
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          reason: `bad_source_sha '${args.sourceSha ?? '<missing>'}' — expected an exact 40-character lowercase superproject commit.`,
        });
      }
      if (args.confirm && !isOperatorConfigWriteRole(ctx.role)) {
        return json({
          ok: false,
          op: 'prepare-tag',
          refused: true,
          reason: `role_forbidden — release:cut{op:prepare-tag,confirm:true} requires operator, mug, or architect role (you are role:${ctx.role ?? 'unknown'}).`,
        });
      }

      const channel = args.channel as Channel;
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'prepare-tag', refused: true, reason: selected.reason });
      const tag = desktopReleaseTag(args.version, channel);
      const wouldRun = prepareTagPreview(selected.desktopRoot, args.version, channel, args.sourceSha);
      if (!args.confirm) {
        return json({
          ok: true,
          op: 'prepare-tag',
          dry_run: true,
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          tag,
          root: selected.desktopRoot,
          ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
          remoteRefWrite: true,
          githubRelease: false,
          artifactUpload: false,
          wouldRun,
          note:
            `Pass confirm:true to create missing origin refs/tags/${tag} at the exact source under a create-only lease. ` +
            'If origin is GitHub the TAG becomes visible there; this never creates a GitHub Release or uploads artifacts.',
        });
      }

      let commandOutput = '';
      try {
        commandOutput = String(
          execFileSync(path.join(selected.desktopRoot, 'bin', 'release-local.sh'), [args.version, channel], {
            cwd: selected.desktopRoot,
            encoding: 'utf8',
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            env: {
              ...process.env,
              PAPERCUSP_RELEASE_PREPARE_TAG_SHA: args.sourceSha,
              PAPERCUSP_RELEASE_PREPARE_TAG_CONFIRM: '1',
            },
          }),
        ).trim();
      } catch (err) {
        const reason = `prepare_tag_failed — ${err instanceof Error ? err.message : String(err)}`;
        const { ownerLabel } = readIdentity(ctx);
        await recordCutAudit('prepare-tag', `${ownerLabel} (role:${ctx.role ?? 'unknown'})`, {
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          tag,
          root: selected.desktopRoot,
          created: false,
          reason,
        });
        return json({ ok: false, op: 'prepare-tag', refused: true, version: args.version, channel, sourceSha: args.sourceSha, tag, reason });
      }

      const { ownerLabel } = readIdentity(ctx);
      await recordCutAudit('prepare-tag', `${ownerLabel} (role:${ctx.role ?? 'unknown'})`, {
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        tag,
        root: selected.desktopRoot,
        created: true,
      });
      return json({
        ok: true,
        op: 'prepare-tag',
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        tag,
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        remoteRefWrite: true,
        githubRelease: false,
        artifactUpload: false,
        output: commandOutput,
        note: `Exact release tag ${tag} is prepared. The artifact cut remains LOCAL-only and must still receive sourceSha=${args.sourceSha}.`,
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
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'handoff', refused: true, reason: selected.reason });
      const h = collectHandoff(args.version, { root: selected.desktopRoot });
      if (!h.found) {
        return json({
          ok: false,
          op: 'handoff',
          found: false,
          version: args.version,
          root: selected.desktopRoot,
          targetRoot: h.targetRoot,
          scannedRoots: h.scannedRoots,
          reason: `no ${args.version} artifacts under ${h.scannedRoots.length > 0 ? h.scannedRoots.join(', ') : h.targetRoot} — cut it first (release:cut{op:run}) or check the version.`,
        });
      }
      // Missing sigs on NON-updater artifacts (dmg / setup.exe / .bin slices / deb) are
      // expected — only updater-feed artifacts (.app.tar.gz / .AppImage / .nsis.zip) hard-block
      // (WI-4243: the old blanket check false-alarmed "unsigned dmg — do NOT hand over").
      const sigInfo =
        h.unsignedInfoNames.length > 0
          ? ` (${h.unsignedInfoNames.length} non-updater artifact(s) have no .sig — expected, not a blocker: ${h.unsignedInfoNames.join(', ')})`
          : '';
      return json({
        ok: true,
        op: 'handoff',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
        ...h,
        shipGate:
          h.unsignedNames.length > 0
            ? `⚠ ${h.unsignedNames.length} UPDATER artifact(s) are UNSIGNED (${h.unsignedNames.join(', ')}) — the updater can't verify them. Do NOT hand these over; re-cut with the signing key present.${sigInfo}`
            : `All updater artifacts are signed.${sigInfo} Run the ship-gate before hand-off: recipes:run release-verify-provenance for a dev-box cut, or bin/verify-provenance.sh <leg-out-dir> --health-sha <leg sha> per leg for a release cut (the recipe feeds the DEV :3070 health sha, which is wrong for release-cut legs).`,
        note: 'LOCAL-only hand-off: give the OWNER these local paths + sha256 to upload. ⚠ Windows Inno *-setup-N.bin payload slices MUST be uploaded into the same directory as their setup.exe. Never publish to GitHub.',
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
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'gate-status', refused: true, reason: selected.reason });
      const { ownerLabel } = readIdentity(ctx);
      const { gate, created } = readOrCreateGate(args.version, args.channel as Channel, ownerLabel, { root: selected.desktopRoot });
      return json({
        ok: true,
        op: 'gate-status',
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
      if (!isValidSourceSha(args.sourceSha)) {
        return json({
          ok: false,
          op: 'run-leg',
          refused: true,
          reason: `bad_source_sha '${args.sourceSha ?? '<missing>'}' — expected the exact 40-character lowercase superproject commit authorized for this cut.`,
        });
      }
      const channel = args.channel as Channel;
      const platform = args.platform as Platform;
      const legs = legsForPlatform(platform);
      const selected = await resolveCutRoot(args.root);
      if (!selected.ok) return json({ ok: false, op: 'run-leg', refused: true, reason: selected.reason });

      const pre = preflightCut(legs, { platform, root: selected.desktopRoot });
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
        const argv = buildCutArgv(selected.desktopRoot, args.version, channel, legs, args.sourceSha, '<PATH>', platform);
        return json({
          ok: true,
          op: 'run-leg',
          dry_run: true,
          platform,
          version: args.version,
          channel,
          sourceSha: args.sourceSha,
          root: selected.desktopRoot,
          ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
      const launch = await launchDetachedCut({ version: args.version, channel, expectedSourceSha: args.sourceSha, legs, platform, root: selected.desktopRoot });
      await recordCutAudit('run-leg', actor, {
        platform,
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        root: selected.desktopRoot,
        legs,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
        sourceSha: args.sourceSha,
        legs,
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
    if (!isValidSourceSha(args.sourceSha)) {
      return json({
        ok: false,
        op: 'run',
        refused: true,
        reason: `bad_source_sha '${args.sourceSha ?? '<missing>'}' — expected the exact 40-character lowercase superproject commit authorized for this cut.`,
      });
    }
    const channel = args.channel as Channel;
    const legs = legsFrom(args);
    const selected = await resolveCutRoot(args.root);
    if (!selected.ok) return json({ ok: false, op: 'run', refused: true, reason: selected.reason });

    // Refuse to start a second cut over an in-flight one (structured, so the caller waits).
    const pre = preflightCut(legs, { root: selected.desktopRoot });
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
      const argv = buildCutArgv(selected.desktopRoot, args.version, channel, legs, args.sourceSha, '<PATH>');
      return json({
        ok: true,
        op: 'run',
        dry_run: true,
        version: args.version,
        channel,
        sourceSha: args.sourceSha,
        root: selected.desktopRoot,
        ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
    const launch = await launchDetachedCut({ version: args.version, channel, expectedSourceSha: args.sourceSha, legs, root: selected.desktopRoot });
    await recordCutAudit('run', actor, {
      version: args.version,
      channel,
      sourceSha: args.sourceSha,
      root: selected.desktopRoot,
      legs,
      ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
      sourceSha: args.sourceSha,
      legs,
      root: selected.desktopRoot,
      ...(selected.selector ? { rootSelector: selected.selector, worktreeRoot: selected.worktreeRoot } : {}),
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
