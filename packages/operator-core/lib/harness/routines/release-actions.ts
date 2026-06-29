/**
 * Release-gating system actions — plan release-gate-ready-branch-2026-06-04
 * (Phase 1 green-checkpoint); staging→main auto-serve model since
 * staging-branch-pipeline-2026-06-06.
 *
 * Two routines, registered here so the routines engine can fire them:
 *   - `system:green-checkpoint` — fast-forwards the green pin (the **`main`
 *     branch**) to the newest GREEN `staging` commit. Runs the suite in an
 *     ISOLATED checkout.
 *   - `system:release-trigger` — when green `main` is ahead of the running
 *     release checkout, runs the SCRIPTED deploy (`deploy-cli --execute`)
 *     directly: the green gate IS the go/no-go now (auto-serve), and the deploy
 *     mechanics carry their own drain + health-check + auto-rollback. The
 *     release-manager agent remains for interactive/incident use only.
 *
 * Both are seeded ACTIVE (seed-release-routines.ts) — auto-serve posture.
 *
 * Layering: these handlers SHELL OUT to the standalone scripts in
 * apps/operator/lib/release/* (operator-core must not import the apps/operator
 * tier). The scripts are designed to run standalone via tsx for exactly this.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type postgres from 'postgres';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { appendPipelineEvent } from '../git-sync/pipeline-events';
import { releaseCheckpointConfig } from '../../release-checkpoint-config';
import { STALE_MS } from '../../liveness';

/** Markers the release CLIs print their result JSON behind (P-008) — parse ONE delimited
 *  line instead of brace-slicing all of stdout (fragile to any log line with braces). MUST
 *  match the literals in green-checkpoint.ts / deploy-cli.ts (operator-core cannot import
 *  the apps/operator tier, so the contract is duplicated by value). */
const GREEN_CHECKPOINT_RESULT_MARKER = '__GREEN_CHECKPOINT_RESULT__';
const DEPLOY_PLAN_MARKER = '__DEPLOY_PLAN__';

/** Parse the JSON on the line carrying `marker`, or null if absent/unparseable. */
function parseMarkerLine(stdout: string, marker: string): Record<string, unknown> | null {
  const line = stdout.split('\n').find((l) => l.includes(marker));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The integration tree (where green-checkpoint/deploy operate). Explicit env so
 *  it stays correct even after the operator itself runs from the release checkout. */
function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(
  root: string,
  relScript: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    // P-007: detached → the child is its own process-GROUP leader, so on the timeout we
    // can SIGTERM the WHOLE group (tsx → npm → vitest workers), not just the tsx parent.
    // Killing only the parent orphaned the test workers, which kept loading the shared
    // box past the cap and manufactured the very load-flakes the gate then has to absorb.
    const child = spawn(tsxBin(root), [path.join(root, relScript), ...args], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root, ...extraEnv },
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let sigkiller: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig); // negative pid → the whole group
      } catch {
        /* group already gone */
      }
    };
    const killer = setTimeout(() => {
      killGroup('SIGTERM');
      // Escalate if a wedged worker ignores SIGTERM, so the group can't linger.
      sigkiller = setTimeout(() => killGroup('SIGKILL'), 15_000);
    }, timeoutMs);
    const finish = (r: RunResult): void => {
      clearTimeout(killer);
      if (sigkiller) clearTimeout(sigkiller);
      resolve(r);
    };
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * The wall-clock budget for ONE green-checkpoint suite run before runScript
 * SIGTERMs the whole process group (P-007). This MUST track the gate's fork
 * concurrency: GREEN_CHECKPOINT_MAX_FORKS (green-checkpoint.ts) was lowered
 * 8→4→2 for OOM safety on this memory-pressured shared box, which ~doubled the
 * suite's wall-clock — but this budget stayed at the original 25m, so every
 * 2-fork run OVERRAN it and was SIGTERM-killed (exit 143) BEFORE producing any
 * verdict, wedging the green gate (and thus every fleet deploy) for ~18h
 * (green-checkpoint-timeout-vs-forks-2026-06-27). 55m gives a 2-fork run headroom
 * to COMPLETE under live-fleet load.
 *
 * INVARIANT: keep this STRICTLY LESS than CHECKPOINT_LOCK_STALE_MS
 * (green-checkpoint.ts, 65m) — a run must be killed by THIS timeout (and release
 * its lock) before that lock is stale-reclaimable, else the next hourly fire
 * spawns a SECOND concurrent suite and OOMs the box. operator-core cannot import
 * from apps/operator, so the two constants live in separate files; whoever
 * retunes one must retune the other (same convention as the result MARKERs above).
 *
 * Deeper root (see green-checkpoint.ts GREEN_CHECKPOINT_MAX_FORKS notes): the
 * box's memory BASELINE / the :3070 operator-cluster size. Freeing memory there
 * would let the gate run more forks → finish faster → afford a SHORTER budget.
 * This bump UNWEDGES the gate; it does not remove that deeper cost.
 */
export const GREEN_CHECKPOINT_SUITE_TIMEOUT_MS = 55 * 60_000;

/**
 * system:green-checkpoint — advance `ready` to the newest green integration
 * commit. Idempotent (FF-only, no-op when already green). Bounded so a stuck
 * suite can't wedge the routines tick.
 */
registerSystemAction('green-checkpoint', async (ctx: SystemActionCtx) => {
  // per-hive-git-and-release-gate P-010: route a per-hive routine to ITS OWN checkout /
  // branches / greenCmd. Operator-home (papercusp) → default root + empty overlay = EXACT
  // current behavior (regression-safe). A non-gated installSlug (gate disabled / no repo) →
  // skip (never run a suite for it). The overlay rides runScript's extraEnv → the
  // env-driven releaseConfig() in green-checkpoint.ts picks up the per-hive config.
  const { resolveCheckpointRouting } = await import('./hive-release-env');
  const routing = await resolveCheckpointRouting(ctx, integrationRoot());
  if (routing.skip) {
    console.log(`[green-checkpoint] skip ${ctx.installSlug}: ${routing.skip.reason}`);
    await appendPipelineEvent({
      workspaceId: ctx.workspaceId,
      installSlug: ctx.installSlug,
      kind: 'green_checkpoint',
      status: 'skipped-disabled',
      detail: { reason: routing.skip.reason },
    });
    return;
  }
  const root = routing.root;
  const r = await runScript(
    root,
    'apps/operator/lib/release/green-checkpoint.ts',
    [],
    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    routing.extraEnv,
  );
  if (r.code !== 0) {
    console.warn(`[green-checkpoint] exited ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
  } else {
    console.log(`[green-checkpoint] ${(r.stdout || '').trim().slice(-200)}`);
  }

  // Pipeline history (mig 177): log the checkpoint outcome for the /admin Git tab.
  // The CLI prints the CheckpointResult as JSON ({ advanced, candidate, from,
  // green, reason }); `reason` IS our status vocabulary. On a crash before that
  // print (non-zero exit, no parseable JSON), record an 'error' row instead.
  let status = 'error';
  let candidate: string | undefined;
  let summary: string | undefined;
  let failingTests: string[] | undefined;
  let flakeSuspects: string[] | undefined;
  const detail: Record<string, unknown> = {};
  // P-008: parse the delimited result marker, not a brace-slice of all stdout.
  const parsed = parseMarkerLine(r.stdout, GREEN_CHECKPOINT_RESULT_MARKER) as {
    reason?: string;
    green?: boolean | null;
    candidate?: string;
    from?: string | null;
    summary?: string;
    failingTests?: string[];
    flakeSuspects?: string[];
    advancedTo?: string;
  } | null;
  if (parsed?.reason) {
    status = parsed.reason; // advanced | up-to-date | not-green | not-fast-forward | create-failed | skipped-locked
    candidate = parsed.candidate;
    summary = parsed.summary;
    failingTests = parsed.failingTests;
    flakeSuspects = parsed.flakeSuspects;
    detail.green = parsed.green ?? null;
    if (parsed.candidate) detail.candidate = parsed.candidate.slice(0, 12);
    if (parsed.from) detail.from = parsed.from.slice(0, 12);
    // P-016: on a partial advance, record the prefix sha `main` was FF'd to (the red
    // tip stays in `candidate`) so /admin/git shows WHERE main landed vs the held tip.
    if (parsed.advancedTo) detail.advancedTo = parsed.advancedTo.slice(0, 12);
    // P-003 (git-sync-dx-hardening): persist the failing-test reason in the
    // append-only event so WHY the gate was red survives the per-tick metadata
    // overwrite (capped — the full list also goes to the release-fixer).
    if (parsed.failingTests?.length) detail.failingTests = parsed.failingTests.slice(0, 20);
    // load-flake-isolation-2026-06-23: persist the files the gate ABSORBED as
    // load-flakes (red under the 8-fork load, green in isolation) so an advance that
    // rode a flake absorption is auditable in the append-only pipeline event.
    if (parsed.flakeSuspects?.length) detail.flakeSuspects = parsed.flakeSuspects.slice(0, 20);
  } else {
    // No parseable result marker (crash before print / non-zero exit) → 'error'.
    detail.code = r.code;
    detail.stderr = (r.stderr || r.stdout).slice(-300);
  }
  await appendPipelineEvent({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    kind: 'green_checkpoint',
    status,
    detail,
  });

  // P-006 (release-pipeline-resilience-2026-06-09): a held gate auto-dispatches a
  // release-fixer agent to diagnose + fix the failing test — the test-failure
  // sibling of git-sync's merge-resolver. Fail-safe + deduped per red-candidate.
  // P-016 (D-010): on 'advanced-prefix' the longest-green PREFIX was promoted but the
  // batch TIP is still red — `candidate` is that red tip + `failingTests` its failures,
  // so the fixer dispatch is identical to a full hold (it must still fix the red tip).
  if ((status === 'not-green' || status === 'advanced-prefix') && candidate) {
    await dispatchReleaseFixer(ctx, candidate, failingTests).catch((e) =>
      console.warn(`[green-checkpoint] release-fixer dispatch failed: ${e instanceof Error ? e.message : e}`),
    );
  }

  // P-004: track the red streak + time-since-last-green across ticks and fire a
  // LOUDER urgent alert when the gate has been HELD too long (the "stuck for a
  // while" signal, distinct from the per-candidate notification). Runs for every
  // verdict so it resets on green; fail-safe.
  await trackGateStall(ctx, status, candidate, failingTests).catch((e) =>
    console.warn(`[green-checkpoint] stall tracking failed: ${e instanceof Error ? e.message : e}`),
  );

  // P-009: per-workspace flake history — tally workspaces the gate marked as a
  // PROVEN flake (failed then passed on retry) and notify when one is chronically
  // flaky so it gets quarantined accountably. Fail-safe.
  // load-flake-isolation-2026-06-23: ALSO tally the per-FILE flakes the new isolation
  // pass absorbed (red under load, green in isolation) — proven flakes keyed by
  // `<ws>::<file>`, finer-grained than the workspace-retry markers, so a chronically
  // load-flaky FILE trips the same quarantine nudge.
  await trackFlakeHistory(ctx, summary, flakeSuspects).catch((e) =>
    console.warn(`[green-checkpoint] flake history failed: ${e instanceof Error ? e.message : e}`),
  );
});

/** P-004 thresholds: a gate held this many consecutive hourly checkpoints — or
 *  with no green for this long — is STALLED and worth an urgent, one-shot alert. */
// P-016: STALL thresholds are runtime-settable — see releaseCheckpointConfig() (release:checkpoint-config).

// P-003 (git-sync-dx-hardening): a stalled gate gets a DURABLE escalation row
// (every other pipeline failure has one) — its own phase so it never clobbers
// the git-sync conflict/error rows.
const GATE_STALL_PHASE = 'green-checkpoint-stall';
const GATE_STALL_KIND = 'green-checkpoint-stall';

/** Pure: the `harness_escalations` body for a green-checkpoint stall (testable). */
export function gateStallEscalationBody(opts: {
  installSlug: string;
  consecutiveReds: number;
  heldHrs: number | null;
  candidate?: string | null;
  failingTests?: string[];
  nowMs: number;
}): string {
  const tests = (opts.failingTests ?? []).slice(0, 20);
  return JSON.stringify({
    kind: GATE_STALL_KIND,
    harness_slug: opts.installSlug,
    consecutiveReds: opts.consecutiveReds,
    heldHrs: opts.heldHrs,
    candidate: opts.candidate ? opts.candidate.slice(0, 12) : null,
    failingTests: tests,
    emitted_at: opts.nowMs,
    detail: `green-checkpoint has held main for ${opts.consecutiveReds} checkpoint(s)${
      opts.heldHrs != null ? ` (~${opts.heldHrs}h since the last green)` : ''
    }; staging changes are NOT reaching the release.${
      tests.length ? ` Failing: ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}.` : ''
    }`,
  });
}

/**
 * P-004: track green-checkpoint gate health in the routine metadata (`gate_health`)
 * and fire ONE urgent stall alert when the red streak / age crosses the threshold
 * (transition-only via `stallAlerted`). The data also surfaces on the Git tab via
 * gitPipelineSnapshot().gate. Fail-safe — the routine tick never depends on it.
 */
async function trackGateStall(
  ctx: SystemActionCtx,
  status: string,
  candidate?: string,
  failingTests?: string[],
): Promise<void> {
  // P-016 (D-010): a partial advance ('advanced-prefix') MOVED `main` (the longest green
  // prefix is deployable), so it resets the "main hasn't advanced" stall streak just like
  // a full advance — the red tip is tracked separately via the release-fixer dispatch.
  const isGreen = status === 'advanced' || status === 'up-to-date' || status === 'advanced-prefix';
  // P-006: every non-green verdict counts toward the stall streak — INCLUDING 'error'
  // (a green-checkpoint script crash, the 25-min timeout, or unparseable JSON) AND
  // 'skipped-locked' (a stale run-lock the CLI couldn't acquire — green-checkpoint-stale-lock-
  // 2026-06-26). Both are deliberately ABSENT from `isGreen` above, so a persistent crash /
  // hang / wedged-lock increments the streak and fires the held-gate alarm instead of
  // freezing `main` SILENTLY (the 21h fleet-deploy freeze this detector exists to catch).
  // Only a real green verdict resets the streak.
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'gate_health' AS gh FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ gh: { consecutiveReds?: number; lastGreenAt?: number; firstRedAt?: number; stallAlerted?: boolean } | null }>;
  const gh = rows[0]?.gh ?? {};
  let next: Record<string, unknown>;
  if (isGreen) {
    next = { consecutiveReds: 0, lastGreenAt: Date.now(), firstRedAt: null, stallAlerted: false };
    // P-003: clear the durable stall escalation on the green transition (idempotent).
    try {
      await sql.unsafe(
        `UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $2
          WHERE harness_slug = $1 AND phase = $3 AND escalation IS NOT NULL`,
        [ctx.installSlug, Date.now(), GATE_STALL_PHASE],
      );
    } catch (e) {
      console.warn(`[green-checkpoint] stall escalation clear failed: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    const consecutiveReds = (gh.consecutiveReds ?? 0) + 1;
    const firstRedAt = gh.firstRedAt ?? Date.now();
    const lastGreenAt = gh.lastGreenAt ?? null;
    let stallAlerted = gh.stallAlerted ?? false;
    const stalledByCount = consecutiveReds >= releaseCheckpointConfig().stallReds;
    const stalledByAge = lastGreenAt != null && Date.now() - lastGreenAt > releaseCheckpointConfig().stallAgeMs;
    if ((stalledByCount || stalledByAge) && !stallAlerted) {
      stallAlerted = true;
      const heldHrs = lastGreenAt ? Math.round((Date.now() - lastGreenAt) / 3_600_000) : null;
      try {
        const { notifyAttention } = await import('../../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline STALLED — main frozen',
          body: `green-checkpoint has held \`main\` for ${consecutiveReds} consecutive checkpoint(s)${heldHrs != null ? ` (~${heldHrs}h since the last green)` : ''}. Staging changes are NOT reaching the release. A release-fixer is on it; manual help may be needed.`,
          importance: 'urgent',
          workspaceId: ctx.workspaceId,
          data: { consecutiveReds, candidate: candidate?.slice(0, 12) ?? null },
        });
      } catch (e) {
        console.warn(`[green-checkpoint] stall alert failed: ${e instanceof Error ? e.message : e}`);
      }
      // P-003: ALSO write a durable harness_escalations row — the silent-stall
      // gap (every other pipeline failure escalates; this one only notified +
      // overwrote metadata). Its own phase, idempotent upsert; fail-safe.
      try {
        await sql.unsafe(
          `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (harness_slug, phase)
           DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
          [
            ctx.installSlug,
            GATE_STALL_PHASE,
            gateStallEscalationBody({
              installSlug: ctx.installSlug,
              consecutiveReds,
              heldHrs,
              candidate,
              failingTests,
              nowMs: Date.now(),
            }),
            Date.now(),
            ctx.workspaceId,
          ],
        );
      } catch (e) {
        console.warn(`[green-checkpoint] stall escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    next = { consecutiveReds, lastGreenAt, firstRedAt, stallAlerted };
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug, JSON.stringify({ gate_health: next })],
  );
}

/** P-009 thresholds: a workspace that has flaked this often is "chronically
 *  flaky"; re-notify at most once a day per workspace. */
// P-016: CHRONIC-FLAKE thresholds are runtime-settable — see releaseCheckpointConfig().

/**
 * P-009: per-workspace flake history. The affected-tests runner prints
 * `>>> <ws> passed on retry — counted as a FLAKE` when a workspace FAILED then
 * PASSED on the gate's single retry — an EXPLICIT, PROVEN flake. A real
 * regression fails twice and never gets this marker, so tallying these respects
 * this plan's D-002 (classify before acting) + D-004 (a regression still holds
 * main). We accumulate the counts per workspace in the green-checkpoint routine
 * metadata (`flake_history`), surface them on the Git tab via
 * gitPipelineSnapshot().gate.flakyWorkspaces, and notify ONCE (per cooldown) when
 * a workspace becomes chronically flaky so it gets quarantined accountably — the
 * lock-respecting `quarantine.txt` edit + de-quarantine follow-up are the
 * release-fixer's / a human's job (D-003), never a tracked-file write from this
 * routine. Fail-safe — the routine tick never depends on it.
 */
async function trackFlakeHistory(
  ctx: SystemActionCtx,
  summary?: string,
  flakeSuspects?: string[],
): Promise<void> {
  const flaked = new Set<string>();
  if (summary) {
    for (const m of summary.matchAll(/>>>\s+(\S+)\s+passed on retry — counted as a FLAKE/g)) {
      flaked.add(m[1]);
    }
  }
  // load-flake-isolation-2026-06-23: the per-file flakes the isolation pass absorbed
  // are PROVEN flakes too (failed under the gate's load, passed in an isolated re-run),
  // keyed by `<ws>::<file>` so the ledger distinguishes a chronically-flaky FILE from a
  // chronically-flaky workspace.
  for (const f of flakeSuspects ?? []) flaked.add(f);
  if (flaked.size === 0) return;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'flake_history' AS fh FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ fh: Record<string, { flakes?: number; lastFlakeAt?: number; notifiedAt?: number }> | null }>;
  const fh = rows[0]?.fh ?? {};
  const now = Date.now();
  const newlyChronic: string[] = [];
  for (const ws of flaked) {
    const prev = fh[ws] ?? {};
    const flakes = (prev.flakes ?? 0) + 1;
    let notifiedAt = prev.notifiedAt;
    if (flakes >= releaseCheckpointConfig().chronicFlakeCount && (notifiedAt == null || now - notifiedAt > releaseCheckpointConfig().flakeNotifyCooldownMs)) {
      newlyChronic.push(ws);
      notifiedAt = now;
    }
    fh[ws] = { flakes, lastFlakeAt: now, notifiedAt };
  }
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug, JSON.stringify({ flake_history: fh })],
  );
  if (newlyChronic.length > 0) {
    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: 'Chronically-flaky test(s) in the release gate',
        body: `${newlyChronic.join(', ')} has flaked ≥${releaseCheckpointConfig().chronicFlakeCount}× in the green-checkpoint suite (failed then passed on retry). Quarantine it accountably (quarantine.txt + a de-quarantine follow-up) so it stops risking gate stalls.`,
        importance: 'high',
        workspaceId: ctx.workspaceId,
        data: { workspaces: newlyChronic.join(',') },
      });
    } catch (e) {
      console.warn(`[green-checkpoint] flake notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Persisted release-fixer dedup record (green-checkpoint routine metadata `last_fixer`). */
export interface ReleaseFixerRecord {
  /** Stable failure signature (sorted failing test files) — dedup key across candidates. */
  signature?: string;
  candidate?: string;
  /** When the fixer was last dispatched for this signature (epoch ms). */
  at?: number;
  /** The dispatched fixer's spawn id (fire-and-forget path) — null on the DBOS-durable
   *  path (which re-fires on crash itself) or a legacy record predating this field.
   *  THE signal P-014/D-009 added: the id we check liveness against. */
  spawnId?: string | null;
  runId?: string | null;
  /** When the human was last notified for this signature (notify cooldown, separate from dispatch). */
  notifiedAt?: number;
}

export interface ReleaseFixerDecision {
  /** (Re-)dispatch a fixer this tick. */
  dispatch: boolean;
  /** Notify the human this tick (rate-limited separately from dispatch). */
  notify: boolean;
  reason: 'fresh' | 'covered' | 'self-heal';
}

/** The fixer dedup / self-heal window (2h). The signature dedup that was the ONLY
 *  guard before P-014; now the liveness check overrides it for a dead fixer. */
export const RELEASE_FIXER_DEDUP_MS = 2 * 60 * 60_000;

/**
 * PURE dispatch decision (agent-activity-liveness-truth-2026-06-21 P-014 / D-009).
 *
 * The old dedup was purely TIME-based — skip a same-signature re-dispatch for 2h —
 * so a fixer that DIED inside the window left the gate red + UNCOVERED for up to 2h
 * (the 2026-06-21 incident: a dead gate-fix bee mistaken for "actively fixing it").
 * Now liveness-aware: within the window we skip ONLY if the dispatched fixer is
 * still ALIVE; a dead fixer re-dispatches immediately (self-heal). Notify is
 * decided separately (rate-limited) so an hourly self-heal re-dispatch can't spam.
 *
 * @param fixerAlive caller's liveness verdict for the recorded fixer spawn:
 *   `true` = running + fresh heartbeat (covered); `false` = confirmed GONE
 *   (dead / finished / stale heartbeat) → re-dispatch; `null` = UNKNOWN (no spawn
 *   id to check — a DBOS-durable fire that self-recovers, or a legacy record) →
 *   treated as covered within the window, so we never regress to hammering.
 */
export function decideReleaseFixerDispatch(args: {
  lf: ReleaseFixerRecord | null;
  signature: string;
  now: number;
  fixerAlive: boolean | null;
  dedupMs?: number;
  notifyCooldownMs?: number;
}): ReleaseFixerDecision {
  const dedupMs = args.dedupMs ?? RELEASE_FIXER_DEDUP_MS;
  const notifyCooldownMs = args.notifyCooldownMs ?? RELEASE_FIXER_DEDUP_MS;
  const { lf, signature, now } = args;
  const sameRecent =
    !!lf && lf.signature === signature && typeof lf.at === 'number' && now - lf.at < dedupMs;
  if (!sameRecent) {
    // A fresh failure (new signature, or the prior one aged out) — dispatch + notify.
    return { dispatch: true, notify: true, reason: 'fresh' };
  }
  // Same failure within the window: the liveness-aware gate (D-009).
  if (args.fixerAlive !== false) {
    // alive (true) OR unknown (null — durable/legacy) → a fixer is (presumed) on it.
    return { dispatch: false, notify: false, reason: 'covered' };
  }
  // The previously-dispatched fixer is CONFIRMED GONE → self-heal: re-dispatch now.
  // Re-notify only past the notify cooldown so an hourly self-heal doesn't spam.
  const lastNotify = lf.notifiedAt ?? lf.at ?? 0;
  return { dispatch: true, notify: now - lastNotify > notifyCooldownMs, reason: 'self-heal' };
}

/**
 * Is the recorded release-fixer spawn still ALIVE — `running`/`restarting` with a
 * heartbeat inside the shared STALE_MS window (the SAME liveness definition the
 * fleet_assignment view + the stale-claim reconciler use, so they can't drift)?
 * Returns `null` when there's no spawn id to check (a DBOS-durable fire / legacy
 * record), which the decision treats as "presumed covered". Fail-soft: a query
 * error returns null (presumed covered) rather than hammering a re-dispatch.
 */
export async function releaseFixerSpawnAlive(sql: postgres.Sql, spawnId: string | null | undefined): Promise<boolean | null> {
  if (!spawnId) return null;
  const graceSec = Math.max(1, Math.round(STALE_MS / 1000));
  try {
    const rows = (await sql.unsafe(
      `SELECT 1 FROM harness_shared.spawned_agents
        WHERE spawn_id = $1 AND status IN ('running','restarting')
          AND heartbeat_at IS NOT NULL AND (now() - heartbeat_at) < make_interval(secs => $2)
        LIMIT 1`,
      [spawnId, graceSec],
    )) as unknown[];
    return rows.length > 0;
  } catch {
    return null;
  }
}

/**
 * P-006 + P-014: dispatch a release-fixer agent for a held (not-green) gate,
 * mirroring git-sync's merge-resolver. Fires the `release-fix` launch blueprint
 * from the `green-checkpoint:red` trigger via fireLaunchBlueprintForEvent — the
 * canonical, spawn-RECORDING, DBOS-DURABLE fire path the P-007 test already
 * exercises (replacing the old raw fire-and-forget loopbackFetch that recorded no
 * spawn + lost the fixer on a crash). Deduped per red-candidate via the
 * green-checkpoint routine metadata (`last_fixer`) — now LIVENESS-AWARE (D-009): a
 * dead fixer no longer blocks re-dispatch for 2h (the 2026-06-21 incident class).
 * Fail-safe: every step is best-effort and never throws into the routine tick.
 */
async function dispatchReleaseFixer(ctx: SystemActionCtx, candidate: string, failingTests?: string[]): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // P-012: dedup by the FAILURE SIGNATURE (the failing test files / workspaces), not the
  // candidate sha. While the gate stays red, staging advances hourly so every checkpoint
  // is a NEW candidate — keying on sha re-notified the human + re-spawned a fixer every
  // hour for the SAME failure. The signature is stable across candidates; only a CHANGED
  // failure set re-dispatches. Falls back to the candidate sha when none was extracted.
  const signature = failingTests && failingTests.length > 0 ? failingTests.slice().sort().join(',') : candidate;
  const rows = (await sql.unsafe(
    `SELECT metadata->'last_fixer' AS lf FROM harness_shared.routines
      WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
    [ctx.installSlug],
  )) as Array<{ lf: ReleaseFixerRecord | null }>;
  const lf = rows[0]?.lf ?? null;

  // D-009 liveness-aware dedup: within the window, skip ONLY if the previously-
  // dispatched fixer is still alive. A dead/finished fixer re-dispatches now.
  const sameSignature = !!lf && lf.signature === signature;
  const fixerAlive = sameSignature ? await releaseFixerSpawnAlive(sql, lf?.spawnId) : null;
  const now = Date.now();
  const decision = decideReleaseFixerDispatch({ lf, signature, now, fixerAlive });
  if (!decision.dispatch) return; // a live fixer is covering this gate — the good dedup

  // Claim the dedup slot BEFORE firing (anti double-fire across ticks): a concurrent
  // tick now sees a fresh `at` with no spawn id → fixerAlive=null → covered → skips.
  // The spawn id is patched in after the fire below.
  const notifiedAt = decision.notify ? now : (lf?.notifiedAt ?? null);
  const writeRecord = (rec: ReleaseFixerRecord): Promise<unknown> =>
    sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
      [ctx.installSlug, JSON.stringify({ last_fixer: rec })],
    );
  await writeRecord({ signature, candidate, at: now, spawnId: null, runId: null, notifiedAt: notifiedAt ?? undefined });

  // P-003: a user-facing notification (native OS notification on desktop, mobile push).
  // Rate-limited by decision.notify so an hourly self-heal re-dispatch doesn't spam.
  if (decision.notify) {
    try {
      const { notifyAttention } = await import('../../attention-notify');
      const selfHeal = decision.reason === 'self-heal';
      await notifyAttention({
        kind: 'intervention',
        title: selfHeal ? 'Release gate still held — prior fixer died, re-dispatched' : 'Release gate held — staging→main blocked',
        body:
          `green-checkpoint couldn't promote candidate ${candidate.slice(0, 8)} (gate red${failingTests && failingTests.length > 0 ? `: ${failingTests.slice(0, 5).join(', ')}` : ''}); ` +
          `${selfHeal ? 'the previous release-fixer ended without clearing it — a fresh one was' : 'a release-fixer was'} dispatched to diagnose it.`,
        importance: 'high',
        workspaceId: ctx.workspaceId,
        data: { candidate: candidate.slice(0, 12), failing: (failingTests ?? []).slice(0, 10).join(','), selfHeal: String(selfHeal) },
      });
    } catch (e) {
      console.warn(`[green-checkpoint] release-red notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // P-006/P-014: fire the release-fixer via the canonical spawn-recording, DBOS-durable
  // path (fireLaunchBlueprintForEvent) so the fixer is liveness-trackable + survives a crash.
  const { fireLaunchBlueprintForEvent } = await import('../../blueprint/launch-blueprint');
  let fired: Awaited<ReturnType<typeof fireLaunchBlueprintForEvent>> = null;
  try {
    fired = await fireLaunchBlueprintForEvent('green-checkpoint:red', {
      installSlug: ctx.installSlug,
      workspaceId: ctx.workspaceId,
      kickoff: `green-checkpoint held \`main\`: candidate ${candidate.slice(0, 8)} failed the gate suite. Read the newest ~/.papercusp/checkpoint-logs/*.log, reproduce the failing test(s) locally to classify regression-vs-flake, then fix the code or de-flake (hermetic > tier-out > accountable quarantine). Do NOT push — the next checkpoint re-verifies.`,
      extra: ['--green-checkpoint-red', JSON.stringify({ candidate })],
      // P-010: the fixer's reproduce→classify→fix loop (maxTurns 30) needs far more than
      // the old 280s; the invoke-route ceiling is 1200s. 900s. The liveness-aware dedup
      // re-dispatches promptly if this fixer dies, so a long timeout is no longer a 2h gap.
      timeoutMs: 900_000,
    });
  } catch (e) {
    console.warn(`[green-checkpoint] release-fixer fire failed: ${e instanceof Error ? e.message : e}`);
  }
  // Patch the recorded fixer's spawn id so the NEXT tick can check ITS liveness (D-009).
  const spawnId = fired?.spawn?.spawnId ?? null;
  const runId = fired?.spawn?.runId ?? null;
  if (spawnId || runId) {
    await writeRecord({ signature, candidate, at: now, spawnId, runId, notifiedAt: notifiedAt ?? undefined }).catch(() => {});
  }
  await appendPipelineEvent({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    kind: 'release_fixer',
    status: fired ? 'ok' : 'failed',
    detail: { candidate: candidate.slice(0, 12), reason: decision.reason, spawnId: spawnId ?? undefined },
  }).catch(() => {});
}

/** The fixed transient-unit name for the detached auto-deploy — fixed on
 *  purpose: systemd-run refuses a second unit with the same name while one is
 *  active, which is exactly the dedup we want across trigger ticks. */
export const AUTO_DEPLOY_UNIT = 'papercup-auto-deploy';

/** The subset of the deploy plan (deploy.ts `DeployPlan`, emitted as JSON by
 *  `deploy-cli`) that the auto-serve gate reads. */
export interface AutoServePlan {
  targetSha?: string;
  currentReleaseSha?: string | null;
  isFastForward?: boolean;
  commits?: string[];
  noop?: boolean;
  /** Every changed path in this plan is the papercusp-desktop submodule gitlink — a
   *  shell-only pointer bump the operator deploy must skip (desktop-submodule-of-
   *  papercup-2026-06-09 D-003). Set by gatherPlan; absent on old plan JSON. */
  desktopOnly?: boolean;
}

/**
 * Auto-serve policy — may the unattended release-trigger deploy this plan?
 *
 * The trigger may ONLY advance the release checkout **forward** to a green
 * `main` that brings ≥1 NEW commit via a fast-forward (or perform the first
 * deploy, when the checkout isn't set up yet). It must NEVER act on a
 * zero-new-commit plan.
 *
 * Why this guard exists (root-caused 2026-06-07): the *detached* release
 * checkout can transiently sit AHEAD of green `main` — a
 * `chore(git-sync): auto-commit` lands in it during a deploy / green-checkpoint
 * race — so `currentReleaseSha !== targetSha` (the old `noop` SHA-equality test
 * is false) while `commits` is empty and `isFastForward` is false. The old gate
 * (`if (plan.noop) return`) missed exactly this case and redeployed a plan that
 * applies ZERO commits, which reverts the checkout BACKWARD; the next git-sync
 * tick re-advances it → an infinite redeploy storm, each iteration
 * HARD-RESTARTING the `:3070` operator and dropping in-flight MCP/HTTP requests.
 * Forward-only + non-empty + fast-forward is the structural fix. A
 * backward / lateral / non-FF move is a deliberate rollback (`rollback.ts`) or a
 * reviewed forced deploy (`deploy-cli --force`), never auto-serve.
 *
 * Also skips a DESKTOP-ONLY pointer bump (desktop-submodule-of-papercup-2026-06-09
 * D-003): once papercusp-desktop is a submodule, every desktop edit bumps the
 * superproject `papercusp-desktop` gitlink → FFs onto green `main`. Without this guard
 * a shell-only change would drain + restart the live `:3070` operator (which never
 * builds or uses the desktop). A forced/manual `deploy-cli --execute` still can.
 */
export function shouldAutoServe(plan: AutoServePlan): boolean {
  // First deploy — the release checkout isn't set up yet → establish it.
  if (plan.currentReleaseSha === null) return true;
  // Malformed/absent field → conservative: don't deploy.
  if (typeof plan.currentReleaseSha !== 'string') return false;
  if (plan.noop === true) return false;
  // D-003: a desktop-only pointer bump doesn't touch the operator — don't
  // auto-redeploy :3070 for a shell-only change.
  if (plan.desktopOnly === true) return false;
  // Forward-only: a genuine fast-forward bringing ≥1 NEW commit. A 0-commit or
  // non-FF plan means the checkout is AT or AHEAD of `main` → never redeploy.
  return plan.isFastForward === true && Array.isArray(plan.commits) && plan.commits.length > 0;
}

/** P-013 back-off window: how long after a failed/rolled-back deploy of a target we
 *  refuse to re-attempt the SAME target. */
const DEPLOY_BACKOFF_MS = 60 * 60_000;

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DeployEventRow {
  status: string;
  detail: Record<string, unknown> | string | null;
  created_at: Date | string;
}

/**
 * P-013 pure decision: given the MOST-RECENT deploy event, should we skip re-attempting
 * `targetSha`? A deploy that fails/rolls-back reverts the release checkout BACKWARD, so
 * the next 15-min trigger sees green `main` still ahead and redeploys the SAME broken
 * target — draining + restarting :3070 every tick (2026-06-09 13:31–14:00: three
 * rolled-back retries of one broken green). True iff that event was a failure/rollback of
 * the SAME target within DEPLOY_BACKOFF_MS of `nowMs`. A new green (different sha) or the
 * window elapsing clears the back-off. Exported for unit testing.
 */
export function shouldBackOff(latest: DeployEventRow | null, targetSha: string, nowMs: number, backoffMs: number = DEPLOY_BACKOFF_MS): boolean {
  if (!latest || (latest.status !== 'failed' && latest.status !== 'rolled-back')) return false;
  const detail = typeof latest.detail === 'string' ? safeJson(latest.detail) : latest.detail ?? {};
  const lastTarget = String((detail as Record<string, unknown>).targetSha ?? ''); // stored sliced(0,12)
  const ageMs = nowMs - new Date(latest.created_at).getTime();
  return lastTarget.length > 0 && targetSha.startsWith(lastTarget) && ageMs < backoffMs;
}

/** DB glue over shouldBackOff — reads the latest deploy event; never blocks a deploy on a
 *  stats-read failure (fail-open). */
async function recentDeployFailedFor(slug: string, targetSha: string): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT status, detail, created_at FROM harness_shared.pipeline_events
        WHERE install_slug = $1 AND kind = 'deploy'
        ORDER BY created_at DESC LIMIT 1`,
      [slug],
    )) as DeployEventRow[];
    return shouldBackOff(rows[0] ?? null, targetSha, Date.now(), releaseCheckpointConfig().deployBackoffMs);
  } catch {
    return false;
  }
}

/**
 * system:release-trigger — AUTO-SERVE (staging-branch-pipeline-2026-06-06 D-002):
 * when green `main` is ahead of what the operator runs, launch the SCRIPTED
 * deploy. The green gate is the go/no-go; deploy-cli's mechanics carry drain +
 * snapshot + migrate + restart + health-check + auto-rollback, and deploy.ts
 * records the `deploy` pipeline event itself.
 *
 * The deploy is launched as a DETACHED transient systemd unit, NOT a child of
 * this host: the deploy restarts the very host this routine runs in, so a child
 * deploy-cli dies at its own restart step — the 2026-06-06 10:31 auto-deploy
 * lost its health probe, AUTO-ROLLBACK, broadcast and event exactly that way
 * (swap+migrate land before restart, which is why it half-worked). A transient
 * unit survives the restart and completes the whole lifecycle.
 */
registerSystemAction('release-trigger', async (ctx: SystemActionCtx) => {
  // per-hive-git-and-release-gate-2026-06-29 (D-001): per-hive AUTO-DEPLOY (leg 3) is
  // DEFERRED — the systemd unit (AUTO_DEPLOY_UNIT) + health probe below are operator-home-
  // specific. A non-home release-trigger only exists if a hive declared releaseGate.deploy
  // and opted in; guard it to a NO-OP so it can NEVER run the papercusp deploy for another
  // hive. When per-hive deploy lands, resolve a per-hive deploy target here instead.
  const { operatorHomeHarnessSlug } = await import('../operator-home-harness');
  if (ctx.installSlug && ctx.installSlug !== operatorHomeHarnessSlug()) {
    console.warn(
      `[release-trigger] per-hive auto-deploy not yet supported (${ctx.installSlug}) — skipping (leg-3 deferred, D-001)`,
    );
    return;
  }
  const root = integrationRoot();
  // Cheap, side-effect-free: is there anything green to deploy?
  const plan = await runScript(root, 'apps/operator/lib/release/deploy-cli.ts', [], 60_000);
  // P-008: parse the delimited plan marker, not a brace-slice of all stdout.
  const parsedPlan = parseMarkerLine(plan.stdout, DEPLOY_PLAN_MARKER) as { plan?: AutoServePlan } | null;
  if (!parsedPlan) {
    console.warn('[release-trigger] could not parse deploy plan marker — skipping this tick');
    return;
  }
  const planObj: AutoServePlan | null = parsedPlan.plan ?? null;
  // Forward-only auto-serve: only advance to a green `main` that brings ≥1 new
  // commit via a fast-forward (or the first deploy). Skips the
  // checkout-at/ahead-of-main case that previously storm-redeployed :3070 — see
  // `shouldAutoServe`.
  if (!planObj || !shouldAutoServe(planObj)) return;

  // P-013: don't storm-redeploy a target that just failed/rolled-back — wait for a new
  // green (different sha) or the back-off window. This is what stops the every-15-min
  // retry of a broken green from draining + restarting the live operator each tick.
  if (typeof planObj.targetSha === 'string' && (await recentDeployFailedFor(ctx.installSlug, planObj.targetSha))) {
    console.warn(
      `[release-trigger] target ${planObj.targetSha.slice(0, 12)} failed/rolled-back within ${DEPLOY_BACKOFF_MS / 60_000}m — backing off (awaiting a new green or the window)`,
    );
    return;
  }

  const targetSha = typeof planObj.targetSha === 'string' ? planObj.targetSha.slice(0, 12) : '?';
  const commits = Array.isArray(planObj.commits) ? planObj.commits.length : '?';
  console.log(`[release-trigger] green main is ahead — launching detached auto-deploy of ${targetSha} (${commits} commit(s)) as ${AUTO_DEPLOY_UNIT}`);

  // PAPERCUSP_ALLOW_DEV_RESTART=1: the restart step is env-gated against ad-hoc
  // runs restarting the shared host — this routine IS the owner-authorized
  // auto-serve path (D-002), so it self-authorizes. Fire-and-forget: the
  // outcome is reported by deploy.ts (broadcast + pipeline event + awaitable
  // release:deployed/deploy-failed), not by this (about-to-be-restarted) host.
  await new Promise<void>((resolve) => {
    const child = spawn('systemd-run', [
      '--user',
      '--collect',
      `--unit=${AUTO_DEPLOY_UNIT}`,
      `--working-directory=${root}`,
      // EI-193: a transient unit inherits the systemd USER-MANAGER environment,
      // NOT this process's — and after a reboot the manager PATH is the bare
      // default (no linuxbrew/nvm node), so a bare `npx` dies with exit 127
      // and auto-deploy silently stops (observed 2026-06-09: every deploy
      // tick 127'd until a manual `systemctl --user import-environment PATH`).
      // Pass THIS operator's PATH (it found node) + use the absolute tsx bin
      // (same resolution as runScript) so the unit never depends on the
      // manager environment. PATH is still needed: tsx's shebang is
      // `#!/usr/bin/env node`.
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      'bash',
      '-c',
      // P-014: `>` (truncate), not `>>` — each deploy's log is self-contained, so the
      // file can't grow unbounded; the durable record is pipeline_events + the journal.
      `PAPERCUSP_ALLOW_DEV_RESTART=1 PAPERCUSP_INTEGRATION_ROOT='${root}' '${tsxBin(root)}' apps/operator/lib/release/deploy-cli.ts --execute > /tmp/${AUTO_DEPLOY_UNIT}.log 2>&1`,
    ]);
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      console.warn(`[release-trigger] failed to launch ${AUTO_DEPLOY_UNIT}: ${e instanceof Error ? e.message : e}`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Most common cause: the unit already exists = a deploy is in flight.
        console.warn(`[release-trigger] systemd-run exited ${code} (deploy already running?): ${stderr.trim().slice(0, 200)}`);
      }
      resolve();
    });
  });
});
