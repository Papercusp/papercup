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
 * registry + git + loadavg and the latest perf-signals capture (all cheap) and only
 * then decides to spawn. `decideReindex`
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
 * own process-group leader so a timeout SIGTERM/SIGKILLs the whole tree (node →
 * tree-sitter workers), never just the wrapper, and a wedged analyze can therefore never
 * wedge the routines tick.
 *
 * RESOURCE-CAPPED (P-004): the child runs the PINNED gitnexus CLI under this process's
 * own node with an explicit heap/semi-space/stack budget — see GITNEXUS_ANALYZE_HEAP_MB
 * for the measured hazard (gitnexus self-grants 0.75x of a cgroup it does not own alone)
 * and analyzeEnv/analyzeNodeArgs for why the budget is split across env and argv.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { managedSpawn } from '../../task-manager/managed-spawn';

/** Registry alias this repo is indexed under (`analyze --name papercusp`). The alias
 *  disambiguates it from other checkouts on the box whose basename would collide. */
export const GITNEXUS_REPO_NAME = 'papercusp';

/** Cold build measured 309.2s; give a busy/colder box generous headroom without letting
 *  a genuinely wedged indexer hang the tick forever. */
export const GITNEXUS_ANALYZE_TIMEOUT_MS = 20 * 60_000;

/**
 * The measured analyze peak is 10.59 GiB RSS, while the explicit V8 heap is 16 GiB.
 * Keep ~4 GiB for native tree-sitter/LadybugDB overhead, but put the whole run in its
 * own cgroup so a future regression cannot consume the background host's 40 GiB quota.
 */
export const GITNEXUS_ANALYZE_MEMORY_MAX_BYTES = 20 * 1024 ** 3;

// ---------------------------------------------------------------------------
// P-004 — ANALYZE RESOURCE CAP (heap / semi-space / stack).
//
// THE HAZARD, measured live 2026-08-21 rather than assumed:
//
// gitnexus sizes its OWN V8 heap and re-execs itself with the result
// (`dist/cli/analyze.js`: `computeHeapCapMb` -> `ensureHeap`). The formula is
// `0.75 * effective`, where `effective` is `process.constrainedMemory()` when set --
// i.e. THIS PROCESS'S CGROUP LIMIT. We run inside `papercup-bg-host.service`, whose
// `memory.max` is 40 GiB, so it grants itself 0.75 * 40960 = 30720 MB. Observed on
// the live worker's own /proc environ, exactly: `--max-old-space-size=30720`. The
// prediction matching the observation to the megabyte is what confirms this
// derivation rather than a plausible story about it.
//
// That heuristic is sound for a dedicated container and WRONG here, for one reason:
// it assumes gitnexus is the SOLE TENANT of that cgroup. It is not. bg-host runs
// every operator routine, and held ~11.6 GiB of OTHER work while analyze ran. A
// gitnexus that actually used its self-granted 30 GiB would put the cgroup at
// ~41.6 GiB against a 40 GiB cap -- and the cgroup OOM killer does not kill "the
// process that asked for too much", it kills WITHIN THE WHOLE CGROUP. So a runaway
// analyze can take down the background host and every routine sharing it, which is
// a far larger blast radius than the failed index it started as.
//
// THE CAP IS SET FROM MEASUREMENT, NOT A GUESS. Sampled externally from /proc every
// 3s across a full run (an in-process beat cannot report on main-thread saturation --
// a saturated Node main thread stops its own timers exactly when you need them):
//   peak worker RSS (VmHWM) 10.42 GiB; peak whole-tree RSS 10.59 GiB
//   over 19,479 files / 191,008 nodes / 381,064 edges.
// RSS >= heap, so ~10.4 GiB bounds the heap the run actually used. 16 GiB therefore
// clears real usage by ~1.5x while bounding worst case (16 GiB heap + native
// tree-sitter/LadybugDB overhead, ~20 GiB) so that even a saturated analyze plus
// observed co-tenants stays under the 40 GiB cgroup cap.
export const GITNEXUS_ANALYZE_HEAP_MB = 16_384;

/** Young-gen sizing gitnexus applies for itself; preserved verbatim so capping the
 *  heap does not silently regress its GC tuning. Legal in NODE_OPTIONS. */
export const GITNEXUS_ANALYZE_SEMI_SPACE_MB = 128;

/** gitnexus raises the stack "to prevent stack overflow on deep class hierarchies".
 *  ILLEGAL in NODE_OPTIONS on Node 24+ (verified on node v25.9.0: the process exits 9
 *  with "--stack-size= is not allowed in NODE_OPTIONS"), so it MUST travel as a real
 *  argv flag. See analyzeNodeArgs. */
export const GITNEXUS_ANALYZE_STACK_KB = 4_096;

/**
 * P-004 — the LADYBUGDB size ceiling, PINNED rather than inherited.
 *
 * This is the `maxDBSize` handed to the native LadybugDB constructor. It is an mmap
 * VIRTUAL address-space reservation, not resident memory — measured on the live worker:
 * VmSize 230 GiB against VmHWM 10.42 GiB — so the number costs nothing until pages are
 * actually touched, and it is NOT the memory hazard. GITNEXUS_ANALYZE_HEAP_MB is.
 *
 * It is pinned here for a different reason: DRIFT. Upstream's default is 16 GiB, chosen
 * against an assumption its own comment states — "the GitNexus self-index uses < 50 MiB".
 * That assumption does not hold for this repo. Measured 2026-08-21: `.gitnexus/` is
 * 6.5 GB with the database file itself at 3.97 GiB over 19,479 files / 191,008 nodes,
 * i.e. ~25% of the ceiling already consumed and growing with the tree. A repo operating
 * that close to a number chosen for a 50 MiB workload should own that number explicitly
 * rather than inherit whatever a future gitnexus release happens to pick.
 *
 * Deliberately set to the SAME 16 GiB currently in force: this is a pin, not a retune —
 * no behaviour change today, and an upstream default change can no longer silently move
 * our envelope. Raising it is cheap (VA only) IF the measured DB approaches it; the
 * follow-up that WATCHES for that is filed rather than assumed, because a ceiling with
 * nobody watching it fails silently, and per D-016 a mid-analyze failure leaves
 * orphan shadow/WAL residue gitnexus cannot itself recover from.
 */
export const GITNEXUS_LBUG_MAX_DB_BYTES = 16 * 1024 * 1024 * 1024;

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
  /**
   * The memory-pressure band returned by the shared perf-budget writer. `null` means
   * the capture is absent/stale/unmeasured; do not turn that uncertainty into a block.
   */
  memoryPressure?: 'ok' | 'warn' | 'crit' | null;
  /** The writer's first reason, retained for an actionable skip log. */
  memoryPressureReason?: string | null;
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
 *  2. PSI MEMORY PRESSURE ⇒ defer. The perf-budget writer is the canonical owner of
 *     `some avg60 ≥ 10%` (sustained reclaim) and `full avg60 ≥ 5%` (thrashing). A full
 *     GitNexus analyze is a large memory consumer, so starting it during either band
 *     recreates the host-pressure incident this routine is meant to avoid. A null band
 *     means the capture is absent, stale, or missing a leg; it is intentionally fail-soft
 *     and does not invent pressure from missing data.
 *  3. NO INDEX ⇒ build. A missing graph is the WI-6445 failure mode (every lookup)
 *     returns "Symbol not found" while every call still looks well-formed), so it
 *     bypasses both the interval floor and the staleness check.
 *  4. INTERVAL FLOOR — bounds steady-state cost regardless of how fast commits land.
 *  5. STALENESS — the ordinary skip: nothing changed, nothing to do.
 */
export function decideReindex(i: ReindexDecisionInput): ReindexDecision {
  if (i.loadPerCore > i.maxLoadPerCore) {
    return {
      run: false,
      reason: `box oversubscribed (load/core ${i.loadPerCore.toFixed(2)} > ${i.maxLoadPerCore}) — deferring to the next tick`,
    };
  }
  if (i.memoryPressure === 'warn' || i.memoryPressure === 'crit') {
    return {
      run: false,
      reason:
        `memory pressure ${i.memoryPressure} — deferring GitNexus analyze to the next tick` +
        (i.memoryPressureReason ? ` (${i.memoryPressureReason})` : ''),
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
  return ['analyze', root, '--skip-agents-md', '--name', repoName];
}

/**
 * P-004 — the environment that CAPS the analyze child (see GITNEXUS_ANALYZE_HEAP_MB).
 *
 * Setting `--max-old-space-size` here is load-bearing in a way that is easy to miss:
 * gitnexus's `ensureHeap()` returns EARLY when NODE_OPTIONS already carries that flag
 * ("A user-supplied NODE_OPTIONS heap wins (no re-exec)" -- its own comment, and the
 * override its OOM error text tells operators to use). So this both applies our cap
 * AND suppresses the self-re-exec that would otherwise replace it with 0.75x-cgroup.
 *
 * Because that early return skips the WHOLE re-exec, every flag gitnexus would have
 * applied there is now ours to carry. Semi-space is legal in NODE_OPTIONS and is set
 * here; --stack-size is NOT (Node 24+) and travels as argv in analyzeNodeArgs. Dropping
 * either would trade an OOM risk for a GC-churn or stack-overflow regression, and a
 * mid-analyze crash is not a cheap failure here -- it leaves the orphan shadow/WAL
 * residue that D-016 showed is unrecoverable by gitnexus itself.
 *
 * An operator-supplied heap is honoured untouched: this cap exists to stop gitnexus
 * granting ITSELF the whole shared cgroup, not to override a human who chose a value.
 */
export function analyzeEnv(
  base: NodeJS.ProcessEnv,
  heapMb: number = GITNEXUS_ANALYZE_HEAP_MB,
  semiSpaceMb: number = GITNEXUS_ANALYZE_SEMI_SPACE_MB,
): NodeJS.ProcessEnv {
  // The LadybugDB ceiling is pinned on every spawn, independent of the heap branch
  // below: an operator overriding the HEAP must not silently also drop the DB pin.
  // An explicit caller-supplied value still wins.
  const withDbCap: NodeJS.ProcessEnv = {
    ...base,
    GITNEXUS_LBUG_MAX_DB_SIZE: base.GITNEXUS_LBUG_MAX_DB_SIZE ?? String(GITNEXUS_LBUG_MAX_DB_BYTES),
  };
  const existing = (withDbCap.NODE_OPTIONS ?? '').trim();
  if (/--max-old-space-size/.test(existing)) return withDbCap;
  const semi = /--max-semi-space-size/.test(existing) ? '' : ` --max-semi-space-size=${semiSpaceMb}`;
  return {
    ...withDbCap,
    NODE_OPTIONS: `${existing} --max-old-space-size=${heapMb}${semi}`.trim(),
  };
}

/**
 * P-004 — argv for spawning the PINNED gitnexus CLI under our own node.
 *
 * Two reasons this no longer goes through `npx`:
 *   1. npx does not forward node flags to the target, and --stack-size can ONLY be an
 *      argv flag (illegal in NODE_OPTIONS on Node 24+), so the cap is not expressible
 *      through the npx form at all.
 *   2. P-003 pinned an exact operator-owned gitnexus for precisely this reason and
 *      `canaryBin()` already reads it; the analyze spawn was still resolving `gitnexus`
 *      through ambient npx, so the two halves of this module disagreed about which
 *      binary "gitnexus" means.
 *
 * Fewer wrapper layers also makes the timeout kill STRICTER, not looser: the old chain
 * was npx -> sh -c -> node -> re-exec'd node, and only the process-group kill reached
 * the leaf. Here the child IS the worker.
 */
export function analyzeNodeArgs(
  cliPath: string,
  root: string,
  repoName: string,
  stackKb: number = GITNEXUS_ANALYZE_STACK_KB,
): string[] {
  return [`--stack-size=${stackKb}`, cliPath, ...buildAnalyzeArgs(root, repoName)];
}

/** The pinned gitnexus CLI entrypoint. `canaryBin()` resolves the same install; this
 *  resolves the JS entry node executes directly rather than the .bin shim. */
export function analyzeCliPath(): string {
  return (
    process.env.PAPERCUSP_GITNEXUS_CLI ??
    path.join(os.homedir(), '.papercusp', 'vendor', 'gitnexus', 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js')
  );
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

/**
 * A shadow that is EMPTY and has not been touched for this long is not a build in
 * flight. Sized far above any plausible gap between a live analyze creating the shadow
 * file and writing its first byte, so a genuinely running build is never mistaken for
 * residue — the direction that matters, since acting on a live build corrupts it.
 */
export const DEAD_SHADOW_STALE_MS = 5 * 60_000;

/**
 * PURE — THE THIRD RESIDUE STATE. Observed live 2026-08-21T06:55Z, which is how it was
 * found: the 06:35 analyze hit its 20-minute timeout at 1198s, was SIGKILLed mid-build,
 * and left `lbug` (3.97 GiB, the intact 05:45 index) + `lbug.shadow` at ZERO BYTES +
 * `lbug.wal.checkpoint`. Every read then segfaulted (`gitnexus cypher` exit 139, core
 * dumped) — GitNexus dead for the whole fleet.
 *
 * NEITHER existing arm fires on it, which is the actual defect:
 *   isOrphanShadow = shadowExists && !dbExists   -> false, the database exists
 *   isOrphanWal    = walExists && dbExists && !shadowExists -> false, a shadow exists
 * So cleanCrashResidue returned kind:'none', the poison stayed, and the next tick would
 * re-run the same doomed sequence — precisely the self-perpetuating wedge this module's
 * header says the residue policy exists to prevent.
 *
 * The gap is in the `!shadowExists` term. Its stated reasoning is sound — "shadow-present
 * means a build is genuinely running and its WAL is live data, not residue" — but it
 * treats the shadow's EXISTENCE as proof of liveness. A zero-byte shadow proves the
 * opposite: a build that died before writing anything. Emptiness plus staleness
 * distinguishes the two without ever touching a live build.
 */
export function isDeadShadow(
  shadowExists: boolean,
  shadowSizeBytes: number,
  shadowAgeMs: number,
): boolean {
  return shadowExists && shadowSizeBytes === 0 && shadowAgeMs > DEAD_SHADOW_STALE_MS;
}

export interface OrphanShadowCleanup {
  cleaned: boolean;
  removed: string[];
  /** Which residue was found, for a log line that names the failure mode rather than the files. */
  kind: 'none' | 'orphan-shadow' | 'orphan-wal' | 'dead-shadow-wal';
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

  // A shadow only counts as "a build is in flight" if it shows any sign of being one.
  // An empty, stale shadow is a corpse, and treating it as live is what left the tree
  // segfaulting on 2026-08-21 with NEITHER arm firing (see isDeadShadow).
  let shadowIsDead = false;
  if (shadowExists) {
    try {
      const st = statSync(shadow);
      shadowIsDead = isDeadShadow(true, st.size, Date.now() - st.mtimeMs);
    } catch {
      // Vanished between the check and the stat — that IS the not-present case.
      shadowIsDead = false;
    }
  }
  // What the two existing predicates should have been asking all along: is a build LIVE?
  const liveShadow = shadowExists && !shadowIsDead;

  let kind: OrphanShadowCleanup['kind'] = 'none';
  let targets: string[] = [];
  if (isOrphanShadow(dbExists, liveShadow)) {
    kind = 'orphan-shadow';
    targets = [shadow, walCheckpoint];
  } else if (isOrphanWal(dbExists, liveShadow, walExists)) {
    // The dead shadow goes too: leaving it behind re-arms the exact trap, because the
    // NEXT tick would again read shadow-present as build-in-flight.
    kind = shadowIsDead ? 'dead-shadow-wal' : 'orphan-wal';
    targets = shadowIsDead ? [wal, walCheckpoint, shadow] : [wal, walCheckpoint];
  } else if (shadowIsDead && dbExists) {
    // Dead shadow with no WAL: not yet poisoning reads, but it still masks the next
    // real orphan-WAL from being classified. Clear it while it is cheap.
    kind = 'dead-shadow-wal';
    targets = [shadow, walCheckpoint];
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

// ---------------------------------------------------------------------------
// P-004 — SEMANTIC CANARIES.
//
// WHY EXIT 0 IS NOT ENOUGH. Everything upstream of this point measures whether the
// INDEXER RAN. Nothing measured whether the resulting graph ANSWERS. Those came apart
// completely on 2026-08-21: the MCP bridge kept advertising all 17 of its tools (the
// handshake needs no graph) while every actual call died on the poisoned index. To an
// agent that reads as "gitnexus has nothing useful to say" rather than "gitnexus is
// broken" — the same indistinguishable-failure shape D-004 was written to end, one layer
// up. A canary is what turns that into a detectable condition.
//
// DESIGN RULE: NO HARDCODED SYMBOL NAMES. The obvious canary — "look up
// `someKnownFunction` and assert it resolves" — rots the first time someone renames it,
// and then fires as a false alarm on a perfectly healthy index. False alarms are how a
// health signal gets ignored, which costs exactly the outage it was built for. So the
// round-trip probe reads a symbol OUT of the graph and then looks THAT up: it asserts
// the read path resolves what the graph actually contains, which is the real property,
// and cannot be invalidated by a rename.
// ---------------------------------------------------------------------------

export interface CanaryProbe {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CanaryVerdict {
  /** False when any probe that indicates a genuinely unusable graph failed. */
  healthy: boolean;
  probes: CanaryProbe[];
  summary: string;
}

export interface CanaryInputs {
  /** Files in the graph; null ⇒ the query itself failed (crash, segfault, timeout). */
  fileCount: number | null;
  /** Symbol (Function/Class) nodes — definition truth. null ⇒ query failed. */
  symbolCount: number | null;
  /** Call edges — the "who calls this" capability. null ⇒ query failed. */
  callEdgeCount: number | null;
  /** Definition edges — the "where is this defined" capability. null ⇒ query failed. */
  defEdgeCount: number | null;
  /**
   * Did a symbol read straight out of the graph resolve back through the lookup path?
   * null ⇒ could not be attempted (no symbol to sample, or the read failed).
   */
  roundTripOk: boolean | null;
  /** Embeddings present, from registry stats. 0 is EXPECTED here (WI-35557) — reported, not failed. */
  embeddings: number | null;
}

/**
 * PURE — the whole canary policy, testable without a graph, a subprocess, or a clock.
 *
 * Only the probes that mean "the graph cannot answer" set healthy=false. Vector/FTS
 * status is REPORTED but never fails the canary: embeddings have been legitimately 0 on
 * this install since WI-35557, and a canary that fails on a known, accepted condition is
 * a canary that gets muted — taking the real signal with it.
 */
export function judgeCanary(i: CanaryInputs): CanaryVerdict {
  const probes: CanaryProbe[] = [
    {
      name: 'graph-answers',
      ok: i.fileCount != null && i.fileCount > 0,
      detail:
        i.fileCount == null
          ? 'the count query did not return — the graph is unreadable (crash/segfault/timeout), NOT merely empty'
          : `${i.fileCount} files`,
    },
    {
      name: 'definitions',
      ok: i.symbolCount != null && i.symbolCount > 0,
      detail: i.symbolCount == null ? 'query failed' : `${i.symbolCount} symbol nodes`,
    },
    {
      name: 'call-edges',
      ok: i.callEdgeCount != null && i.callEdgeCount > 0,
      detail: i.callEdgeCount == null ? 'query failed' : `${i.callEdgeCount} call edges`,
    },
    {
      name: 'definition-edges',
      ok: i.defEdgeCount != null && i.defEdgeCount > 0,
      detail: i.defEdgeCount == null ? 'query failed' : `${i.defEdgeCount} definition edges`,
    },
    {
      name: 'symbol-round-trip',
      ok: i.roundTripOk === true,
      detail:
        i.roundTripOk == null
          ? 'not attempted — no symbol could be sampled from the graph'
          : i.roundTripOk
            ? 'a symbol sampled from the graph resolved back through the lookup path'
            : 'a symbol PRESENT in the graph did NOT resolve through the lookup path — the read path is broken, not the data',
    },
    {
      // Status only. See the doc comment: 0 is the expected, accepted state here.
      name: 'vector-search',
      ok: true,
      detail:
        i.embeddings == null
          ? 'embeddings unknown'
          : i.embeddings > 0
            ? `${i.embeddings} embeddings`
            : '0 embeddings — EXPECTED (WI-35557: gitnexus.query is non-functional on this install; use context/cypher or grep)',
    },
  ];
  const failed = probes.filter((p) => !p.ok);
  return {
    healthy: failed.length === 0,
    probes,
    summary:
      failed.length === 0
        ? `canary OK — ${probes.map((p) => p.detail).join('; ')}`
        : `canary FAILED (${failed.length}/${probes.length}): ${failed.map((p) => `${p.name}: ${p.detail}`).join(' | ')}`,
  };
}

export interface AnalyzeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGitnexusAnalyze(root: string, repoName: string, timeoutMs: number): Promise<AnalyzeRunResult> {
  return (async () => {
    const command = process.env.GITNEXUS_NODE_BIN ?? process.execPath;
    const args = analyzeNodeArgs(analyzeCliPath(), root, repoName);
    const managed = await managedSpawn(
      command,
      args,
      {
        class: 'build',
        title: `gitnexus analyze ${repoName}`,
        argv: [command, ...args],
        cwd: root,
        launchedBy: 'system:gitnexus-reindex',
        memoryMaxBytes: GITNEXUS_ANALYZE_MEMORY_MAX_BYTES,
        runtimeMaxSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
        detail: { subsystem: 'gitnexus', operation: 'analyze', repoName },
      },
      {
        // Keep the process-group kill fallback for unconfined hosts. On Linux,
        // managedSpawn adds the same deadline to the transient scope, so the
        // payload remains bounded even if this operator process dies mid-run.
        spawnOptions: {
          cwd: root,
          env: analyzeEnv(process.env),
          detached: true,
        },
      },
    );
    const child = managed.child;

    return new Promise<AnalyzeRunResult>((resolvePromise) => {
    // detached ⇒ own process-group leader, so a timeout kills the whole tree
    // (npx → node → tree-sitter workers), never just the wrapper. Same precedent as
    // cargo-test-action.ts / p2p-perf-actions.ts.
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
  })();
}

/** Resolve the gitnexus binary for canary probes, mirroring the bridge's own resolution
 *  order. Absent ⇒ the canary reports "not attempted" rather than a false failure. */
export function canaryBin(): string {
  return process.env.PAPERCUSP_GITNEXUS_BIN ?? path.join(os.homedir(), '.papercusp', 'vendor', 'gitnexus', 'node_modules', '.bin', 'gitnexus');
}

function cypherScalar(bin: string, root: string, query: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(bin, ['cypher', query], { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // A CRASH (segfault) arrives here as an error with no usable stdout — which is
      // exactly the condition the canary exists to catch, so it must map to null
      // ("unreadable"), never to 0 ("empty"). Conflating those two is what made the
      // original outage look like an empty graph instead of a broken one.
      if (err) return resolvePromise(null);
      const m = /\|\s*(\d+)\s*\|/.exec(String(stdout));
      resolvePromise(m ? Number.parseInt(m[1], 10) : null);
    });
  });
}

function cypherFirstString(bin: string, root: string, query: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(bin, ['cypher', query], { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolvePromise(null);
      // Rows render as a markdown table; take the first data cell after the separator.
      const rows = String(stdout).split('\\n');
      for (const r of rows) {
        const m = /^\s*\|\s*([^|\s][^|]*?)\s*\|/.exec(r.replace(/\\\\n/g, '\n'));
        if (m && m[1] !== '---' && !/^-+$/.test(m[1])) {
          const v = m[1].trim();
          if (v && v !== 'name' && v !== 'n') return resolvePromise(v);
        }
      }
      resolvePromise(null);
    });
  });
}

export const CANARY_PROBE_TIMEOUT_MS = 90_000;

/**
 * Run the canary against the live index. Fail-soft in the same spirit as the rest of
 * this action: every probe collapses to null on any error, and `judgeCanary` decides
 * what that means — the policy stays in the pure function.
 */
export async function runCanary(root: string, registryFiles: number | null, embeddings: number | null): Promise<CanaryVerdict> {
  const bin = canaryBin();
  if (!existsSync(bin)) {
    return judgeCanary({ fileCount: null, symbolCount: null, callEdgeCount: null, defEdgeCount: null, roundTripOk: null, embeddings });
  }
  const t = CANARY_PROBE_TIMEOUT_MS;
  const fileCount = await cypherScalar(bin, root, 'MATCH (f:File) RETURN count(f) AS n', t);
  const symbolCount = await cypherScalar(bin, root, 'MATCH (f:Function) RETURN count(f) AS n', t);
  // ⚠ THE EDGE TYPE IS A PROPERTY, NOT A TABLE. This graph has exactly ONE relationship
  // table — `CodeRelation` — and the kind lives in `r.type` ('CALLS', 'DEFINES',
  // 'IMPORTS', ...). The natural-looking `MATCH ()-[r:CALLS]->()` does NOT return zero;
  // it throws "Binder exception: Table CALLS does not exist", which cypherScalar maps to
  // null — i.e. it would have reported the read as UNREADABLE and failed this canary on
  // every single healthy index, forever. Caught only by running it against the live
  // graph; the pure judge cannot see a wrong query. Verify with:
  //   MATCH ()-[r:CodeRelation]->() RETURN r.type AS t, count(r) AS n ORDER BY n DESC
  const callEdgeCount = await cypherScalar(bin, root, "MATCH ()-[r:CodeRelation]->() WHERE r.type = 'CALLS' RETURN count(r) AS n", t);
  const defEdgeCount = await cypherScalar(bin, root, "MATCH ()-[r:CodeRelation]->() WHERE r.type = 'DEFINES' RETURN count(r) AS n", t);

  // The round trip: sample a name OUT of the graph, then assert the graph can find that
  // same name again. No hardcoded symbol, so a rename can never false-alarm it.
  let roundTripOk: boolean | null = null;
  const sampled = await cypherFirstString(bin, root, 'MATCH (f:Function) WHERE f.name IS NOT NULL RETURN f.name AS name LIMIT 1', t);
  if (sampled) {
    const safe = sampled.replace(/'/g, '');
    const found = await cypherScalar(bin, root, `MATCH (f:Function) WHERE f.name = '${safe}' RETURN count(f) AS n`, t);
    roundTripOk = found != null && found > 0;
  }
  return judgeCanary({ fileCount: fileCount ?? registryFiles, symbolCount, callEdgeCount, defEdgeCount, roundTripOk, embeddings });
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

  // Reuse the same writer and thresholds that power the infra panel and
  // host.memoryPressure. This is an admission guard, not a second PSI policy:
  // `warn` (memory some >= 10%) and `crit` (memory full >= 5%) both defer a full
  // GitNexus analyze; absent/stale/unmeasured captures return null and remain
  // fail-soft, matching the writer's in-band unknown contract.
  let memoryPressure: ReindexDecisionInput['memoryPressure'] = null;
  let memoryPressureReason: string | null = null;
  try {
    const { evaluateMemoryPressure, readLatestPerfSignals } = await import('../../system-health/perf-budgets');
    const memory = evaluateMemoryPressure(await readLatestPerfSignals(), Date.now());
    memoryPressure = memory.pressure;
    memoryPressureReason = memory.reasons[0] ?? null;
  } catch (e) {
    // A missing/unreadable perf surface must not wedge the routine itself. Load/core
    // and the remaining staleness gates still protect the ordinary path.
    console.warn(`[gitnexus-reindex] memory-pressure admission unavailable: ${e instanceof Error ? e.message : e}`);
  }

  const decision = decideReindex({
    registered: entry != null,
    commitsBehind,
    loadPerCore: os.loadavg()[0] / cores,
    secondsSinceIndexed,
    memoryPressure,
    memoryPressureReason,
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
        : residue.kind === 'dead-shadow-wal'
          ? 'an EMPTY, stale shadow beside a real database — a prior analyze was SIGKILLed mid-build (the 20-minute timeout does this). The empty shadow used to make this state match neither residue arm, so nothing cleaned it and every read-only open segfaulted on WAL replay'
          : 'pending WAL beside a real database with no shadow — a prior analyze was killed AFTER promoting it; every read-only open was segfaulting on WAL replay';
    console.warn(`[gitnexus-reindex] cleaned ${residue.kind.toUpperCase()} residue (${why}): ${residue.removed.join(', ')}`);
  }

  const timeoutMs = num(cfg, 'timeout_ms', GITNEXUS_ANALYZE_TIMEOUT_MS);
  const startedAt = Date.now();
  console.log(`[gitnexus-reindex] running analyze (${decision.reason}) — root=${root} name=${repoName}`);
  const r = await runGitnexusAnalyze(root, repoName, timeoutMs);
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const ranClean = !r.timedOut && r.code === 0;

  // P-004: a clean exit says the INDEXER ran, not that the GRAPH answers. Those came
  // apart completely on 2026-08-21 (D-016). Verify the artifact we just produced, and
  // treat a canary failure as a failure of this tick — otherwise the existing alarm rail
  // keeps reporting success over an index nobody can query.
  let canary: CanaryVerdict | null = null;
  if (ranClean) {
    try {
      const after = readRegistryEntry(registryPath(), repoName) as (GitnexusRegistryEntry & { stats?: { files?: number; embeddings?: number } }) | null;
      canary = await runCanary(root, after?.stats?.files ?? null, after?.stats?.embeddings ?? null);
      console.log(`[gitnexus-reindex] ${canary.healthy ? 'canary OK' : 'CANARY FAILED'} — ${canary.summary}`);
    } catch (e) {
      // Never let canary plumbing fail a tick that genuinely succeeded.
      console.warn(`[gitnexus-reindex] canary could not run: ${e instanceof Error ? e.message : e}`);
    }
  }
  const success = ranClean && (canary == null || canary.healthy);

  if (r.timedOut) {
    console.warn(
      `[gitnexus-reindex] TIMED OUT after ${timeoutMs}ms (${elapsedSec}s) — process tree killed. ` +
        'That kill can leave crash residue (D-016); the next tick\'s cleanCrashResidue() preflight recovers it.',
    );
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
