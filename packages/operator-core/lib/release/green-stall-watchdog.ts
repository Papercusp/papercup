/**
 * green-stall-watchdog — EI-455 bug #2: a "no green verdict in N hours" /
 * "green-checkpoint stopped firing" alarm that runs INDEPENDENTLY of the
 * green-checkpoint routine.
 *
 * THE GAP: the in-routine stall detector (`trackGateStall` in
 * harness/routines/release-actions.ts) fires only when green-checkpoint
 * produces a verdict. It already catches stuck-red, no-green-while-firing
 * (>6h), and a crashing/timing-out suite (counted as a red). But it is
 * structurally BLIND to the one failure that actually bit us on 2026-06-13/19:
 * the green-checkpoint routine NOT FIRING AT ALL (the dead-executor dedup
 * wedge). When the routine never runs, `trackGateStall` never runs either —
 * `gate_health` just freezes (`consecutiveReds:0, lastGreenAt:stale,
 * stallAlerted:false`) and NOTHING alarms. `main` froze for ~23h, silently.
 *
 * THE FIX: a process-level watcher — deliberately NOT a DBOS routine, for the
 * same reason the dead-executor reaper isn't one: a routine-based watchdog
 * would queue on the very engine that wedges, so it couldn't fire when most
 * needed. This runs in the operator process, independent of the routine
 * engine, and alarms on EITHER:
 *   1. fire-staleness  — an ACTIVE green-checkpoint routine whose `last_fired_at`
 *      is older than FIRE_STALE_MS (cron is hourly, so ~3 missed fires ⇒ the
 *      scheduler isn't running it). This is the novel signal the in-routine
 *      detector cannot see.
 *   2. verdict-staleness — no GREEN verdict (`lastGreenAt`) in NO_GREEN_MS
 *      (12h). A deep backstop, set well past the in-routine 6h alarm so the two
 *      don't double-ping in the overlap; this only trips if the in-routine path
 *      somehow failed to alarm too.
 *
 * It reuses the exact alarm surfaces of the in-routine detector — an urgent
 * `notifyAttention` + a durable `harness_escalations` row — under its OWN phase
 * (`green-checkpoint-watchdog`) and its OWN dedup flag (`watchdogAlerted`) so it
 * never clobbers the in-routine `green-checkpoint-stall` row/flag. Both can
 * coexist; in the wedge case only the watchdog can fire. Recovery (the routine
 * fires + greens again) clears the flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_GREEN_STALL_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { execFileSync } from 'node:child_process';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolved } from '../severe-event-broadcast';
import { readRoutineEngineLiveness } from './routine-engine-liveness';
import { resolveWorkspaceForHarness } from '../harness/workspace-for-harness';

/** An ACTIVE green-checkpoint that hasn't FIRED in this long ⇒ the scheduler isn't
 *  running it (cron is hourly at :15, so this is ~3 missed fires). */
const DEFAULT_FIRE_STALE_MS = 3 * 60 * 60 * 1000; // 3h
/** No GREEN verdict in this long ⇒ alarm. A deep backstop past the in-routine 6h
 *  alarm (STALL_AGE_MS) so the two detectors don't double-ping. */
const DEFAULT_NO_GREEN_MS = 12 * 60 * 60 * 1000; // 12h
/** How often the watchdog sweeps. green-checkpoint is hourly, so 15m is ample. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/** EI-9762: `main` can fall behind `staging` for hours WITHOUT tripping either
 *  alarm above — the routine keeps firing (fireStale stays false) and each fire
 *  keeps producing a verdict, just a RED one (verdictStale's 12h backstop only
 *  fires on the ABSENCE of green, not on main failing to advance). A run can also
 *  be externally killed (SIGKILL) before it ever writes a verdict at all — same
 *  blind spot. Both leave `main` frozen with nothing watching it: the 2026-07-11
 *  incident sat ~4.8h/56 commits behind before the OWNER had to ask. This is a
 *  DIFFERENT, tighter, more direct signal than the 12h no-green backstop: it
 *  doesn't care why main isn't advancing (red suite, killed run, wedged engine),
 *  only that staging has pulled meaningfully ahead for meaningfully long. */
const DEFAULT_MAIN_BEHIND_COMMITS = 20;
const DEFAULT_MAIN_BEHIND_MS = 60 * 60 * 1000; // 1h — deliberately far tighter than the 12h verdict-stale backstop
const MAIN_BEHIND_PHASE = 'main-behind-staging-watchdog';

/** Phase + kind for the durable escalation — distinct from the in-routine
 *  `green-checkpoint-stall` so the two never clobber each other. */
const WATCHDOG_PHASE = 'green-checkpoint-watchdog';
const WATCHDOG_KIND = 'green-checkpoint-watchdog';

export interface GreenStallThresholds {
  fireStaleMs?: number;
  noGreenMs?: number;
}

/** The bits of one green-checkpoint routine row the verdict is computed from. */
export interface GreenStallSnapshot {
  /** epoch ms of the routine's last fire (`last_fired_at`), or null if never fired. */
  lastFiredMs: number | null;
  /** epoch ms of the last green verdict (`gate_health.lastGreenAt`), or null. */
  lastGreenAt: number | null;
  /** the watchdog's own dedup flag (`gate_health.watchdogAlerted`). */
  watchdogAlerted: boolean;
  /** The root routine engine is stale; infra-liveness owns this root-cause alarm. */
  routineEngineStale?: boolean;
  /** EI-7505: the failing verdict test(s) from the last red green-checkpoint tick
   *  (`gate_health.failingTests`, threaded through by `trackGateStall` in
   *  release-actions.ts), when the stall is verdict-staleness (a failing suite)
   *  rather than fire-staleness (the routine engine not running). Absent/empty
   *  when the stall is fire-stale or the field predates this fix. */
  failingTests?: string[];
}

export interface GreenStallVerdict {
  stalled: boolean;
  /** the routine is active but hasn't fired in fireStaleMs (the scheduler is wedged). */
  fireStale: boolean;
  /** no green verdict in noGreenMs (the deep backstop). */
  verdictStale: boolean;
  /** human reason for the alarm body, or null when not stalled. */
  reason: string | null;
}

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Pure: decide whether one ACTIVE green-checkpoint routine is in a silent stall
 * the in-routine detector cannot see. Exported for unit testing (the DB wiring
 * around it is integration-covered, like the reaper's live self-test).
 *
 * A never-fired routine (`lastFiredMs === null` with no `lastGreenAt`) is a fresh
 * install — no evidence it SHOULD have greened — and never alarms.
 */
export function evaluateGreenStall(
  s: GreenStallSnapshot,
  now: number,
  opts: GreenStallThresholds = {},
): GreenStallVerdict {
  const fireStaleMs = opts.fireStaleMs ?? DEFAULT_FIRE_STALE_MS;
  const noGreenMs = opts.noGreenMs ?? DEFAULT_NO_GREEN_MS;

  // EI-2994: when the root DBOS routinesTick is stale, green-checkpoint not
  // firing is a downstream symptom. The request-path infra-liveness alarm owns
  // the single "background routine engine frozen" escalation and auto-resolves
  // it; suppress this symptom-level alarm to avoid a restart cascade being
  // triaged as independent release failures. Unknown liveness is fail-open.
  const rootEngineStale = s.routineEngineStale === true;
  const fireStale = !rootEngineStale && s.lastFiredMs != null && now - s.lastFiredMs > fireStaleMs;
  const verdictStale = !rootEngineStale && s.lastGreenAt != null && now - s.lastGreenAt > noGreenMs;
  const stalled = fireStale || verdictStale;

  let reason: string | null = null;
  if (stalled) {
    const parts: string[] = [];
    if (fireStale && s.lastFiredMs != null) {
      parts.push(
        `the routine has not FIRED in ~${hrs(now - s.lastFiredMs)}h (active, cron hourly) — the routine scheduler/engine is not running it`,
      );
    }
    if (verdictStale && s.lastGreenAt != null) {
      parts.push(`no GREEN verdict in ~${hrs(now - s.lastGreenAt)}h`);
    }
    reason = parts.join('; ');
    // EI-7505: name the failing test(s) directly in the alarm reason so a
    // responder doesn't have to hand-spelunk harness_shared.test_runs (which
    // mixes every agent's local dev-test runs with the verdict run and is
    // inconclusive) just to start diagnosing a verdict-staleness stall.
    const tests = (s.failingTests ?? []).slice(0, 20);
    if (tests.length) {
      reason += `. Failing verdict test(s): ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}`;
    }
  }
  return { stalled, fireStale, verdictStale, reason };
}

/** Pure: the `harness_escalations` body for a watchdog-detected stall (testable). */
export function greenStallEscalationBody(opts: {
  installSlug: string;
  verdict: GreenStallVerdict;
  lastFiredMs: number | null;
  lastGreenAt: number | null;
  nowMs: number;
  /** EI-7505: gate_health.failingTests, when available (verdict-staleness only). */
  failingTests?: string[];
}): string {
  return JSON.stringify({
    kind: WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    fireStale: opts.verdict.fireStale,
    verdictStale: opts.verdict.verdictStale,
    lastFiredAt: opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : null,
    lastGreenAt: opts.lastGreenAt != null ? new Date(opts.lastGreenAt).toISOString() : null,
    failingTests: (opts.failingTests ?? []).slice(0, 20),
    emitted_at: opts.nowMs,
    // `verdict.reason` already carries the failing-test suffix (EI-7505) when present.
    detail: `green-checkpoint silent stall (watchdog): ${opts.verdict.reason}. ` +
      `\`main\` is frozen and the in-routine stall detector cannot see this (it runs only when the routine fires). ` +
      `The dead-executor reaper should auto-recover a wedge; if this persists the bg-host / DBOS engine needs a look.`,
  });
}

export interface GreenStallWatchdogResult {
  /** install slugs that crossed into a stall this pass (one-shot, deduped). */
  alarmed: string[];
  /** install slugs whose prior stall recovered this pass. */
  recovered: string[];
}

/**
 * One watchdog pass: scan every ACTIVE green-checkpoint routine, alarm once per
 * stall transition (cross-process exactly-once via a conditional flag flip), and
 * clear the flag + escalation on recovery. Never throws — it rides boot + an
 * interval and must not break either.
 */
export async function checkGreenStall(
  sql: Sql,
  opts: GreenStallThresholds = {},
): Promise<GreenStallWatchdogResult> {
  const out: GreenStallWatchdogResult = { alarmed: [], recovered: [] };
  try {
    const rows = await sql<
      {
        install_slug: string;
        workspace_id: string;
        last_fired_ms: string | number | null;
        gh: { lastGreenAt?: number; watchdogAlerted?: boolean; failingTests?: string[] } | null;
      }[]
    >`
      SELECT install_slug,
             workspace_id,
             extract(epoch from last_fired_at) * 1000 AS last_fired_ms,
             metadata->'gate_health' AS gh
        FROM harness_shared.routines
       WHERE target_role = 'system:green-checkpoint'
         AND active = true`;

    const now = Date.now();
    const routineEngine = await readRoutineEngineLiveness(sql, { nowMs: now });
    for (const row of rows) {
      const lastFiredMs = row.last_fired_ms != null ? Number(row.last_fired_ms) : null;
      const lastGreenAt = row.gh?.lastGreenAt ?? null;
      const watchdogAlerted = row.gh?.watchdogAlerted ?? false;
      // EI-7505: gate_health.failingTests, threaded through by trackGateStall
      // (release-actions.ts) on the last red green-checkpoint tick.
      const failingTests = row.gh?.failingTests ?? [];
      const verdict = evaluateGreenStall({ lastFiredMs, lastGreenAt, watchdogAlerted, routineEngineStale: routineEngine.stale, failingTests }, now, opts);

      if (verdict.stalled) {
        if (watchdogAlerted) continue; // already alarmed; one-shot until recovery
        // Cross-process exactly-once: only the writer that flips watchdogAlerted
        // false→true gets to alarm. jsonb_set merges into the existing gate_health
        // so we never drop consecutiveReds/lastGreenAt/etc.
        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   COALESCE(metadata, '{}'::jsonb),
                   '{gate_health}',
                   COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":true}'::jsonb
                 ),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:green-checkpoint'
             AND COALESCE((metadata->'gate_health'->>'watchdogAlerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'Release pipeline STALLED — green-checkpoint not producing greens',
            body: `green-checkpoint (${row.install_slug}) silent stall: ${verdict.reason}. \`main\` is frozen and the per-verdict detector can't see this. The dead-executor reaper should auto-recover a wedge; manual help may be needed if it persists.`,
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: { fireStale: verdict.fireStale, verdictStale: verdict.verdictStale },
          });
        } catch (e) {
          console.warn(`[green-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        // Fleet broadcast (owner-requested): inject-only (wake=false) so every running agent
        // sees it next turn and someone can claim greening the gate, without a wake storm.
        await broadcastSevereEvent({
          summary: `green-checkpoint STALLED on ${row.install_slug} — no green verdicts; deploys frozen.`,
          body:
            `${verdict.reason}\n\nThe release gate isn't producing greens, so nothing new can deploy. ` +
            `Claim it: fire-staleness ⇒ the routine engine/DBOS is wedged (a reaper should recover; ` +
            `manual help if it persists); verdict-staleness ⇒ a failing suite. release:checkpoint-run ` +
            `forces a fresh gate run.`,
          category: 'severe-event',
          // WI-1444 condition lifecycle: recovery below broadcasts the matching
          // resolution, so late inbox readers see this alarm annotated resolved.
          conditionKey: `green-stall:${row.install_slug}`,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${WATCHDOG_PHASE}, ${greenStallEscalationBody({
              installSlug: row.install_slug,
              verdict,
              lastFiredMs,
              lastGreenAt,
              nowMs: now,
              failingTests,
            })}, ${now}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[green-stall-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[green-stall-watchdog] ALARM ${row.install_slug}: ${verdict.reason}`);
      } else {
        // Healthy. Clear the watchdog flag (a green verdict already wipes gate_health,
        // so this is belt-and-suspenders) and the escalation row, both idempotently.
        if (watchdogAlerted) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{gate_health}',
                     COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":false}'::jsonb
                   ),
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:green-checkpoint'`;
        }
        // Independent of the flag: a green-verdict wipe can clear watchdogAlerted while
        // leaving our escalation row, so always run the idempotent clear (no-op when null).
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (cleared.count === 1 || watchdogAlerted) {
          // WI-1444: supersede the fleet alarm — coord:inbox annotates every prior
          // `green-stall:<slug>` broadcast resolved, so a late reader never chases
          // a gate stall that already cleared. Guarded on the same transition edge
          // as `recovered` so a routinely-healthy pass broadcasts nothing.
          await broadcastSevereEventResolved({
            conditionKey: `green-stall:${row.install_slug}`,
            summary: `green-checkpoint RECOVERED on ${row.install_slug} — the gate is producing verdicts again; the earlier stall alarm is stale.`,
          });
          out.recovered.push(row.install_slug);
        }
      }
    }
    return out;
  } catch (e) {
    console.warn(`[green-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

// ── main-behind-staging guard (EI-9762) ────────────────────────────────────────

export interface MainBehindStagingSnapshot {
  /** `git rev-list --count <mainBranch>..<stagingBranch>` — null if unresolvable
   *  (e.g. a branch missing in a fresh/partial checkout — fail-open, never alarm). */
  commitsBehind: number | null;
  /** How long `staging` has been ahead of `main` by at least one commit — the age
   *  (ms) of the OLDEST commit reachable from staging but not main. null if
   *  commitsBehind is 0/null. This is the "~4.8h" half of the EI-9762 signal. */
  behindMs: number | null;
}

export interface MainBehindStagingVerdict {
  stalled: boolean;
  reason: string | null;
}

/** Pure: decide whether `main`'s lag behind `staging` has crossed from "normal
 *  promotion latency" into "the gate stopped advancing main" — BOTH thresholds
 *  must trip (a lot of commits queued up in the last few minutes is normal
 *  churn; a small lag sitting there for hours is also normal on a quiet day).
 *  Exported for unit testing. */
export function evaluateMainBehindStaging(
  s: MainBehindStagingSnapshot,
  opts: { commitsThreshold?: number; msThreshold?: number } = {},
): MainBehindStagingVerdict {
  const commitsThreshold = opts.commitsThreshold ?? DEFAULT_MAIN_BEHIND_COMMITS;
  const msThreshold = opts.msThreshold ?? DEFAULT_MAIN_BEHIND_MS;
  if (s.commitsBehind == null || s.behindMs == null) return { stalled: false, reason: null };
  const stalled = s.commitsBehind > commitsThreshold && s.behindMs > msThreshold;
  if (!stalled) return { stalled: false, reason: null };
  const hoursBehind = (s.behindMs / 3_600_000).toFixed(1);
  return {
    stalled: true,
    reason:
      `\`main\` is ${s.commitsBehind} commits / ~${hoursBehind}h behind \`staging\` — the gate is not advancing main, ` +
      `regardless of why (red verdicts, a killed/wedged run, or a wedged routine engine). Fire a fresh gate run ` +
      `(release:checkpoint-run) and find + fix whatever is actually failing/blocking it.`,
  };
}

function gitOut(root: string, args: string[]): string | null {
  try {
    // EI-9922 (EI-8794 class): a failing git call — e.g. this watchdog's boot pass
    // running in a PACKAGED install's non-repo dir — must NOT leak "fatal: not a git
    // repository" onto the parent's own stderr/serve.log. `execFileSync`'s default
    // stdio inherits the child's stderr; pin it to ['ignore','pipe','ignore'] so we
    // capture stdout but discard stderr (mirrors build-info.ts / workspace-map.ts).
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Reads the live commits-behind + how-long-behind gap between `main` and
 *  `staging` in `root` via plain git shell-outs — deliberately NOT importing
 *  from apps/operator/lib/release/* (wrong dependency direction for
 *  operator-core; mirrors dev-deploy-state.ts's own self-contained pattern).
 *  Fails open (all-null) on any git error — a missing branch/checkout must
 *  never itself trigger the alarm it's trying to compute. */
export function computeMainBehindStaging(
  root: string,
  mainBranch = 'main',
  stagingBranch = 'staging',
): MainBehindStagingSnapshot {
  const countRaw = gitOut(root, ['rev-list', '--count', `${mainBranch}..${stagingBranch}`]);
  const commitsBehind = countRaw != null && /^\d+$/.test(countRaw) ? Number(countRaw) : null;
  if (commitsBehind == null || commitsBehind === 0) return { commitsBehind: commitsBehind ?? null, behindMs: null };

  // The OLDEST commit reachable from staging but not main — its age is how
  // long main has been behind by at least this much (a fresh-only lag from
  // commits landing in the last minute reads as ~0, not an hours-old stall).
  const oldestTsRaw = gitOut(root, [
    'log',
    `${mainBranch}..${stagingBranch}`,
    '--format=%ct',
    '--reverse',
  ]);
  const oldestTs = oldestTsRaw ? Number(oldestTsRaw.split('\n')[0]) : NaN;
  if (!Number.isFinite(oldestTs)) return { commitsBehind, behindMs: null };
  return { commitsBehind, behindMs: Math.max(0, Date.now() - oldestTs * 1000) };
}

/** One watchdog pass for the main-behind-staging guard, scoped to a single git
 *  root (the operator's own home harness — this is a local-git-tree signal,
 *  not a per-tenant DB one, so it does not loop over `harness_shared.routines`
 *  the way `checkGreenStall` does). Reuses the exact alarm plumbing
 *  (notifyAttention + broadcastSevereEvent + harness_escalations) under its OWN
 *  phase so it never clobbers either of the other two conditions' dedup state.
 *  Dedup is the escalation row's own presence — no gate_health flag needed.
 *  Never throws — rides the same interval as checkGreenStall and must not
 *  break it. */
export async function checkMainBehindStaging(
  sql: Sql,
  opts: {
    root?: string;
    harnessSlug?: string;
    workspaceId?: string;
    commitsThreshold?: number;
    msThreshold?: number;
    mainBranch?: string;
    stagingBranch?: string;
  } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  try {
    const root =
      opts.root ??
      process.env.PAPERCUSP_INTEGRATION_ROOT ??
      gitOut(process.cwd(), ['rev-parse', '--show-toplevel']) ??
      process.cwd();
    const harnessSlug = opts.harnessSlug ?? 'papercusp';
    const snapshot = computeMainBehindStaging(root, opts.mainBranch, opts.stagingBranch);
    const verdict = evaluateMainBehindStaging(snapshot, opts);

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${harnessSlug} AND phase = ${MAIN_BEHIND_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.stalled) {
      if (alreadyAlarmed) return out; // one-shot until recovery, like checkGreenStall
      // EI-10103: harness_escalations.workspace_id is NOT NULL (default ''); this check is
      // single-harness-scoped (unlike checkGreenStall's per-tenant `routines` scan, which
      // gets a real workspace_id off each row) and had no caller ever pass opts.workspaceId,
      // so the insert below explicitly wrote NULL — bypassing the column default (a default
      // only applies when the column is OMITTED, not when it's explicitly set to NULL) and
      // violating the not-null constraint on every real stall, silently swallowed by this
      // function's own outer catch (the watchdog that should escalate a promotion stall
      // could never actually write its escalation). Resolve the real workspace the harness
      // lives in, lazily (only on an actual stall, not every quiet pass); never let a
      // resolution failure block the escalation itself (an empty string falls back to
      // exactly what the column's own default would have been for an unresolvable harness).
      const workspaceId =
        opts.workspaceId ??
        (await resolveWorkspaceForHarness(harnessSlug).catch((e) => {
          console.warn(
            `[main-behind-staging-watchdog] workspace resolution failed for '${harnessSlug}': ${e instanceof Error ? e.message : e}`,
          );
          return '';
        }));
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline STALLED — main is falling behind staging',
          body: verdict.reason ?? '',
          importance: 'urgent',
          workspaceId,
          data: { commitsBehind: snapshot.commitsBehind, behindMs: snapshot.behindMs },
        });
      } catch (e) {
        console.warn(`[main-behind-staging-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `main is ${snapshot.commitsBehind} commits behind staging on ${harnessSlug} — promotion pipeline stalled.`,
        body: verdict.reason ?? '',
        category: 'severe-event',
        conditionKey: `main-behind-staging:${harnessSlug}`,
      });
      await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${harnessSlug}, ${MAIN_BEHIND_PHASE}, ${JSON.stringify({
          kind: MAIN_BEHIND_PHASE,
          harness_slug: harnessSlug,
          commitsBehind: snapshot.commitsBehind,
          behindMs: snapshot.behindMs,
          detail: verdict.reason,
          emitted_at: Date.now(),
        })}, ${Date.now()}, ${workspaceId})
        ON CONFLICT (harness_slug, phase)
        DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      out.alarmed = true;
      console.warn(`[main-behind-staging-watchdog] ALARM ${harnessSlug}: ${verdict.reason}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${Date.now()}
         WHERE harness_slug = ${harnessSlug} AND phase = ${MAIN_BEHIND_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `main-behind-staging:${harnessSlug}`,
        summary: `main RECOVERED on ${harnessSlug} — no longer meaningfully behind staging; the earlier stall alarm is stale.`,
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    console.warn(`[main-behind-staging-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep.
 * Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_GREEN_STALL_WATCHDOG='0'. The timer is unref'd so it never keeps the
 * process alive on shutdown.
 */
export function startGreenStallWatchdog(
  sql: Sql,
  opts: GreenStallThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_GREEN_STALL_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkGreenStall(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[green-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
    // EI-9762: independent of the above — see checkMainBehindStaging's own doc
    // for why this can't share its DB-row loop. Failure here must never affect
    // the check above (each is wrapped/caught independently).
    void checkMainBehindStaging(sql);
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('green-stall-watchdog', intervalMs, run, { category: 'watchdog' });
}
