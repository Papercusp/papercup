/**
 * `system:gitnexus-reindex` — the refresh owner for the gitnexus code graph (WI-6454).
 *
 * WHY THIS EXISTS. `gitnexus.context` / `gitnexus.query` answer "where is this symbol
 * defined, and who calls it" from a knowledge graph built by `gitnexus analyze`. That
 * graph was built BY HAND once (2026-07-27) and nothing refreshed it, so it began
 * decaying immediately on a tree where git-sync commits every few minutes. A definition
 * lookup against a stale graph silently returns a symbol that has moved — or misses one
 * that is new — and the caller cannot tell which happened. That unowned decay is what
 * pins the `code-search.definition-lookup` substitution pair at `observe`
 * (`lib/bash-substitution/pairs/code-search.ts`).
 *
 * WHY A GATED HOURLY TICK RATHER THAN A PLAIN CRON. `analyze` is NOT incremental — the
 * CLI self-describes as "Index a repository (full analysis)", and it was measured on
 * this box at **309s cold / 234s against an already-fresh index** (an unforced re-run
 * still costs 76% of a cold build). So the cadence cannot be "run it every hour" — the
 * routine fires hourly but the EXPENSIVE part is conditional: each tick reads the
 * registry + git + loadavg (all cheap) and only then decides to spawn. `decideReindex`
 * is the whole policy, kept pure so it is testable without a 4-minute subprocess.
 *
 * ⚠ `--skip-agents-md` IS MANDATORY AND IS HARDCODED HERE ON PURPOSE. Without it,
 * `analyze` REWRITES a gitnexus section into `CLAUDE.md` and `AGENTS.md`. In this repo
 * those are prompt SOURCES spliced into every agent's context, and CLAUDE.md
 * additionally carries the generated `gen:tool-routing` table — an unguarded analyze
 * corrupts both and reds the drift check. `buildAnalyzeArgs` is the single place the
 * argv is constructed and a test asserts the flag is present, so the trap cannot be
 * re-armed by editing a call site (enforcement: structural).
 *
 * Bounded + fail-soft, mirroring cargo-test-action / p2p-perf-actions: the child is its
 * own process-group leader so a timeout SIGTERM/SIGKILLs the whole tree (npx → node →
 * tree-sitter workers), never just the wrapper, and a wedged analyze can therefore never
 * wedge the routines tick.
 */
import { spawn, execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** Registry alias this repo is indexed under (`analyze --name papercusp`). The alias
 *  disambiguates it from other checkouts on the box whose basename would collide. */
export const GITNEXUS_REPO_NAME = 'papercusp';

/** Cold build measured 309.2s; give a busy/colder box generous headroom without letting
 *  a genuinely wedged indexer hang the tick forever. */
export const GITNEXUS_ANALYZE_TIMEOUT_MS = 20 * 60_000;

/** Skip when the box is genuinely oversubscribed — load ABOVE 1.5x cores means real run-queue
 *  queueing, and a 4-minute CPU-heavy index is exactly the wrong thing to pile on. (This box
 *  is 128 cores and idles around 0.5/core, so this defers only during a real storm.) */
export const DEFAULT_MAX_LOAD_PER_CORE = 1.5;

/** Any real commit is worth refreshing for; the interval floor below is what actually
 *  bounds the cost. */
export const DEFAULT_MIN_COMMITS_BEHIND = 1;

/** Never re-index more often than this, whatever the tick says. At ~234s a run, a 45min
 *  floor caps the steady-state duty cycle at roughly 9% of one core-set. */
export const DEFAULT_MIN_INTERVAL_SEC = 45 * 60;

export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

export function registryPath(): string {
  return process.env.GITNEXUS_REGISTRY_PATH ?? path.join(os.homedir(), '.gitnexus', 'registry.json');
}

export interface GitnexusRegistryEntry {
  name: string;
  path?: string;
  lastCommit?: string;
  indexedAt?: string;
}

/**
 * Read one repo's entry out of `~/.gitnexus/registry.json`. Every failure mode — file
 * absent, unparseable, not an array, alias not present — collapses to `null`, which the
 * decision below reads as "no index" and therefore "build one". A missing registry must
 * never throw a routine tick.
 */
export function readRegistryEntry(file: string, repoName: string): GitnexusRegistryEntry | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return null;
    const hit = raw.find((e) => e && typeof e === 'object' && (e as { name?: unknown }).name === repoName);
    return (hit as GitnexusRegistryEntry | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * How many commits HEAD is ahead of the indexed commit. `null` means "unknowable" — the
 * indexed sha is no longer in this history (a rebase, a prune, a fresh clone), which the
 * decision treats as a reason to refresh rather than to skip.
 */
export function countCommitsBehind(root: string, indexedCommit: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['rev-list', '--count', `${indexedCommit}..HEAD`],
      { cwd: root, timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolvePromise(null);
        const n = Number.parseInt(String(stdout).trim(), 10);
        resolvePromise(Number.isFinite(n) ? n : null);
      },
    );
  });
}

export interface ReindexDecisionInput {
  /** Is the repo present in the gitnexus registry at all? */
  registered: boolean;
  /** Commits HEAD is ahead of the indexed sha; `null` = unknowable (see countCommitsBehind). */
  commitsBehind: number | null;
  /** 1-minute loadavg divided by core count. */
  loadPerCore: number;
  /** Age of the current index in seconds; `null` when unknown. */
  secondsSinceIndexed: number | null;
  minCommitsBehind: number;
  maxLoadPerCore: number;
  minIntervalSec: number;
}

export interface ReindexDecision {
  run: boolean;
  reason: string;
}

/**
 * The entire cadence policy, pure and order-sensitive:
 *
 *  1. LOAD FIRST — it protects the box, so it outranks even a missing index. Deferring
 *     costs one hour; piling a 4-minute indexer onto an already-queueing box costs
 *     everyone.
 *  2. NO INDEX ⇒ build. A missing graph is the WI-6445 failure mode (every lookup
 *     returns "Symbol not found" while every call still looks well-formed), so it
 *     bypasses both the interval floor and the staleness check.
 *  3. INTERVAL FLOOR — bounds steady-state cost regardless of how fast commits land.
 *  4. STALENESS — the ordinary skip: nothing changed, nothing to do.
 */
export function decideReindex(i: ReindexDecisionInput): ReindexDecision {
  if (i.loadPerCore > i.maxLoadPerCore) {
    return {
      run: false,
      reason: `box oversubscribed (load/core ${i.loadPerCore.toFixed(2)} > ${i.maxLoadPerCore}) — deferring to the next tick`,
    };
  }
  if (!i.registered) {
    return { run: true, reason: 'no gitnexus index registered for this repo — cold build' };
  }
  if (i.secondsSinceIndexed != null && i.secondsSinceIndexed < i.minIntervalSec) {
    return {
      run: false,
      reason: `indexed ${Math.round(i.secondsSinceIndexed / 60)}min ago, under the ${Math.round(i.minIntervalSec / 60)}min floor`,
    };
  }
  if (i.commitsBehind == null) {
    return { run: true, reason: 'indexed commit is not in the current history (rebase/prune) — refreshing' };
  }
  if (i.commitsBehind < i.minCommitsBehind) {
    return { run: false, reason: `only ${i.commitsBehind} commit(s) behind (floor ${i.minCommitsBehind})` };
  }
  return { run: true, reason: `${i.commitsBehind} commits behind HEAD` };
}

/**
 * The ONE place the analyze argv is built. `--skip-agents-md` is not optional and is not
 * a caller's choice — see this module's header for what happens without it.
 */
export function buildAnalyzeArgs(root: string, repoName: string): string[] {
  return ['--yes', 'gitnexus', 'analyze', root, '--skip-agents-md', '--name', repoName];
}

// ---------------------------------------------------------------------------
// CRASH-RESIDUE PREFLIGHT — one policy over the whole (db x shadow x wal) state space.
//
// `gitnexus analyze` writes a `.gitnexus/lbug.shadow` (+ `.gitnexus/lbug.wal.checkpoint`)
// WHILE building, then promotes it to the real `.gitnexus/lbug` database file on success.
// A kill anywhere in that sequence leaves residue, and the residue is UNRECOVERABLE BY
// GITNEXUS ITSELF — which turns one dead process into a permanent, self-perpetuating
// wedge, because every later tick re-runs the same doomed sequence.
//
// There are TWO such residues, one on each side of the promote, and they fail in
// OPPOSITE directions:
//
//   (a) ORPHAN SHADOW — killed BEFORE the promote: shadow present, db ABSENT.
//       `analyze` then refuses to start at all ("Found shadow file ... but no
//       corresponding database file"). Measured 2026-08-08 (WI-35532): 66/66
//       consecutive hourly ticks failed this way, ~4.6 CPU-hours burned, silently.
//
//   (b) ORPHAN WAL — killed AFTER the promote: db present, shadow ABSENT, `lbug.wal`
//       left holding pending data. `analyze` starts fine, but every READ-ONLY OPEN now
//       replays that WAL and SEGFAULTS in the native LadybugDB binding. Measured
//       2026-08-21 (D-016): the 20-minute analyze timeout SIGKILLed the process group
//       at 04:55:34Z (fire 04:35:33Z + 20m01s), and from that moment BOTH the CLI and
//       the MCP bridge child died on every call — GitNexus was 100% dead fleet-wide
//       while still advertising 17 working tools.
//
// WHY (b) NEEDED ITS OWN ARM. The original guard's predicate was `shadow && !db`, which
// is the OPPOSITE CORNER of the same 2x2 — with the shadow absent it no-ops, so the
// wedge it was written to end recurred verbatim in the direction it did not test. The
// lesson, recorded as D-016: a crash-consistency guard must cover the whole state space
// of the artifacts it protects, not the one corner that was observed failing.
//
// WHY DELETING THE WAL HERE IS SAFE, precisely. Two measured facts, not assumptions:
//   1. A healthy index carries NO wal — verified 2026-08-21 by running repeated
//      successful reads and re-listing `.gitnexus/`: only `lbug` is present, never a
//      wal. So reads never produce one, and a wal is therefore always a WRITER's
//      residue rather than ordinary steady state.
//   2. This preflight runs immediately BEFORE we spawn a full `analyze`, which rebuilds
//      the index wholesale. Any pending WAL data is about to be superseded by that
//      rebuild, so discarding it cannot lose information the next step would have used.
// A wal sitting ALONGSIDE a shadow is a build genuinely in progress and is never
// touched, which is what keeps (b) from firing on a concurrent analyze.
//
// Raising GITNEXUS_ANALYZE_TIMEOUT_MS is deliberately NOT the fix (D-016): it moves the
// cliff without removing it, and ANY SIGKILL — timeout, OOM, reboot — reproduces the
// same residue. Recovery has to be unconditional.
// ---------------------------------------------------------------------------

export interface GitnexusDbPaths {
  db: string;
  shadow: string;
  walCheckpoint: string;
  /** Pending write-ahead log. Present only while a writer is mid-flight — or as residue. */
  wal: string;
}

export function gitnexusDbPaths(root: string): GitnexusDbPaths {
  const dir = path.join(root, '.gitnexus');
  return {
    db: path.join(dir, 'lbug'),
    shadow: path.join(dir, 'lbug.shadow'),
    walCheckpoint: path.join(dir, 'lbug.wal.checkpoint'),
    wal: path.join(dir, 'lbug.wal'),
  };
}

/** PURE — killed BEFORE the promote: a shadow with no promoted database beside it. */
export function isOrphanShadow(dbExists: boolean, shadowExists: boolean): boolean {
  return shadowExists && !dbExists;
}

/**
 * PURE — killed AFTER the promote: a pending WAL beside a real database, with no shadow
 * to say a build is in flight. This is the read-path poison (D-016).
 *
 * The `!shadowExists` term is what makes this safe to act on: shadow-present means a
 * build is genuinely running and its WAL is live data, not residue.
 */
export function isOrphanWal(dbExists: boolean, shadowExists: boolean, walExists: boolean): boolean {
  return walExists && dbExists && !shadowExists;
}

export interface OrphanShadowCleanup {
  cleaned: boolean;
  removed: string[];
  /** Which residue was found, for a log line that names the failure mode rather than the files. */
  kind: 'none' | 'orphan-shadow' | 'orphan-wal';
}

/**
 * Remove whichever crash residue is present so the next `analyze` — and, for the WAL
 * arm, every read in the meantime — can proceed. No-ops when the tree is healthy or a
 * build is genuinely in progress. Never throws: a missing/racing file during unlink is
 * exactly the "someone else already cleaned it" case and is swallowed like the rest of
 * this fail-soft action.
 */
export function cleanCrashResidue(root: string): OrphanShadowCleanup {
  const { db, shadow, walCheckpoint, wal } = gitnexusDbPaths(root);
  const dbExists = existsSync(db);
  const shadowExists = existsSync(shadow);
  const walExists = existsSync(wal);

  let kind: OrphanShadowCleanup['kind'] = 'none';
  let targets: string[] = [];
  if (isOrphanShadow(dbExists, shadowExists)) {
    kind = 'orphan-shadow';
    targets = [shadow, walCheckpoint];
  } else if (isOrphanWal(dbExists, shadowExists, walExists)) {
    kind = 'orphan-wal';
    targets = [wal, walCheckpoint];
  } else {
    return { cleaned: false, removed: [], kind: 'none' };
  }

  const removed: string[] = [];
  for (const f of targets) {
    if (!existsSync(f)) continue;
    try {
      unlinkSync(f);
      removed.push(f);
    } catch {
      // Racing with another cleanup (or the file vanished between the check and the
      // unlink) — not our job to report, the residue condition is gone either way.
    }
  }
  return { cleaned: removed.length > 0, removed, kind };
}

// ---------------------------------------------------------------------------
// WI-35532 (b) — the failure alarm.
//
// This action is deliberately fail-soft (a wedged/failing indexer must never wedge the
// routines tick) and previously logged failures to journald ONLY — so a 100%-failing
// routine burning CPU every tick produced ZERO signal anywhere an owner or agent would
// see it. `decideGitnexusHealthUpdate` is the pure state machine; the handler below
// persists it into the SAME routine-metadata convention green-checkpoint's `gate_health`
// uses (`metadata->'gitnexus_health'`) and fires exactly once per failure streak — never
// once per tick — via the shared `notifyAttention` escalation rail.
// ---------------------------------------------------------------------------

export interface GitnexusHealth {
  consecutiveFailures: number;
  /** True once the streak has alerted — suppresses a re-alert on every subsequent
   *  failing tick until a success clears it (mirrors green-checkpoint's `stallAlerted`). */
  alerted: boolean;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export const GITNEXUS_HEALTH_DEFAULT: GitnexusHealth = {
  consecutiveFailures: 0,
  alerted: false,
  lastFailureAt: null,
  lastSuccessAt: null,
};

/** Alert on the 3rd consecutive failure — one bad tick can be a transient timeout; three
 *  in a row (across an hourly cadence, ~3h of silent burn) is a real, durable wedge. */
export const GITNEXUS_FAILURE_ALERT_THRESHOLD = 3;

export interface GitnexusHealthUpdate {
  next: GitnexusHealth;
  /** True on EXACTLY the tick that crosses the threshold — the caller fires the alert
   *  only then, not on every failing tick after. */
  shouldAlert: boolean;
  /** True on EXACTLY the recovery tick that follows an alerted streak — the caller
   *  resolves/logs the recovery only then. */
  shouldResolve: boolean;
}

/** PURE — the whole alarm policy, order-sensitive and independently testable from the
 *  4-minute subprocess it observes. */
export function decideGitnexusHealthUpdate(
  prev: GitnexusHealth,
  success: boolean,
  threshold: number,
  nowMs: number,
): GitnexusHealthUpdate {
  if (success) {
    return {
      next: { consecutiveFailures: 0, alerted: false, lastFailureAt: prev.lastFailureAt, lastSuccessAt: nowMs },
      shouldAlert: false,
      shouldResolve: prev.alerted,
    };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const shouldAlert = consecutiveFailures >= threshold && !prev.alerted;
  return {
    next: {
      consecutiveFailures,
      alerted: prev.alerted || shouldAlert,
      lastFailureAt: nowMs,
      lastSuccessAt: prev.lastSuccessAt,
    },
    shouldAlert,
    shouldResolve: false,
  };
}

export interface AnalyzeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGitnexusAnalyze(root: string, repoName: string, timeoutMs: number): Promise<AnalyzeRunResult> {
  return new Promise((resolvePromise) => {
    // detached ⇒ own process-group leader, so a timeout kills the whole tree
    // (npx → node → tree-sitter workers), never just the wrapper. Same precedent as
    // cargo-test-action.ts / p2p-perf-actions.ts.
    const child = spawn(process.env.GITNEXUS_NPX_BIN ?? 'npx', buildAnalyzeArgs(root, repoName), {
      cwd: root,
      env: process.env,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalate: NodeJS.Timeout | null = null;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };
    const killer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      escalate = setTimeout(() => killTree('SIGKILL'), 15_000);
      escalate.unref();
    }, timeoutMs);
    const finish = (res: AnalyzeRunResult): void => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolvePromise(res);
    };
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e), timedOut }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr, timedOut }));
  });
}

/** The graph indexes the operator-home repo; a per-hive coding repo has no business
 *  re-indexing it, so a stray routine there cleanly no-ops. A blank installSlug (manual
 *  or legacy fire) is treated as operator-home, matching cargo-test-action's convention. */
export function shouldSkipForHive(
  installSlug: string | null | undefined,
  homeSlug: string,
): { skip: true; reason: string } | { skip: false } {
  if (installSlug && installSlug !== homeSlug) {
    return { skip: true, reason: `not the operator-home harness (got "${installSlug}", home is "${homeSlug}")` };
  }
  return { skip: false };
}

function num(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

registerSystemAction('gitnexus-reindex', async (ctx: SystemActionCtx) => {
  const gate = shouldSkipForHive(ctx.installSlug, operatorHomeHarnessSlug());
  if (gate.skip) {
    console.log(`[gitnexus-reindex] skip: ${gate.reason}`);
    return;
  }
  const cfg = ctx.triggerConfig ?? {};
  const root = integrationRoot();
  const repoName = typeof cfg.repo_name === 'string' ? cfg.repo_name : GITNEXUS_REPO_NAME;

  const entry = readRegistryEntry(registryPath(), repoName);
  const commitsBehind = entry?.lastCommit ? await countCommitsBehind(root, entry.lastCommit) : null;
  const indexedAtMs = entry?.indexedAt ? Date.parse(entry.indexedAt) : Number.NaN;
  const secondsSinceIndexed = Number.isFinite(indexedAtMs) ? (Date.now() - indexedAtMs) / 1000 : null;
  const cores = Math.max(1, os.cpus().length);

  const decision = decideReindex({
    registered: entry != null,
    commitsBehind,
    loadPerCore: os.loadavg()[0] / cores,
    secondsSinceIndexed,
    minCommitsBehind: num(cfg, 'min_commits_behind', DEFAULT_MIN_COMMITS_BEHIND),
    maxLoadPerCore: num(cfg, 'max_load_per_core', DEFAULT_MAX_LOAD_PER_CORE),
    minIntervalSec: num(cfg, 'min_interval_sec', DEFAULT_MIN_INTERVAL_SEC),
  });

  if (!decision.run) {
    console.log(`[gitnexus-reindex] skip: ${decision.reason}`);
    return;
  }

  // Clean crash residue BEFORE spawning. Two arms, both self-perpetuating wedges left by
  // a killed writer: orphan-shadow blocks `analyze` from starting (WI-35532), orphan-wal
  // segfaults every READ while `analyze` still appears fine (D-016). No-ops on a healthy
  // tree or a build genuinely in progress.
  const residue = cleanCrashResidue(root);
  if (residue.cleaned) {
    const why =
      residue.kind === 'orphan-shadow'
        ? 'shadow present, no database — a prior analyze died BEFORE promoting it'
        : 'pending WAL beside a real database with no shadow — a prior analyze was killed AFTER promoting it; every read-only open was segfaulting on WAL replay';
    console.warn(`[gitnexus-reindex] cleaned ${residue.kind.toUpperCase()} residue (${why}): ${residue.removed.join(', ')}`);
  }

  const timeoutMs = num(cfg, 'timeout_ms', GITNEXUS_ANALYZE_TIMEOUT_MS);
  const startedAt = Date.now();
  console.log(`[gitnexus-reindex] running analyze (${decision.reason}) — root=${root} name=${repoName}`);
  const r = await runGitnexusAnalyze(root, repoName, timeoutMs);
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const success = !r.timedOut && r.code === 0;

  if (r.timedOut) {
    console.warn(`[gitnexus-reindex] TIMED OUT after ${timeoutMs}ms (${elapsedSec}s) — process tree killed`);
  } else if (r.code !== 0) {
    console.warn(`[gitnexus-reindex] exited ${r.code} after ${elapsedSec}s — ${(r.stderr || r.stdout).slice(-500)}`);
  } else {
    console.log(`[gitnexus-reindex] ok in ${elapsedSec}s — ${(r.stdout || '').trim().split('\n').slice(-1)[0]}`);
  }

  // WI-35532 (b): persist the consecutive-failure streak and alert past the threshold.
  // Fully fail-soft — a DB or notify hiccup here must never fail the routine tick itself,
  // it merely means this one tick's health bookkeeping is lost (the next tick re-derives it).
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT metadata->'gitnexus_health' AS gh FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug],
    )) as Array<{ gh: Partial<GitnexusHealth> | null }>;
    const prevHealth: GitnexusHealth = { ...GITNEXUS_HEALTH_DEFAULT, ...(rows[0]?.gh ?? {}) };
    const update = decideGitnexusHealthUpdate(prevHealth, success, GITNEXUS_FAILURE_ALERT_THRESHOLD, Date.now());
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug, JSON.stringify({ gitnexus_health: update.next })],
    );
    if (update.shouldAlert) {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: 'gitnexus-reindex failing repeatedly — code graph going stale/dead',
        body:
          `system:gitnexus-reindex has now failed ${update.next.consecutiveFailures} consecutive time(s) on ` +
          `${ctx.installSlug}. gitnexus.query / gitnexus.context lookups may be erroring while this persists. ` +
          `Latest failure: ${r.timedOut ? `timed out after ${timeoutMs}ms` : `exited ${r.code}`} — ` +
          `${(r.stderr || r.stdout).slice(-300)}`,
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: { consecutiveFailures: update.next.consecutiveFailures, timedOut: r.timedOut, code: r.code },
      });
    } else if (update.shouldResolve) {
      console.log(`[gitnexus-reindex] recovered after a ${prevHealth.consecutiveFailures}-failure streak`);
    }
  } catch (e) {
    console.warn(`[gitnexus-reindex] health tracking failed: ${e instanceof Error ? e.message : e}`);
  }
});
