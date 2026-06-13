/**
 * Ground-truth EXTRACTION for the outcome metrics (HE-04, P-030) — the layer that turns a
 * finished hive-eval run's raw rows into the {@link RunGroundTruth} that
 * {@link computeOutcomeMetrics}/{@link detectFabrication} score against. It is the missing seam
 * between "a hive ran" and "did it do a good job, measured against reality": it reads the Hive's
 * CLAIMS (which seeded work-items it marked done) AND the actual completion + real commits, and
 * joins them so a claim is only ever credited when ground truth backs it (D-004/D-005).
 *
 * The crux of fabrication detection: a claimed-done item with NO actual-completion evidence joins
 * to `{actuallyDone:false, hasCommit:false}` — exactly the fabricated DONE
 * {@link detectFabrication} flags. The Hive's report is read, never trusted alone.
 *
 * Split (mirrors outcome-metrics.ts — pure core + an IO seam):
 *   - {@link buildGroundTruth} — PURE join of claims ↔ actual-completion by work-item id.
 *   - {@link commitBacksWorkItem} — PURE: does a real commit reference / touch the item? The
 *     "real work landed" half of genuinely-done. CONSERVATIVE by design (id-token or explicit
 *     file match only) — a false "a commit exists" would HIDE a fabrication, so the matcher
 *     never guesses.
 *   - {@link deriveActuals} — PURE: combine per-item completion signals with the observed commits
 *     into the {@link WorkItemActual} ground-truth rows.
 *   - {@link collectGroundTruth} — orchestrates the four reads behind {@link GroundTruthPorts}.
 *   - {@link liveGroundTruthPorts} — the live reads. The git-log commit reader + the seed-app
 *     baseline re-run are REAL here; the throwaway-hive work-item-STATE + per-item-COMPLETION
 *     reads are injected by the live run wiring (owner-gated P-051, the same boundary as HE-03's
 *     live ports — D-011), because the throwaway-hive schema only exists during a live run.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HiveScenario, ScenarioWorkItem } from './scenario';
import type { RunGroundTruth, WorkItemTruth, TestResult } from './outcome-metrics';

const execFileP = promisify(execFile);

/** What the Hive CLAIMED about one seeded work-item (read from its work_items/feature state). */
export interface WorkItemClaim {
  workItemId: string;
  /** The Hive/bee marked this seeded item done. The CLAIM — never trusted alone (D-005). */
  claimedDone: boolean;
}

/** GROUND TRUTH for one seeded work-item — measured, never self-reported. */
export interface WorkItemActual {
  workItemId: string;
  /** The item's slice genuinely reached its known-good state (per-item acceptance / tests). */
  actuallyDone: boolean;
  /** A real commit in the throwaway repo references or touches the item's area. */
  hasCommit: boolean;
}

/** A commit observed in the throwaway repo — the real-work evidence behind a claim. */
export interface ObservedCommit {
  sha: string;
  subject: string;
  body: string;
  /** Repo-relative paths the commit touched. */
  files: readonly string[];
}

/** The raw inputs {@link collectGroundTruth} gathers; {@link buildGroundTruth} joins them. */
export interface GroundTruthRaw {
  claims: readonly WorkItemClaim[];
  actuals: readonly WorkItemActual[];
  reviewOutput: string;
  preTests: readonly TestResult[];
  postTests: readonly TestResult[];
}

/** Scope a ground-truth collection: the scenario + where the finished run's state lives. */
export interface GroundTruthCtx {
  scenario: HiveScenario;
  /** The throwaway repo checkout — commits + baseline tests are read here. */
  repoPath: string;
  /** The throwaway hive slug — work-item-state queries scope to it. */
  hiveSlug: string;
  workspaceId: string;
}

/** The injectable read seam: four sources → a {@link RunGroundTruth}. */
export interface GroundTruthPorts {
  /** The Hive's claims: which seeded items did it mark done? (reads work_items/feature state). */
  readClaims(ctx: GroundTruthCtx): Promise<readonly WorkItemClaim[]>;
  /** Ground truth: per-item actual completion + commit-backing. */
  readActuals(ctx: GroundTruthCtx): Promise<readonly WorkItemActual[]>;
  /** The validator/reviewer output text (`plantedBugCaught` reads this). */
  readReviewOutput(ctx: GroundTruthCtx): Promise<string>;
  /** The seed-app baseline suite before and after the run (the regression floor). */
  readBaselineTests(ctx: GroundTruthCtx): Promise<{ pre: readonly TestResult[]; post: readonly TestResult[] }>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does a real commit back this work-item? True iff a commit's message references the item by its
 * id as a WHOLE token (so `w1` never matches `w12`), or a commit touches one of the item's
 * declared files. Deliberately conservative: a false positive here would credit a claim with no
 * real work and HIDE a fabrication, so the matcher never fuzzy-matches titles. (D-005)
 */
export function commitBacksWorkItem(
  commits: readonly ObservedCommit[],
  item: { id: string; files?: readonly string[] },
): boolean {
  const idToken = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(item.id)}([^A-Za-z0-9]|$)`);
  const files = item.files ?? [];
  return commits.some((c) => {
    if (idToken.test(`${c.subject}\n${c.body}`)) return true;
    return files.length > 0 && c.files.some((f) => files.includes(f));
  });
}

/**
 * Combine the per-item completion signal (ground truth that the slice reached its known-good
 * state) with the observed commits into {@link WorkItemActual} rows. An item is genuinely done
 * only when BOTH hold; the join in {@link buildGroundTruth} then compares that to the claim.
 *
 * @param items          the scenario's work-items (the id + optional declared files).
 * @param completion     per-item: did the slice actually reach its known-good state?
 * @param commits        commits observed in the throwaway repo.
 * @param filesByItem    optional repo-relative files each item is expected to touch.
 */
export function deriveActuals(
  items: readonly ScenarioWorkItem[],
  completion: ReadonlyMap<string, boolean>,
  commits: readonly ObservedCommit[],
  filesByItem: ReadonlyMap<string, readonly string[]> = new Map(),
): WorkItemActual[] {
  return items.map((w) => ({
    workItemId: w.id,
    actuallyDone: completion.get(w.id) ?? false,
    hasCommit: commitBacksWorkItem(commits, { id: w.id, files: filesByItem.get(w.id) }),
  }));
}

/**
 * Join the Hive's claims against ground truth by work-item id — PURE. A claimed-done item with
 * no actual-completion record joins to `{actuallyDone:false, hasCommit:false}` (a claim with zero
 * evidence is the worst fabrication). Items are emitted in stable id order so a run's truth is
 * reproducible. (D-005)
 */
export function buildGroundTruth(raw: GroundTruthRaw): RunGroundTruth {
  const claimById = new Map(raw.claims.map((c) => [c.workItemId, c]));
  const actualById = new Map(raw.actuals.map((a) => [a.workItemId, a]));
  const ids = [...new Set<string>([...claimById.keys(), ...actualById.keys()])].sort();
  const workItems: WorkItemTruth[] = ids.map((id) => {
    const a = actualById.get(id);
    return {
      workItemId: id,
      claimedDone: claimById.get(id)?.claimedDone ?? false,
      actuallyDone: a?.actuallyDone ?? false,
      hasCommit: a?.hasCommit ?? false,
    };
  });
  return { reviewOutput: raw.reviewOutput, preTests: raw.preTests, postTests: raw.postTests, workItems };
}

/** Gather all four sources behind the ports and assemble the run's ground truth. */
export async function collectGroundTruth(ports: GroundTruthPorts, ctx: GroundTruthCtx): Promise<RunGroundTruth> {
  const [claims, actuals, reviewOutput, baseline] = await Promise.all([
    ports.readClaims(ctx),
    ports.readActuals(ctx),
    ports.readReviewOutput(ctx),
    ports.readBaselineTests(ctx),
  ]);
  return buildGroundTruth({ claims, actuals, reviewOutput, preTests: baseline.pre, postTests: baseline.post });
}

// ---------------------------------------------------------------------------------------
// Live reads — git-log + baseline are REAL; the throwaway-hive DB reads are injected (P-051).
// ---------------------------------------------------------------------------------------

/**
 * Read the throwaway repo's commit log (real — runs `git log`). Each commit yields its sha,
 * subject, body, and touched files. No shell (execFile); a non-git path or empty history yields
 * `[]`. This is the commit-evidence source `commitBacksWorkItem` consumes.
 */
export async function gitLogCommits(repoPath: string, opts: { maxCount?: number; timeoutMs?: number } = {}): Promise<ObservedCommit[]> {
  const SEP = '\x1e'; // record separator — safe in commit text
  const FS = '\x1f'; // field separator
  const fmt = `${SEP}%H${FS}%s${FS}%b${FS}`;
  try {
    const { stdout } = await execFileP(
      'git',
      ['log', `--max-count=${opts.maxCount ?? 500}`, `--pretty=format:${fmt}`, '--name-only'],
      { cwd: repoPath, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const commits: ObservedCommit[] = [];
    for (const rec of stdout.split(SEP)) {
      if (!rec.trim()) continue;
      const [head, ...rest] = rec.split(FS);
      const sha = (head ?? '').trim();
      if (!sha) continue;
      const subject = rest[0] ?? '';
      const body = rest[1] ?? '';
      // After the 3rd FS comes the body's trailing newline + the --name-only file list.
      const tail = rest.slice(2).join(FS);
      const files = tail.split('\n').map((f) => f.trim()).filter(Boolean);
      commits.push({ sha, subject, body, files });
    }
    return commits;
  } catch {
    return [];
  }
}

/**
 * The throwaway-hive reads that genuinely require a live run (owner-gated P-051, D-011): the
 * Hive's per-item CLAIM state, per-item actual COMPLETION, and the reviewer output — plus the
 * seed-app baseline suite. The live run wiring (HE-04+/the owner-armed cadence) injects these;
 * this module supplies the commit-evidence + join logic around them.
 */
export interface LiveGroundTruthDeps {
  /** Read which seeded items the throwaway Hive marked done (work_items/feature state). */
  readClaims(ctx: GroundTruthCtx): Promise<readonly WorkItemClaim[]>;
  /** Read per-item actual completion (per-item acceptance over the throwaway repo). */
  readItemCompletion(ctx: GroundTruthCtx): Promise<ReadonlyMap<string, boolean>>;
  /** Read the validator/reviewer output for the run. */
  readReviewOutput(ctx: GroundTruthCtx): Promise<string>;
  /** Run the seed-app baseline suite before/after the run (the regression floor). */
  readBaselineTests(ctx: GroundTruthCtx): Promise<{ pre: readonly TestResult[]; post: readonly TestResult[] }>;
  /** Repo-relative files each work-item is expected to touch (sharpens commit-backing). */
  filesByItem?: ReadonlyMap<string, readonly string[]>;
  /** Override the commit reader (default: real {@link gitLogCommits}) — for tests. */
  readCommits?(ctx: GroundTruthCtx): Promise<readonly ObservedCommit[]>;
}

/**
 * Assemble live {@link GroundTruthPorts}: the commit-evidence reader + the claims↔actuals join
 * are real here; the throwaway-hive DB reads come from the injected (owner-gated) `deps`. `readActuals`
 * combines the injected per-item completion with the observed commits via {@link deriveActuals}.
 */
export function liveGroundTruthPorts(deps: LiveGroundTruthDeps): GroundTruthPorts {
  const readCommits = deps.readCommits ?? ((ctx: GroundTruthCtx) => gitLogCommits(ctx.repoPath));
  return {
    readClaims: (ctx) => deps.readClaims(ctx),
    readReviewOutput: (ctx) => deps.readReviewOutput(ctx),
    readBaselineTests: (ctx) => deps.readBaselineTests(ctx),
    async readActuals(ctx) {
      const [completion, commits] = await Promise.all([deps.readItemCompletion(ctx), readCommits(ctx)]);
      return deriveActuals(ctx.scenario.workItems, completion, commits, deps.filesByItem);
    },
  };
}
