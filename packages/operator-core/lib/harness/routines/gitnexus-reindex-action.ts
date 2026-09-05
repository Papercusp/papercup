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
 * WHY A GATED HOURLY TICK RATHER THAN A PLAIN CRON. Every spawn is a FULL rebuild (see
 * `--force` below) that was measured on this box at **309s cold** on the 2026-08 graph,
 * ~14.5 min of non-embedding work on the 2026-09-05 graph under fleet load, and **2,343s for
 * the steady-state tick** (full rebuild + embedding-cache restore + re-embed of the changed
 * nodes, run #4, load/core 1.06). So the cadence
 * cannot be "run it every hour" — the routine fires hourly but the EXPENSIVE part is
 * conditional: each tick reads the registry + git + loadavg and the latest perf-signals
 * capture (all cheap) and only then decides to spawn. `decideReindex` is the whole policy,
 * kept pure so it is testable without a 15-minute subprocess.
 *
 * `--force` IS MANDATORY (D-002, plan gitnexus-embeddings-enablement-2026-09-05). gitnexus
 * 1.6.9 defaults to an INCREMENTAL path (changed files + a BFS of their importers, "skipping
 * wipe") and on this graph that path is the outage: MEASURED 2026-09-05, twice, on a
 * 296-changed / 91-added / +6,839-importer write set, the incremental writeback breached the
 * 16 GiB GITNEXUS_LBUG_MAX_DB_BYTES ceiling ~35–45 min in ("Maximum database size of
 * 17179869184 bytes has been reached" → "manual WAL checkpoint failed after retries" →
 * SIGSEGV), leaving the D-016 residue that wedges every reader (/tmp/wi39394/run2-embed-run.log,
 * /tmp/wi39394/bootstrap-live/run.log); the same path had timeout-killed the hourly tick ~10×
 * over the preceding 3 days. A FULL rebuild of the same graph completed in 3,133s INCLUDING a
 * cold 2,265s embedding phase, with the database file ending at 5.3 GiB
 * (/tmp/wi39394/run1-embed-run.log). Full-per-tick is therefore the cheaper AND the durable
 * design here; a bigger ceiling merely moves the cliff (the live root has ~70 GB free).
 *
 * EMBEDDINGS ARE ON (WI-39394). Every spawn passes `--embeddings 0`
 * (GITNEXUS_EMBEDDINGS_NODE_CAP) so the vector leg of `gitnexus.query` is populated instead
 * of the permanent 0-of-246k it sat at since WI-35557. The cold 217,120-embedding pass
 * (≈96/s on cuda) is NOT something this routine pays every tick: `--force --embeddings`
 * LOADS the embedding cache from the existing index BEFORE the wipe, RESTORES it into the
 * fresh database, and generates only for new/changed nodes (`core/run-analyze.js`
 * "We *always* load the embedding cache when one is requested"; `core/embedding-mode.js`).
 * The first population is a ONE-SHOT SUPERVISED BOOTSTRAP outside the routine (D-002).
 * ⚠ An analyze WITHOUT `--embeddings` merely PRESERVES the embeddings already present and
 * never embeds a new node, so dropping the flag does not "turn embeddings off" — it silently
 * freezes the vector leg at bootstrap time while every count still reads healthy. That is
 * why both flags live in `buildAnalyzeArgs` beside `--skip-agents-md` and are asserted by
 * tests, and why the canary treats `embeddings == 0` after an embeddings-enabled run as a
 * DEGRADATION.
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
import {
  readFileSync,
  existsSync,
  unlinkSync,
  statSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { managedSpawn } from '../../task-manager/managed-spawn';
import { dirSizeBytes } from '../../storage/disk';
import {
  DEFAULT_RESOURCE_BUDGET,
  classifyIndexDisk,
  type IndexDiskVerdict,
} from '../../code-intelligence/contracts';

/** Registry alias this repo is indexed under (`analyze --name papercusp`). The alias
 *  disambiguates it from other checkouts on the box whose basename would collide. */
export const GITNEXUS_REPO_NAME = 'papercusp';

/**
 * Sized from the STEADY-STATE tick, not the 2026-08 cold build (309.2s — the figure the old
 * 20-minute value was cut from, on a graph a third this size and before embeddings).
 *
 * Measured 2026-09-05 (D-002, /tmp/wi39394/run4-embed-run.log): a `--force --embeddings 0`
 * pass over 247,540 nodes that RESTORED 217k cached embeddings and re-embedded the changed
 * nodes took 2,343s (39:02 wall) under a 1.06 load/core box; the same pass with no embedding
 * work took 1,660s (run #3). 70 min is ~1.8x the measured steady-state tick and comfortably
 * above the cold-phase-free full rebuild, while still bounding a genuinely wedged indexer.
 *
 * It deliberately EXCEEDS the hourly cron: the routine row is `concurrency: 'skip'`
 * (seed-gitnexus-reindex-routine.ts), so a fire that lands while the previous tick is still
 * awaiting its analyze is skipped rather than double-spawned. The cold one-shot bootstrap
 * (3,139s) is NOT run under this timeout — see the module header.
 */
export const GITNEXUS_ANALYZE_TIMEOUT_MS = 70 * 60_000;

/**
 * The analyze child's OWN cgroup ceiling (managedSpawn `memoryMaxBytes`), so a regression
 * can never consume the background host's 40 GiB quota.
 *
 * Sized from measurement, twice: 10.59 GiB peak RSS on the 2026-08-21 graph (19,479 files,
 * no embeddings, 2 GiB LadybugDB pool) → 20 GiB; then 14.9 GiB (15,633,516 kB, /usr/bin/time
 * "Maximum resident set size") on 2026-09-05 over 246,622 nodes WITH embeddings and the 8 GiB
 * buffer-pool pin (GITNEXUS_LBUG_BUFFER_POOL_BYTES). That peak lands in the LadybugDB bulk-
 * load phase, BEFORE embedding starts — the embedding phase itself ran at 2.3–3.2 GiB with the
 * model on the GPU — so it is the pool + heap, not the embedder, that sets the envelope.
 * 24 GiB = the 16 GiB heap cap + the 8 GiB pool worst case; against the measured 14.9 GiB it is
 * ~1.6x headroom, and 24 + the ~11.6 GiB of observed co-tenants stays under the 40 GiB
 * bg-host cgroup. A cgroup OOM kill here is not a cheap failure: it leaves the D-016 residue.
 */
export const GITNEXUS_ANALYZE_MEMORY_MAX_BYTES = 24 * 1024 ** 3;

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

/** Alert before the LadybugDB mmap ceiling becomes an outage cliff. */
export const GITNEXUS_LBUG_DB_ALERT_RATIO = 0.6;

/**
 * The LadybugDB BUFFER POOL — a different resource from GITNEXUS_LBUG_MAX_DB_BYTES above,
 * and the distinction is the whole reason this constant exists. The max-DB-size pin is a
 * virtual-address reservation (cheap to raise). This is RESIDENT memory, so it is sized
 * deliberately rather than maximised.
 *
 * MEASURED 2026-09-02 (EI-22172147268902766): a full rebuild of this repo died ~20 minutes
 * in with "COPY failed for File: Buffer manager exception: Unable to allocate memory! The
 * buffer pool is full and no memory could be freed!" — gitnexus 1.6.10 defaults the pool to
 * `min(2 GiB, 80% RAM)`, i.e. 2 GiB here, and the bulk COPY of a 22,394-file / 238,521-node
 * graph exhausts it. Raising the NODE heap does nothing for this: the pool is LadybugDB
 * native memory, which is why the failing run had a 193 GB heap and still died.
 *
 * 8 GiB, not upstream's suggested 4 GiB: the on-disk database is already 5.1 GiB and grows
 * with the tree, and 4 GiB is the generic example from the error string rather than a number
 * measured against this repo. 8 GiB is ~3% of host RAM — real headroom, still bounded.
 *
 * NOT `0`. Zero is gitnexus's escape hatch restoring LadybugDB's native 80%-of-RAM default,
 * which on this 251 GB box means a ~200 GB RESIDENT pool on a machine shared by ~50 checkouts
 * and the agent fleet. The failure mode it trades into is worse than the one it fixes.
 */
export const GITNEXUS_LBUG_BUFFER_POOL_BYTES = 8 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// EMBEDDINGS — plan gitnexus-embeddings-enablement-2026-09-05 (WI-39394), D-002.
//
// gitnexus 1.6.9 semantics that these three constants pin (core/embedding-mode.js,
// core/embeddings/config.js, cli/analyze.js):
//   * `--embeddings [limit]` ENABLES generation; without it an analyze only PRESERVES
//     embeddings already in the index and never embeds a new node. `limit` overrides the
//     50,000-node safety cap (DEFAULT_EMBEDDING_NODE_LIMIT); `0` disables the cap. This
//     graph is 246,622 nodes, so the default cap would SKIP embedding wholesale with a
//     notice — measured 2026-09-04 ("--embeddings 50000" run → 0 embeddings).
//   * `GITNEXUS_EMBEDDING_DEVICE` is read by resolveEmbeddingConfig ahead of any CLI
//     override; `cuda` falls back to cpu INSIDE gitnexus when the CUDA provider cannot load
//     (embedder devicesToTry), so pinning cuda is never a hard dependency on the GPU.
//   * `GITNEXUS_EMBEDDING_THREADS` is the onnxruntime intra-op thread count (default 4).
// ---------------------------------------------------------------------------

/**
 * `--embeddings <cap>` — 0 = UNCAPPED. Anything else silently re-arms the node-count skip
 * on this graph (246,622 nodes vs the 50,000 default), which is exactly the failure that kept
 * the vector leg at 0 embeddings for a month. Measured 2026-09-05: the uncapped cold pass over
 * the full graph completes (217,120 embeddings, exit 0) — see the module header for cost.
 */
export const GITNEXUS_EMBEDDINGS_NODE_CAP = 0;

/** Embedding device pin. `cuda` on this box (RTX, ~1.3 GiB used at 47–79% util for the
 *  whole pass); gitnexus falls back to cpu internally if the CUDA provider is unavailable. */
export const GITNEXUS_EMBEDDING_DEVICE = 'cuda';

/** onnxruntime intra-op threads for the embedder. gitnexus's own default is 4; pinned so a
 *  future upstream default change cannot silently move the CPU envelope of the hourly tick. */
export const GITNEXUS_EMBEDDING_THREADS = 4;

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
 * a caller's choice — see this module's header for what happens without it. `--embeddings`
 * is likewise not a caller's choice: dropping it does not disable embeddings, it FREEZES
 * them (existing ones are preserved, new nodes are never embedded), see the header.
 * `--force` is not a caller's choice either: without it gitnexus takes the INCREMENTAL
 * writeback that breaches the LadybugDB ceiling and segfaults on this graph (header, D-002).
 *
 * `--embeddings` takes an OPTIONAL value in gitnexus's commander definition, so it is placed
 * LAST — a positional after it would be swallowed as the cap. `--force` therefore goes
 * BEFORE it, never after.
 */
export function buildAnalyzeArgs(
  root: string,
  repoName: string,
  embeddingsNodeCap: number = GITNEXUS_EMBEDDINGS_NODE_CAP,
): string[] {
  return [
    'analyze',
    root,
    '--skip-agents-md',
    '--name',
    repoName,
    '--force',
    '--embeddings',
    String(embeddingsNodeCap),
  ];
}

/**
 * PURE — does this argv ask gitnexus to GENERATE embeddings? Derived from the argv rather
 * than restated as a second boolean so the canary's expectation cannot drift from what the
 * spawn actually passed (`cli/analyze.js`: `embeddingsEnabled = !!options.embeddings`, and
 * `--embeddings 0` is the truthy string "0", i.e. enabled + uncapped).
 */
export function analyzeEmbeddingsExpected(args: readonly string[] = buildAnalyzeArgs('.', GITNEXUS_REPO_NAME)): boolean {
  return args.includes('--embeddings');
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
  //
  // The buffer pool is pinned on the same terms and for a sharper reason: its default
  // (2 GiB) is not a ceiling nobody reaches but a wall this repo HITS — it is what killed
  // the 2026-09-02 rebuild. It rides in the same branch-independent object because the
  // heap and the pool are separate resources, so an operator tuning NODE_OPTIONS must not
  // silently drop the one that node flags cannot influence at all.
  //
  // The embedding device/threads ride here too (D-002): gitnexus reads them from env in
  // resolveEmbeddingConfig, an explicit caller value still wins, and — like the pool — no
  // node flag can influence them, so they must not depend on the heap branch either.
  const withDbCap: NodeJS.ProcessEnv = {
    ...base,
    GITNEXUS_LBUG_MAX_DB_SIZE: base.GITNEXUS_LBUG_MAX_DB_SIZE ?? String(GITNEXUS_LBUG_MAX_DB_BYTES),
    GITNEXUS_LBUG_BUFFER_POOL_SIZE:
      base.GITNEXUS_LBUG_BUFFER_POOL_SIZE ?? String(GITNEXUS_LBUG_BUFFER_POOL_BYTES),
    GITNEXUS_EMBEDDING_DEVICE: base.GITNEXUS_EMBEDDING_DEVICE ?? GITNEXUS_EMBEDDING_DEVICE,
    GITNEXUS_EMBEDDING_THREADS: base.GITNEXUS_EMBEDDING_THREADS ?? String(GITNEXUS_EMBEDDING_THREADS),
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

/**
 * Put the expensive graph rebuild behind the repository's existing host-wide
 * heavy-work admission wrapper. The wrapper is resolved from the integration
 * root rather than from the operator process's cwd, because routine fires can
 * run from a package or service directory. A partial install or a repo-less
 * harness must remain able to run the action, so an absent wrapper deliberately
 * falls back to the original direct invocation.
 */
export function buildAnalyzeInvocation(
  root: string,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const pcHeavyPath = path.join(root, 'scripts', 'pc-heavy.sh');
  if (!existsSync(pcHeavyPath)) {
    return { command, args: [...args] };
  }
  return { command: 'bash', args: [pcHeavyPath, '--', command, ...args] };
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
 * The `incrementalInProgress` marker gitnexus writes into `.gitnexus/meta.json` while a
 * build is mid-flight, as read back AFTER a failed analyze.
 *
 * ⚠ This is deliberately a REPORTER, not a repairer, and that is the whole design decision
 * (EI-22172147268902766). The obvious "fix" — clear the stranded marker so the next tick
 * stops being forced into a full rebuild — is actively harmful: the marker is what tells
 * gitnexus the index is half-written, so clearing it converts a loud, correct "forcing full
 * rebuild to restore a known-good index" into a SILENT stale/torn index served as if clean.
 * Forcing the rebuild is the right response to a dirty index; the real defect was that the
 * rebuild could not succeed (see GITNEXUS_LBUG_BUFFER_POOL_BYTES).
 *
 * What was genuinely missing is VISIBILITY. A failed analyze leaves the marker set, so every
 * subsequent hourly tick is forced into the same ~20-minute full rebuild and fails the same
 * way — a doom loop whose alert previously read only "exited 1", with nothing to distinguish
 * a one-off failure from an index wedged into permanent rebuild-and-fail.
 */
export interface GitnexusIncompleteIndex {
  /** The build phase gitnexus recorded (e.g. 'full-rebuild'), when it named one. */
  phase: string | null;
  /** When the stranded build started, epoch ms, when recorded. */
  startedAt: number | null;
  /** Pending writes at the moment it died — the "last dirty state: toWrite=N" figure. */
  toWriteCount: number | null;
}

/** Path to the metadata file carrying the marker above. */
export function gitnexusMetaPath(root: string): string {
  return path.join(root, '.gitnexus', 'meta.json');
}

/**
 * PURE — extract the marker from already-parsed meta.json content.
 *
 * Split from the read so the interesting half is testable without a filesystem, and so a
 * malformed/absent marker is in-band `null` rather than a throw: this runs on the FAILURE
 * path, where a second exception would replace a real diagnosis with a plumbing error.
 */
export function readIncompleteIndexMarker(meta: unknown): GitnexusIncompleteIndex | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const marker = (meta as { incrementalInProgress?: unknown }).incrementalInProgress;
  if (typeof marker !== 'object' || marker === null) return null;
  const m = marker as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    phase: typeof m.phase === 'string' ? m.phase : null,
    startedAt: num(m.startedAt),
    toWriteCount: num(m.toWriteCount),
  };
}

/**
 * Read the marker off disk. Fail-soft in BOTH directions: an unreadable or unparseable
 * meta.json yields `null` (unknown), never a throw, because the caller is already reporting
 * a failure and must not lose it to a diagnostic.
 *
 * ⚠ `null` means "no stranded marker OBSERVED" — absence of evidence. meta.json is ~3 MB of
 * mostly fileHashes and can legitimately be unreadable mid-write, so callers must phrase it
 * as unobserved rather than as a positive all-clear.
 */
export function readStrandedIncompleteIndex(root: string): GitnexusIncompleteIndex | null {
  try {
    return readIncompleteIndexMarker(JSON.parse(readFileSync(gitnexusMetaPath(root), 'utf8')));
  } catch {
    return null;
  }
}

/** PURE — the operator-facing one-liner for a stranded index, or '' when none was observed. */
export function describeStrandedIncompleteIndex(marker: GitnexusIncompleteIndex | null): string {
  if (marker === null) return '';
  const bits = [
    marker.phase ? `phase=${marker.phase}` : null,
    marker.toWriteCount !== null ? `toWrite=${marker.toWriteCount}` : null,
    marker.startedAt !== null ? `startedAt=${new Date(marker.startedAt).toISOString()}` : null,
  ].filter(Boolean);
  return (
    ` ⚠ The index is left INCOMPLETE (incrementalInProgress${bits.length ? `: ${bits.join(' ')}` : ''}), ` +
    `so every subsequent tick is forced into a fresh FULL rebuild until one succeeds — if this ` +
    `repeats, the failure is wedged, not intermittent. The marker is deliberately NOT cleared: it ` +
    `is what stops a half-written index being served as if it were clean.`
  );
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

// ---------------------------------------------------------------------------
// THE OPEN-HANDLE DISCRIMINATOR (2026-08-23) — replacing a proxy with the fact.
//
// Every predicate above keys "is a build in flight?" on the shadow's SIZE. `size === 0`
// was chosen to mean "the writer is dead", but what it actually means is "the writer
// died at ONE PARTICULAR INSTANT" — after creating the shadow and before its first byte.
// A SIGKILL landing a second later leaves a NON-ZERO orphan that is byte-for-byte
// indistinguishable from a healthy live build, so it slips past BOTH size-keyed sites:
// `isDeadShadow` (the next tick's preflight) and the `writerKnownDead` branch (the kill
// site). Nothing then ever clears it, every read-only query fails with "Couldn't replay
// shadow pages under read-only mode", and the fleet-wide outage recurs looking like a
// brand-new bug.
//
// Not hypothetical: at 2026-08-23T20:50Z the live mid-analyze shadow on this box
// measured 800,280 bytes. A kill in that window strands exactly that shape.
//
// So stop testing the PROXY and test the FACT it proxies: does any process still hold
// the shadow open? A file no process has open cannot be being written to — that is a
// kernel guarantee, not an inference from a byte count or a clock.
// ---------------------------------------------------------------------------

/** The kernel appends this to an fd symlink whose file has been unlinked. */
const PROC_FD_DELETED_SUFFIX = ' (deleted)';

export interface OpenHandleProbe {
  /**
   * The scan itself ran to completion. FALSE means we learned nothing — no `/proc`
   * (non-Linux, or a container without it), or the target vanished — and the verdict is
   * UNKNOWN. It must never be read as "nobody has it open".
   */
  ok: boolean;
  /** Pids observed holding the path open. Non-empty ⇒ a writer is alive. */
  holders: number[];
  /** Process directories whose fd table was read successfully. */
  scannedPids: number;
  /**
   * Process directories that exist but are EACCES to us — almost always root daemons.
   * Reported so the assumption below is auditable rather than silent; see
   * `classifyWriterLiveness` for why it does not by itself force UNKNOWN.
   */
  unreadablePids: number;
}

export type WriterLiveness =
  /** A process holds the shadow open. NEVER touch it, whatever its size or age says. */
  | 'live'
  /** No process holds it. Nothing can be writing to it, whatever its size says. */
  | 'orphaned'
  /** The probe could not answer. Callers must degrade to the size/staleness proxy. */
  | 'unknown';

/**
 * PURE. Turn a probe into the verdict the residue policy actually needs.
 *
 * WHAT THIS PROBE CANNOT DISTINGUISH, stated rather than assumed — which is the whole
 * lesson the size proxy taught, applied to its own replacement:
 *
 *  1. **Another uid's fds.** `/proc/<pid>/fd` is EACCES across a uid boundary, so a
 *     holder running as a different user is invisible and `unreadablePids` counts it.
 *     That deliberately does NOT force 'unknown', because on every surface this ships
 *     to — the dev box and the packaged desktop app — the operator and any manual
 *     `gitnexus analyze` run as the SAME user, so the concurrent writer this exists to
 *     protect is always readable. Forcing 'unknown' on a nonzero count would disable
 *     the fix permanently on any box with a root daemon (i.e. all of them), trading a
 *     real observed outage for a hypothetical root-run analyze on this checkout.
 *  2. **A hard link under a different basename.** The inode cross-check below is
 *     narrowed by basename for cost, so a holder that opened the same inode by another
 *     name reads as absent. Nothing hard-links a LadybugDB shadow.
 *
 * Both unseen cases fail toward 'orphaned'. That is why the CALLER keeps a second,
 * independent corroborator (staleness away from the kill site; its own SIGKILL at it)
 * before acting on 'orphaned' — no single instrument gets to condemn a live build.
 */
export function classifyWriterLiveness(probe: OpenHandleProbe | null): WriterLiveness {
  if (!probe || !probe.ok) return 'unknown';
  return probe.holders.length > 0 ? 'live' : 'orphaned';
}

/**
 * Scan `/proc/*​/fd` for any process holding `targetPath` open.
 *
 * ⚠ DELIBERATELY PROBES THE SHADOW ONLY — never `lbug` itself. Readers hold the promoted
 * database open all the time; treating that as "a writer is alive" would pin every
 * shadow as live for as long as anyone is querying, which is the opposite failure. The
 * shadow is the build-in-progress artifact, so its holders are exactly its writers.
 *
 * ⚠ NOT argv matching. `proc-guard.mjs check "gitnexus analyze"` is a measured FALSE
 * NEGATIVE on the real analyze process — its argv is `…/gitnexus/dist/cli/index.js
 * analyze`, whose basename is `index.js` (EI-21277960228841563). An open fd is a fact
 * about this file; a command line is a string about a process that may not even be the
 * one holding it.
 */
export function probeOpenHandles(targetPath: string, procRoot = '/proc'): OpenHandleProbe {
  const probe: OpenHandleProbe = { ok: false, holders: [], scannedPids: 0, unreadablePids: 0 };

  let targetDev: number;
  let targetIno: number;
  try {
    const st = statSync(targetPath);
    targetDev = st.dev;
    targetIno = st.ino;
  } catch {
    // The target is gone. Callers gate this behind their own existence check, so rather
    // than claim a confident "no holders" for a file that isn't there, stay UNKNOWN and
    // let that existence check remain the authority on the vanished case.
    return probe;
  }

  let canonical = targetPath;
  try {
    canonical = realpathSync(targetPath);
  } catch {
    // Keep the literal path; the inode cross-check below still catches the holder.
  }
  const targetBase = path.basename(canonical);

  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return probe; // No /proc at all — verdict stays UNKNOWN, which is the safe direction.
  }
  probe.ok = true;

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `${procRoot}/${entry}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT/ESRCH is a process that exited mid-scan — not an unreadable one, and not
      // a holder either way. Only a permission refusal is a blind spot worth counting.
      if (code === 'EACCES' || code === 'EPERM') probe.unreadablePids += 1;
      continue;
    }
    probe.scannedPids += 1;
    for (const fd of fds) {
      const link = `${fdDir}/${fd}`;
      let dest: string;
      try {
        dest = readlinkSync(link);
      } catch {
        continue; // Closed between readdir and readlink.
      }
      // Sockets, pipes and anon_inodes read as `socket:[1234]` / `pipe:[…]` — never a file.
      if (!dest.startsWith('/')) continue;
      // An UNLINKED file still held open IS a live holder, so strip the kernel's marker
      // rather than skipping the row.
      const clean = dest.endsWith(PROC_FD_DELETED_SUFFIX)
        ? dest.slice(0, -PROC_FD_DELETED_SUFFIX.length)
        : dest;
      if (clean === canonical || clean === targetPath) {
        probe.holders.push(Number(entry));
        break;
      }
      // Identity, not spelling: a bind mount or a symlinked parent directory yields the
      // same inode under a different path string, and a pure string compare would miss
      // that holder — the one direction of error that corrupts a live build. Narrowed by
      // basename so this costs one extra stat per genuinely similar fd, not per fd.
      if (path.basename(clean) !== targetBase) continue;
      try {
        const s = statSync(link);
        if (s.ino === targetIno && s.dev === targetDev) {
          probe.holders.push(Number(entry));
          break;
        }
      } catch {
        // Deleted or vanished between readlink and stat — nothing further to learn.
      }
    }
  }
  return probe;
}

export interface OrphanShadowCleanup {
  cleaned: boolean;
  removed: string[];
  /** Which residue was found, for a log line that names the failure mode rather than the files. */
  kind: 'none' | 'orphan-shadow' | 'orphan-wal' | 'dead-shadow-wal';
  /**
   * How the shadow's liveness was established this run. Optional so no caller is
   * stranded; present so a journald line can say WHY a shadow was spared or removed
   * instead of leaving the next investigator to re-derive it.
   */
  writerLiveness?: WriterLiveness;
}

/**
 * Remove whichever crash residue is present so the next `analyze` — and, for the WAL
 * arm, every read in the meantime — can proceed. No-ops when the tree is healthy or a
 * build is genuinely in progress. Never throws: a missing/racing file during unlink is
 * exactly the "someone else already cleaned it" case and is swallowed like the rest of
 * this fail-soft action.
 */
export interface CleanCrashResidueOptions {
  /**
   * Set ONLY by a caller that has itself just killed the writer for this root.
   *
   * `DEAD_SHADOW_STALE_MS` is a PROXY for "no writer is alive"; a caller standing
   * at the kill site holds the FACT, so the proxy is redundant there — and
   * actively harmful, because the shadow it must clean is by definition seconds
   * old and so fails the staleness term for the next five minutes.
   *
   * It relaxes ONLY the staleness term. Until 2026-08-23 it also kept a zero-byte
   * requirement, on the reasoning that "a shadow with bytes in it could belong to a
   * concurrent MANUAL `gitnexus analyze`, which this must never delete" — sound intent,
   * wrong instrument. Size cannot tell a concurrent writer from a mid-write corpse, so
   * that term protected the manual analyze by ALSO protecting the orphan it was
   * supposed to clean. The open-handle probe answers the real question directly, so the
   * size term is now the FALLBACK for when the probe cannot run, not the primary test.
   */
  writerKnownDead?: boolean;
  /**
   * Seam for tests, and the escape hatch for a host without a usable `/proc`. Defaults
   * to the real scan. A probe that returns `ok:false` — or throws — yields UNKNOWN,
   * which degrades this function to exactly its pre-2026-08-23 size-only behaviour.
   */
  probeOpenHandles?: (targetPath: string) => OpenHandleProbe;
}

export function cleanCrashResidue(
  root: string,
  opts: CleanCrashResidueOptions = {},
): OrphanShadowCleanup {
  const { db, shadow, walCheckpoint, wal } = gitnexusDbPaths(root);
  const dbExists = existsSync(db);
  const shadowExists = existsSync(shadow);
  const walExists = existsSync(wal);

  // A shadow only counts as "a build is in flight" if it shows any sign of being one.
  // An empty, stale shadow is a corpse, and treating it as live is what left the tree
  // segfaulting on 2026-08-21 with NEITHER arm firing (see isDeadShadow).
  let shadowIsDead = false;
  let writerLiveness: WriterLiveness = 'unknown';
  if (shadowExists) {
    try {
      const st = statSync(shadow);
      const probeFn = opts.probeOpenHandles ?? probeOpenHandles;
      let probe: OpenHandleProbe | null = null;
      try {
        probe = probeFn(shadow);
      } catch {
        // A probe that throws taught us nothing. UNKNOWN, never "nobody holds it".
        probe = null;
      }
      writerLiveness = classifyWriterLiveness(probe);
      const shadowAgeMs = Date.now() - st.mtimeMs;

      if (writerLiveness === 'live') {
        // The kernel says a process still has this shadow open. That outranks every
        // other signal here — INCLUDING zero-bytes-and-stale, which the pre-probe code
        // would have deleted out from under a build that was merely slow to start.
        shadowIsDead = false;
      } else if (writerLiveness === 'orphaned') {
        // No process holds it, so nothing can be writing to it — whatever its size says.
        // THIS is the arm that closes the non-zero orphan gap. It still demands a second,
        // independent corroborator before condemning the file, because the probe has
        // stated blind spots (see classifyWriterLiveness): away from the kill site that
        // corroborator is staleness — a writer between two open() calls would still be
        // touching the file — and at the kill site it is the caller's own SIGKILL, which
        // is stronger evidence than any clock.
        shadowIsDead = opts.writerKnownDead === true || shadowAgeMs > DEAD_SHADOW_STALE_MS;
      } else {
        // No usable probe (no /proc, or it threw). Degrade to exactly the
        // pre-2026-08-23 rule: size is a poor instrument, but it is the one that
        // survives without the kernel's help, and it errs toward leaving files alone.
        shadowIsDead = opts.writerKnownDead
          ? st.size === 0
          : isDeadShadow(true, st.size, shadowAgeMs);
      }
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
    return { cleaned: false, removed: [], kind: 'none', writerLiveness };
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
  return { cleaned: removed.length > 0, removed, kind, writerLiveness };
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
  /** Latest on-disk LadybugDB size telemetry (optional for pre-monitor rows). */
  dbBytes?: number | null;
  dbMaxBytes?: number;
  dbUtilization?: number | null;
  dbHeadroomBytes?: number | null;
  /** Suppresses repeated ceiling alerts until usage falls below the threshold. */
  dbAlerted?: boolean;
  /**
   * WHOLE-index on-disk footprint, graded against the code-intelligence layer's
   * `indexDiskMbMax` selection budget (WI-2142942).
   *
   * Deliberately SEPARATE from `dbBytes` above, which stats the `lbug` file
   * alone against a different quantity — LadybugDB's 16GiB mmap cliff. Those
   * are not two readings of one number: measured 2026-09-03, lbug was 4946MB
   * of a 6558MB `.gitnexus/`, so 1607MB of parse caches was outside every
   * pre-existing instrument.
   */
  indexDiskMb?: number | null;
  indexDiskBudgetMb?: number;
  /** `within-budget` | `accepted-exceedance` | `over-ceiling` | `not-measured`. */
  indexDiskStatus?: string;
  /** Suppresses repeated over-ceiling alerts until the footprint comes back under. */
  indexDiskAlerted?: boolean;
  /** Vector-leg status from the last canary that ran (plan gitnexus-embeddings-enablement). */
  vectorSearch?: GitnexusVectorSearchHealth;
}

/**
 * The vector leg's health, persisted beside the failure streak so a DEGRADED graph (answers
 * definitions/callers, cannot answer a paraphrase) is visible in `/admin/schedules` and to
 * `routines:list` instead of only in a journald line nobody reads.
 */
export interface GitnexusVectorSearchHealth {
  /** `stats.embeddings` after the analyze; null ⇒ the registry did not report it. */
  embeddings: number | null;
  /** Did the analyze argv ask for embeddings? (analyzeEmbeddingsExpected) */
  expected: boolean;
  /** True when expected and absent — the canary's `degraded` verdict for this probe. */
  degraded: boolean;
  checkedAt: number;
}

export const GITNEXUS_HEALTH_DEFAULT: GitnexusHealth = {
  consecutiveFailures: 0,
  alerted: false,
  lastFailureAt: null,
  lastSuccessAt: null,
};

export interface GitnexusDbUsage {
  dbBytes: number | null;
  dbMaxBytes: number;
  dbUtilization: number | null;
  dbHeadroomBytes: number | null;
}

/** Read the real LadybugDB file size; a missing/unreadable index is in-band unknown. */
export function measureGitnexusDbUsage(
  root: string,
  maxBytes: number = GITNEXUS_LBUG_MAX_DB_BYTES,
): GitnexusDbUsage {
  const dbMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : GITNEXUS_LBUG_MAX_DB_BYTES;
  try {
    const dbBytes = statSync(gitnexusDbPaths(root).db).size;
    return {
      dbBytes,
      dbMaxBytes,
      dbUtilization: dbBytes / dbMaxBytes,
      dbHeadroomBytes: Math.max(0, dbMaxBytes - dbBytes),
    };
  } catch {
    return { dbBytes: null, dbMaxBytes, dbUtilization: null, dbHeadroomBytes: null };
  }
}

/** Wall-clock bound for the `.gitnexus/` walk. Truncation here is REPORTED. */
const GITNEXUS_INDEX_WALK_BUDGET_MS = 4_000;

/**
 * Measure the WHOLE `.gitnexus/` footprint and grade it against the
 * code-intelligence layer's `indexDiskMbMax` selection budget (WI-2142942).
 *
 * This is not a second reading of `measureGitnexusDbUsage`. That one stats the
 * `lbug` FILE against LadybugDB's mmap cliff — an outage threshold for the
 * storage engine. This one sizes the whole index directory against a selection
 * policy. Measured 2026-09-03 the two differ by 1607MB of parse caches that no
 * pre-existing instrument could see.
 *
 * ⚠ `maxEntries` is deliberately unbounded here, and that is a correctness
 * choice, not laziness: `dirSizeBytes` sets `budget.truncated` when it stops on
 * the wall-clock deadline but breaks SILENTLY when it hits `maxEntries`, so an
 * entry-capped walk under-counts with no way for a caller to know. Under-counting
 * is the dangerous direction — it turns a real breach into a clean pass — so the
 * only limit left binding is the one that reports itself, and a walk that runs
 * out of time grades `not-measured` rather than passing on a partial total.
 */
export function measureGitnexusIndexDisk(
  root: string,
  budgetMb: number = DEFAULT_RESOURCE_BUDGET.indexDiskMbMax,
): IndexDiskVerdict {
  const dir = path.join(root, '.gitnexus');
  if (!existsSync(dir)) return classifyIndexDisk('gitnexus', null, { budgetMb });

  const budget = { deadlineMs: Date.now() + GITNEXUS_INDEX_WALK_BUDGET_MS, truncated: false };
  let bytes: number;
  try {
    bytes = dirSizeBytes(dir, Number.MAX_SAFE_INTEGER, budget);
  } catch {
    // Absence, never a fabricated 0 — a zero would read as "costs nothing".
    return classifyIndexDisk('gitnexus', null, { budgetMb });
  }
  return classifyIndexDisk('gitnexus', Math.round(bytes / (1024 * 1024)), {
    truncated: budget.truncated === true,
    budgetMb,
  });
}

/**
 * PURE — fold an index-disk verdict into health, alerting ONCE per crossing.
 *
 * Alerts only on `over-ceiling`, never on `accepted-exceedance`. That
 * distinction is the whole reason the exceedance record exists: gitnexus is
 * knowingly 3.2x the budget today, so alerting on the breach itself would fire
 * on every tick from day one, and a gauge that is always red is one everyone
 * learns to scroll past — which is how this budget came to be ignored in the
 * first place. What is worth waking someone for is GROWTH past the bounded
 * ceiling we accepted.
 *
 * `not-measured` deliberately neither alerts nor clears the flag: it is an
 * absence of evidence, and letting it clear `indexDiskAlerted` would re-arm the
 * alert so a flapping measurement could page repeatedly for one condition.
 */
export function decideIndexDiskHealthUpdate(
  prev: GitnexusHealth,
  verdict: IndexDiskVerdict,
): { next: Pick<GitnexusHealth, 'indexDiskMb' | 'indexDiskBudgetMb' | 'indexDiskStatus' | 'indexDiskAlerted'>; shouldAlert: boolean } {
  const measuredMb = verdict.status === 'not-measured' ? null : verdict.measuredMb;
  const wasAlerted = prev.indexDiskAlerted === true;

  if (verdict.status === 'not-measured') {
    return {
      next: {
        indexDiskMb: null,
        indexDiskBudgetMb: verdict.budgetMb,
        indexDiskStatus: verdict.status,
        indexDiskAlerted: wasAlerted,
      },
      shouldAlert: false,
    };
  }

  const overCeiling = verdict.status === 'over-ceiling';
  return {
    next: {
      indexDiskMb: measuredMb,
      indexDiskBudgetMb: verdict.budgetMb,
      indexDiskStatus: verdict.status,
      indexDiskAlerted: overCeiling,
    },
    shouldAlert: overCeiling && !wasAlerted,
  };
}

export interface GitnexusDbHealthUpdate {
  next: Pick<GitnexusHealth, 'dbBytes' | 'dbMaxBytes' | 'dbUtilization' | 'dbHeadroomBytes' | 'dbAlerted'>;
  shouldAlert: boolean;
}

/** PURE — one alert when measured usage crosses the configured ceiling ratio. */
export function decideGitnexusDbHealthUpdate(
  prev: GitnexusHealth,
  usage: GitnexusDbUsage,
  threshold: number,
): GitnexusDbHealthUpdate {
  const ratio = Number.isFinite(threshold) ? Math.max(0, threshold) : GITNEXUS_LBUG_DB_ALERT_RATIO;
  if (usage.dbUtilization == null) {
    return {
      next: { ...usage, dbAlerted: prev.dbAlerted === true },
      shouldAlert: false,
    };
  }
  const above = usage.dbUtilization >= ratio;
  const shouldAlert = above && prev.dbAlerted !== true;
  return {
    next: { ...usage, dbAlerted: above },
    shouldAlert,
  };
}

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
      next: {
        ...prev,
        consecutiveFailures: 0,
        alerted: false,
        lastFailureAt: prev.lastFailureAt,
        lastSuccessAt: nowMs,
      },
      shouldAlert: false,
      shouldResolve: prev.alerted,
    };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const shouldAlert = consecutiveFailures >= threshold && !prev.alerted;
  return {
    next: {
      ...prev,
      consecutiveFailures,
      alerted: prev.alerted || shouldAlert,
      lastFailureAt: nowMs,
      lastSuccessAt: prev.lastSuccessAt,
    },
    shouldAlert,
    shouldResolve: false,
  };
}

/** Persist capacity telemetry on every tick and alert once per threshold crossing. */
async function trackGitnexusDbCapacity(
  ctx: SystemActionCtx,
  root: string,
  threshold: number,
): Promise<void> {
  const usage = measureGitnexusDbUsage(root);
  const indexDisk = measureGitnexusIndexDisk(root);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT metadata->'gitnexus_health' AS gh FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug],
    )) as Array<{ gh: Partial<GitnexusHealth> | null }>;
    const prev: GitnexusHealth = { ...GITNEXUS_HEALTH_DEFAULT, ...(rows[0]?.gh ?? {}) };
    const update = decideGitnexusDbHealthUpdate(prev, usage, threshold);
    const indexUpdate = decideIndexDiskHealthUpdate(prev, indexDisk);
    const next: GitnexusHealth = { ...prev, ...update.next, ...indexUpdate.next };
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug, JSON.stringify({ gitnexus_health: next })],
    );
    if (update.shouldAlert) {
      const { notifyAttention } = await import('../../attention-notify');
      const pct = Math.round((usage.dbUtilization ?? 0) * 1000) / 10;
      const gib = (usage.dbBytes ?? 0) / 1024 ** 3;
      const capGib = usage.dbMaxBytes / 1024 ** 3;
      await notifyAttention({
        kind: 'intervention',
        title: 'GitNexus LadybugDB is approaching its configured size ceiling',
        body:
          `The GitNexus LadybugDB for ${ctx.installSlug} is ${gib.toFixed(2)} GiB / ${capGib.toFixed(0)} GiB ` +
          `(${pct}% consumed; alert threshold ${Math.round(threshold * 100)}%). ` +
          'Raise GITNEXUS_LBUG_MAX_DB_BYTES deliberately before analyze reaches the ceiling; it is a virtual-address reservation, not resident memory.',
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: {
          dbBytes: usage.dbBytes,
          dbMaxBytes: usage.dbMaxBytes,
          dbUtilization: usage.dbUtilization,
          dbHeadroomBytes: usage.dbHeadroomBytes,
          threshold,
        },
      });
    }
    if (indexUpdate.shouldAlert && indexDisk.status === 'over-ceiling') {
      const { notifyAttention } = await import('../../attention-notify');
      const ceiling = indexDisk.acceptedCeilingMb;
      await notifyAttention({
        kind: 'intervention',
        title: 'GitNexus index has grown past its accepted on-disk ceiling',
        body:
          `The GitNexus index for ${ctx.installSlug} is ${indexDisk.measuredMb}MB, past the ` +
          `${ceiling === null ? `${indexDisk.budgetMb}MB selection budget` : `${ceiling}MB bounded allowance`} ` +
          'recorded in KNOWN_INDEX_DISK_EXCEEDANCES. That allowance accepts a MEASURED breach of the ' +
          `${indexDisk.budgetMb}MB budget; it does not accept unbounded growth, which is what this is. ` +
          'Either reclaim index disk or re-record the exceedance deliberately with a fresh measurement.',
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: {
          indexDiskMb: indexDisk.measuredMb,
          indexDiskBudgetMb: indexDisk.budgetMb,
          acceptedCeilingMb: ceiling,
          status: indexDisk.status,
        },
      });
    }
  } catch (e) {
    console.warn(`[gitnexus-reindex] DB capacity tracking failed: ${e instanceof Error ? e.message : e}`);
  }
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
  /**
   * A failing probe that DEGRADES the graph rather than making it unusable: reported in the
   * summary and persisted in health metadata, but it never flips `healthy`. Only the
   * vector-search probe uses it (a graph with no embeddings still answers every
   * definition/caller question — it just cannot answer a paraphrase).
   */
  degraded?: boolean;
}

export interface CanaryVerdict {
  /** False when any probe that indicates a genuinely unusable graph failed. */
  healthy: boolean;
  /** True when a `degraded` probe failed — the graph answers, but a capability is missing. */
  degraded: boolean;
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
  /** Embeddings present, from registry stats (`stats.embeddings`); null ⇒ not reported. */
  embeddings: number | null;
  /**
   * Did the analyze that produced this index ask for embeddings (`--embeddings` in the
   * argv — see analyzeEmbeddingsExpected)? When true, `embeddings == 0` is a DEGRADATION
   * (the vector leg silently died: cap re-armed, model failed to load, cache wiped) rather
   * than the accepted WI-35557 state it was before plan gitnexus-embeddings-enablement.
   */
  embeddingsExpected: boolean;
}

/**
 * PURE — the whole canary policy, testable without a graph, a subprocess, or a clock.
 *
 * Only the probes that mean "the graph cannot answer" set healthy=false. Vector status is
 * a DEGRADATION, never a failure: a graph with 0 embeddings still answers every definition
 * and caller question, and a canary that fails on a condition the graph survives is a canary
 * that gets muted — taking the real signal with it. It is still not silent: `degraded` is
 * set, the summary names it, and the routine persists it in `gitnexus_health.vectorSearch`.
 * Before embeddings were enabled (WI-35557) 0 was the accepted state, which is what the
 * `embeddingsExpected:false` branch still describes.
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
    vectorSearchProbe(i.embeddings, i.embeddingsExpected),
  ];
  const failed = probes.filter((p) => !p.ok && !p.degraded);
  const degradedProbes = probes.filter((p) => !p.ok && p.degraded);
  const degradedNote =
    degradedProbes.length === 0 ? '' : ` (DEGRADED: ${degradedProbes.map((p) => `${p.name}: ${p.detail}`).join(' | ')})`;
  return {
    healthy: failed.length === 0,
    degraded: degradedProbes.length > 0,
    probes,
    summary:
      failed.length === 0
        ? `canary OK${degradedNote} — ${probes.map((p) => p.detail).join('; ')}`
        : `canary FAILED (${failed.length}/${probes.length}): ${failed.map((p) => `${p.name}: ${p.detail}`).join(' | ')}${degradedNote}`,
  };
}

/** PURE — the vector-search probe. Degrades (never fails) when embeddings were asked for
 *  and are absent; pure status when they were not. */
export function vectorSearchProbe(embeddings: number | null, embeddingsExpected: boolean): CanaryProbe {
  const name = 'vector-search';
  if (embeddings != null && embeddings > 0) return { name, ok: true, detail: `${embeddings} embeddings` };
  if (!embeddingsExpected) {
    return {
      name,
      ok: true,
      detail:
        embeddings == null
          ? 'embeddings unknown (not requested by this analyze)'
          : '0 embeddings — not requested by this analyze (WI-35557 state); gitnexus.query has no vector leg, use context/cypher or grep',
    };
  }
  return {
    name,
    ok: false,
    degraded: true,
    detail:
      embeddings == null
        ? 'embeddings UNKNOWN after an embeddings-enabled analyze — registry stats carry no `embeddings`; the vector leg cannot be confirmed'
        : '0 embeddings after an embeddings-enabled analyze — the vector leg is DEAD (node cap re-armed, embedder failed to load, or cache wiped); definitions/callers still answer, paraphrase queries do not',
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
    const directCommand = process.env.GITNEXUS_NODE_BIN ?? process.execPath;
    const directArgs = analyzeNodeArgs(analyzeCliPath(), root, repoName);
    const invocation = buildAnalyzeInvocation(root, directCommand, directArgs);
    const managed = await managedSpawn(
      invocation.command,
      invocation.args,
      {
        class: 'build',
        title: `gitnexus analyze ${repoName}`,
        argv: [invocation.command, ...invocation.args],
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
export async function runCanary(
  root: string,
  registryFiles: number | null,
  embeddings: number | null,
  // Derived from the SAME argv builder the spawn uses, so the expectation cannot drift
  // from what was actually asked of gitnexus.
  embeddingsExpected: boolean = analyzeEmbeddingsExpected(buildAnalyzeArgs(root, GITNEXUS_REPO_NAME)),
): Promise<CanaryVerdict> {
  const bin = canaryBin();
  if (!existsSync(bin)) {
    return judgeCanary({
      fileCount: null,
      symbolCount: null,
      callEdgeCount: null,
      defEdgeCount: null,
      roundTripOk: null,
      embeddings,
      embeddingsExpected,
    });
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
  return judgeCanary({
    fileCount: fileCount ?? registryFiles,
    symbolCount,
    callEdgeCount,
    defEdgeCount,
    roundTripOk,
    embeddings,
    embeddingsExpected,
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
  const dbAlertRatio = num(cfg, 'db_alert_ratio', GITNEXUS_LBUG_DB_ALERT_RATIO);

  // Capacity telemetry is cheap and independent of whether this tick elects to run
  // the expensive analyzer, so record it before the cadence gates (including skips).
  await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);

  // Crash residue is a READ-AVAILABILITY fault, not an analyze-admission concern.
  // Clean it before cadence/load/memory gates: a skipped analyze is legitimate,
  // but leaving an orphan shadow or WAL in place makes every read-only GitNexus
  // query fail until some future tick happens to elect a full rebuild.
  const residue = cleanCrashResidue(root);
  if (residue.cleaned) {
    const why =
      residue.kind === 'orphan-shadow'
        ? 'shadow present, no database — a prior analyze died BEFORE promoting it'
        : residue.kind === 'dead-shadow-wal'
          ? 'an EMPTY, stale shadow beside a real database — a prior analyze was SIGKILLed mid-build (the 20-minute timeout does this). The empty shadow used to make this state match neither residue arm, so nothing cleaned it and every read-only open segfaulted on WAL replay'
          : 'pending WAL beside a real database with no shadow — a prior analyze was killed AFTER promoting it; every read-only open was segfaulting on WAL replay';
    console.warn(
      `[gitnexus-reindex] cleaned ${residue.kind.toUpperCase()} residue (${why}): ${residue.removed.join(', ')}`,
    );
  }

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
  let vectorSearch: GitnexusVectorSearchHealth | null = null;
  if (ranClean) {
    try {
      const after = readRegistryEntry(registryPath(), repoName) as
        | (GitnexusRegistryEntry & { stats?: { files?: number; embeddings?: number } })
        | null;
      const embeddingsAfter = after?.stats?.embeddings ?? null;
      const embeddingsExpected = analyzeEmbeddingsExpected(buildAnalyzeArgs(root, repoName));
      canary = await runCanary(root, after?.stats?.files ?? null, embeddingsAfter, embeddingsExpected);
      vectorSearch = { embeddings: embeddingsAfter, expected: embeddingsExpected, degraded: canary.degraded, checkedAt: Date.now() };
      console.log(`[gitnexus-reindex] ${canary.healthy ? 'canary OK' : 'CANARY FAILED'} — ${canary.summary}`);
      if (canary.degraded) {
        // Not a tick failure (the graph answers), but not silence either: the vector leg
        // regressing to 0 after bootstrap is exactly the state this plan exists to end.
        console.warn(`[gitnexus-reindex] canary DEGRADED — ${canary.summary}`);
      }
    } catch (e) {
      // Never let canary plumbing fail a tick that genuinely succeeded.
      console.warn(`[gitnexus-reindex] canary could not run: ${e instanceof Error ? e.message : e}`);
    }
  }
  // A successful analyze can grow the DB across the threshold during this very tick;
  // refresh immediately instead of waiting an hour for the next cadence.
  if (ranClean) await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);
  const success = ranClean && (canary == null || canary.healthy);

  // Read the incomplete-index marker on the FAILURE path only: on a success it is expected
  // to be absent, and on a failure it is the fact that separates a one-off from a wedged
  // rebuild loop. Reported, never cleared — see readStrandedIncompleteIndex.
  const stranded = success ? null : readStrandedIncompleteIndex(root);
  const strandedNote = describeStrandedIncompleteIndex(stranded);
  if (strandedNote) console.warn(`[gitnexus-reindex]${strandedNote}`);

  if (r.timedOut) {
    // Recover the residue HERE, not on the next tick.
    //
    // Deferring it to the preflight was measured to leave GitNexus segfaulting
    // fleet-wide for the whole gap — on 2026-08-23 the 19:35 tick was killed at
    // 19:55 and the next preflight was not due until 20:35, so every graph read
    // died for ~40 minutes of that hour. The kill above is positive proof the
    // writer is gone, which is exactly the fact `writerKnownDead` exists to
    // carry: without it the just-created shadow is younger than
    // DEAD_SHADOW_STALE_MS and no arm fires.
    //
    // Fail-soft like the rest of this action: a cleanup that cannot run must
    // never turn a timed-out tick into a thrown one, because the next tick's
    // preflight is still there as the backstop.
    let recovered: OrphanShadowCleanup | null = null;
    try {
      recovered = cleanCrashResidue(root, { writerKnownDead: true });
    } catch (e) {
      console.warn(
        `[gitnexus-reindex] post-timeout residue cleanup could not run: ${e instanceof Error ? e.message : e}`,
      );
    }
    // Name the liveness verdict, not just the outcome. "No residue was present" and "a
    // holder made us spare it" look identical from the outside and mean opposite things,
    // and re-deriving which one happened after the fact is exactly what cost this bug a
    // second investigation.
    const livenessNote =
      recovered?.writerLiveness === 'live'
        ? ' ⚠ A process still holds the shadow open despite the kill (a concurrent manual `gitnexus analyze`?) — it was deliberately SPARED.'
        : recovered?.writerLiveness === 'unknown'
          ? ' (open-handle probe unavailable — fell back to the zero-byte size proxy, which cannot see a mid-write orphan.)'
          : '';
    console.warn(
      `[gitnexus-reindex] TIMED OUT after ${timeoutMs}ms (${elapsedSec}s) — process tree killed. ` +
        (recovered?.cleaned
          ? `Crash residue (D-016) recovered IMMEDIATELY (${recovered.kind}): ${recovered.removed.join(', ')} — ` +
            'reads stay answerable instead of segfaulting until the next tick.'
          : "No crash residue was present to recover; the next tick's cleanCrashResidue() preflight remains the backstop.") +
        livenessNote,
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
    // The vector leg's status rides in the same record; a tick whose canary did not run
    // keeps the previous reading rather than erasing it.
    const nextHealth: GitnexusHealth = vectorSearch ? { ...update.next, vectorSearch } : update.next;
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug, JSON.stringify({ gitnexus_health: nextHealth })],
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
          `${(r.stderr || r.stdout).slice(-300)}${strandedNote}`,
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: {
          consecutiveFailures: update.next.consecutiveFailures,
          timedOut: r.timedOut,
          code: r.code,
          incompleteIndex: stranded,
        },
      });
    } else if (update.shouldResolve) {
      console.log(`[gitnexus-reindex] recovered after a ${prevHealth.consecutiveFailures}-failure streak`);
    }
  } catch (e) {
    console.warn(`[gitnexus-reindex] health tracking failed: ${e instanceof Error ? e.message : e}`);
  }
});
