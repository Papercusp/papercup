/**
 * Per-process singleton that mirrors three FS data sources to PG so that
 * panels can read via Zero's WS push instead of polling REST:
 *
 *   .papercusp/summary.md             → harness_shared.harness_summaries
 *   .papercusp/pending-reviews/*.json → harness_shared.pending_reviews
 *   .papercusp/proposals/*.md         → harness_shared.harness_proposals_shared
 *
 * Architecture:
 *   - chokidar watches every registered project's `.papercusp/` directory,
 *     across all three phased worktrees (staging, testing, production).
 *   - Per-path debounced upserts (200ms) collapse fast-fire writes from
 *     agent processes to a single PG roundtrip.
 *   - awaitWriteFinish stabilises events on partial writes.
 *   - A 60-second reconciliation sweep compares filesystem mtimes against
 *     PG `mtime_ms` and replays any divergence — catches dropped inotify
 *     events under memory pressure. Also deletes orphan rows whose file
 *     is gone from disk (so resolved reviews leave the inbox).
 *   - Pinned to globalThis to survive Next.js dev module re-evaluation
 *     (anti-pattern A18 from /docs/performance).
 *
 * Phase awareness (Item 2 of the polling-removal arc):
 *   - Each project may have up to three worktrees: staging (project.path),
 *     testing (`<path>--testing` or config override), production
 *     (`<path>--production` or override). The watcher mirrors all three
 *     when their .papercusp/ directories exist.
 *   - Every PG row carries a `phase` column. (harness_slug, phase, ...)
 *     is the composite PK across all three mirror tables.
 *   - phasePath() and ALL_PHASES are imported from @/lib/harness-phases
 *     so the watcher and the API routes share a single source of truth.
 *
 * Lifecycle:
 *   - Started lazily on first /api/harness/* request via ensureHarnessFsWatcher().
 *   - Re-reads the project list on each reconcile tick so newly-registered
 *     harnesses get watched without a process restart.
 *   - SIGTERM handler stops chokidar cleanly so inotify watches release.
 *
 * Workspace switch behavior:
 *   - The project list is loaded via await loadHarnessRegistry().
 *   - On workspace switch, the registry on the operator side flips, but the
 *     watcher's `state.projects` was loaded once at start. The 60s reconcile
 *     re-reads await loadHarnessRegistry() and adds/removes watch paths, so the
 *     watcher converges within ~60s.
 *   - During that window, the previous workspace's harnesses are still
 *     watched. Live events from harnesses that no longer belong to the active
 *     workspace would still upsert PG rows stamped with the *current*
 *     activeWorkspaceId(), creating cross-workspace pollution. Mitigation:
 *     resyncing the watcher on workspace switch would close this window;
 *     untracked TODO until the workspace-aware project model lands.
 *     Item 2 expands the watcher's footprint 3× (one set per phase), so
 *     the staleness window is proportionally wider during a switch.
 */
import { promises as fs, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename, dirname } from 'node:path';

const execFileP = promisify(execFile);
import chokidar, { type FSWatcher } from 'chokidar';

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';

const hsum = generated.harnessSummariesInHarnessShared;
const prev = generated.pendingReviewsInHarnessShared;
const hps = generated.harnessProposalsSharedInHarnessShared;
const hph = generated.harnessPhasesInHarnessShared;
const hba = generated.harnessBranchActionsInHarnessShared;
import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { activeWorkspaceId } from './workspace-registry';
import { ALL_PHASES, phasePath, type Phase } from './harness-phases';
import { notifySyncInvalidate } from './sync-sse';

// not a DBOS candidate (dbos-scheduler-consolidation-2026-06-03 D-002 / P-011):
// the watcher is event-driven (chokidar); this 60s tick is only a reconcile
// BACKSTOP for dropped inotify events + in-process watcher state. A detached DBOS
// cron would lose the watcher's in-memory view — it stays in-process.
const RECONCILE_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 200;

/**
 * Paths chokidar must never walk or poll.
 *
 * The dispatch only needs *structured* files — summary.md, `*.json` reviews,
 * `*.md` proposals, the per-branch action metadata. It does NOT need the
 * high-volume append-only run logs under `action-runs/<branch>/…`: those grow
 * continuously, so chokidar's `awaitWriteFinish` (50 ms poll) would `lstat`
 * every one of them forever and they never stabilise. Across a busy fleet ×
 * 15–19 harnesses that pegged the operator host's event loop at ~100% — every
 * `/api/*` route then starved past the 30 s route watchdog (the
 * `psu: route exceeded 30s` outage, 2026-06-05). The branch-actions mirror
 * recomputes from `listActions` (the structured files), so dropping log-only
 * events loses no signal. `node_modules` / `.git` / `embedded-pg-data*` are
 * defensive guards so a broad watched root can never trigger a recursive walk
 * into a huge tree.
 */
const WATCHER_IGNORED_RE =
  /(?:^|\/)(?:node_modules|\.git|embedded-pg-data[^/]*)(?:\/|$)|\.(?:swp|swo|tmp|log)$/;

/** True when chokidar should ignore `p` (never emit events for / recurse into
 *  it). Exported for unit testing. */
export function isWatcherIgnored(p: string): boolean {
  return WATCHER_IGNORED_RE.test(p);
}

interface WatcherState {
  watcher: FSWatcher;
  /**
   * Secondary chokidar instance with `depth: 0` that fires events for
   * every file at the top of each `<harness-dir>/`. Lets us pick up
   * pattern-matched files we can't enumerate ahead of time (e.g.
   * `checkpoint-*.md`, `checkpoint-*.md.granted`) without recursing
   * into the dozens of subdirs the harness writes into. Wired to the
   * same `classifyAndDispatch`; debounce keys dedupe overlap with
   * the recursive watcher's specific-file watches.
   */
  topWatcher: FSWatcher;
  /**
   * Watches `~/.papercusp/harnesses/<slug>/enabled-plugins.json`. The
   * papercusp CLI writes this file directly (bypassing the operator API),
   * so without an FS watcher PG can drift. Mirroring on every change
   * keeps `harness_shared.plugin_enables` canonical for read paths.
   */
  enabledPluginsWatcher: FSWatcher;
  projects: ProjectEntry[];
  /**
   * Paths currently subscribed on `watcher` / `topWatcher`. Tracked
   * explicitly (rather than re-derived from `projects`) because the
   * derivation is existence-filtered: a dir that existed at subscribe
   * time but was deleted since would vanish from a re-derivation on
   * BOTH sides of the reconcile diff, never get unwatched, and leave
   * chokidar watching its (possibly /tmp-sized) parent.
   */
  watchedPathSet: Set<string>;
  topWatchedPathSet: Set<string>;
  reconcileTimer: ReturnType<typeof setInterval>;
  debouncers: Map<string, ReturnType<typeof setTimeout>>;
  stopped: boolean;
}

type _G = { __harnessFsWatcher?: WatcherState };
const _g = globalThis as unknown as _G;

/** All phased .papercusp/ directories that may exist for a project. */
function harnessDirsForProject(p: ProjectEntry): Array<{ phase: Phase; harnessDir: string }> {
  return ALL_PHASES.map((phase) => {
    const root = phasePath(p, phase);
    return { phase, harnessDir: join(root, '.papercusp') };
  });
}

/**
 * Watch paths chokidar should subscribe to for a given project.
 *
 * EXISTENCE-ANCHORED: every returned path must have an existing anchor
 * dir *inside* the project. chokidar watches the nearest existing
 * ancestor of a missing path to detect its creation — for a registry
 * entry whose project dir is gone (e.g. a cleaned-up /tmp e2e project)
 * that ancestor is /tmp or $HOME, giant high-churn dirs whose every
 * event triggers a full lstat-per-entry rescan. Two operators watching
 * /tmp (11k entries) burned ~1.6 cores each and saturated their event
 * loops (2026-06-06 incident). Paths whose anchor appears later are
 * picked up by the 60s reconcile re-derivation in reconcileAll().
 */
export function watchedPaths(p: ProjectEntry): string[] {
  const out: string[] = [];
  if (!existsSync(p.path)) return out; // dead project — never watch outside it
  for (const { harnessDir } of harnessDirsForProject(p)) {
    if (!existsSync(harnessDir)) continue; // anchor missing — reconcile adds it later
    out.push(
      join(harnessDir, 'summary.md'),
      join(harnessDir, 'pending-reviews'),
      join(harnessDir, 'proposals'),
      // pending-issues.jsonl: chokidar dispatch retired; producer-time
      // PG writes from operator endpoints replaced the mirror.
      // config.json, tests/, escalation.md, supervisor-notes.md,
      // archives, prs.json, plan-review.md, smoke-{pass,failure}.md,
      // smoke-results.json, smoke-startup.log: producer-time PG writes
      // retired the watcher dispatch on these paths.
      // skills: producer-time PG writes via _post_curator_outputs.
      // debug/, logs/hooks, screenshots, run.log: chokidar
      // dispatch retired across this arc — producer-time PG writes via
      // their respective endpoints.
      // Per-branch action scripts and run logs — feed harness_branch_actions.
      join(harnessDir, 'actions'),
      join(harnessDir, 'action-runs'),
    );
  }
  // Git-log: chokidar dispatch retired. Refresh now happens at 60s
  // reconcile cadence + on explicit UI request. No fs.watch on .git/.
  return out;
}

/**
 * harnessDirs the depth-0 topWatcher should subscribe to. Same
 * existence anchor as watchedPaths() — a missing harnessDir would make
 * chokidar watch its ancestors (project root, /tmp, $HOME).
 */
export function topWatchPaths(p: ProjectEntry): string[] {
  return harnessDirsForProject(p)
    .map(({ harnessDir }) => harnessDir)
    .filter((d) => existsSync(d));
}

function debounce(state: WatcherState, key: string, fn: () => Promise<void>): void {
  const existing = state.debouncers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    state.debouncers.delete(key);
    fn().catch((e) => {
      console.warn(`[harness-fs-watcher] ${key} write failed:`, e?.message ?? e);
    });
  }, DEBOUNCE_MS);
  state.debouncers.set(key, t);
}

interface PhasedMatch {
  project: ProjectEntry;
  phase: Phase;
  harnessDir: string;
}

/** Find the (project, phase) whose .harness dir contains `p`. */
function phaseForPath(state: WatcherState, p: string): PhasedMatch | null {
  for (const project of state.projects) {
    for (const { phase, harnessDir } of harnessDirsForProject(project)) {
      if (p === harnessDir || p.startsWith(harnessDir + '/')) {
        return { project, phase, harnessDir };
      }
    }
  }
  return null;
}

async function upsertSummary(slug: string, phase: Phase, path: string): Promise<void> {
  const { db } = getOrgPg();
  let content = '';
  let mtimeMs = 0;
  try {
    const buf = await fs.readFile(path);
    content = buf.toString('utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return; // file vanished mid-debounce
  }
  const ws = activeWorkspaceId();
  await db
    .insert(hsum)
    .values({
      harnessSlug: slug,
      phase,
      content,
      mtimeMs: Math.floor(mtimeMs),
      updatedAt: Date.now(),
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [hsum.harnessSlug, hsum.phase],
      set: {
        content: dsql`EXCLUDED.content`,
        mtimeMs: dsql`EXCLUDED.mtime_ms`,
        updatedAt: dsql`EXCLUDED.updated_at`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
}

async function deleteSummary(slug: string, phase: Phase): Promise<void> {
  const { db } = getOrgPg();
  await db.delete(hsum).where(and(eq(hsum.harnessSlug, slug), eq(hsum.phase, phase)));
}

interface ReviewPayload {
  id?: string;
  featureId?: string;
  kind?: string;
  ts?: number;
  resolved?: boolean;
  [k: string]: unknown;
}

async function upsertReview(slug: string, phase: Phase, path: string): Promise<void> {
  const reviewId = path.split('/').pop()?.replace(/\.json$/, '') ?? '';
  if (!reviewId) return;
  let payload: ReviewPayload = {};
  let mtimeMs = 0;
  try {
    const raw = await fs.readFile(path, 'utf8');
    payload = JSON.parse(raw) as ReviewPayload;
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return;
  }
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const featureId = typeof payload.featureId === 'string' ? payload.featureId : null;
  const kind = typeof payload.kind === 'string' ? payload.kind : 'unknown';
  await db
    .insert(prev)
    .values({
      harnessSlug: slug,
      phase,
      reviewId: reviewId,
      featureId: featureId,
      kind,
      payload: payload as any,
      ts: Number.isFinite(payload.ts) ? Number(payload.ts) : Math.floor(mtimeMs),
      resolved: !!payload.resolved,
      mtimeMs: Math.floor(mtimeMs),
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [prev.harnessSlug, prev.phase, prev.reviewId],
      set: {
        featureId: dsql`EXCLUDED.feature_id`,
        kind: dsql`EXCLUDED.kind`,
        payload: dsql`EXCLUDED.payload`,
        ts: dsql`EXCLUDED.ts`,
        resolved: dsql`EXCLUDED.resolved`,
        mtimeMs: dsql`EXCLUDED.mtime_ms`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
}

async function deleteReview(slug: string, phase: Phase, path: string): Promise<void> {
  const reviewId = path.split('/').pop()?.replace(/\.json$/, '') ?? '';
  if (!reviewId) return;
  const { db } = getOrgPg();
  await db
    .delete(prev)
    .where(and(eq(prev.harnessSlug, slug), eq(prev.phase, phase), eq(prev.reviewId, reviewId)));
}

// Proposals are markdown (.md), not JSON. The accept/reject endpoints
// append `applied: true` / `appliedAt: <iso>` (or rejected:/rejectedAt:)
// into the file body — the file is the source-of-truth invariant. Sibling
// <id>.review.md (if present) carries `VERDICT: accept|reject|defer` plus
// a summary line. Both are parsed here so the panel can read structured
// fields from PG instead of re-reading every file.
function parseFooterTimestamp(body: string, key: string): number | null {
  const re = new RegExp('^' + key + ':\\s*(.+)$', 'm');
  const m = body.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function upsertProposal(slug: string, phase: Phase, path: string): Promise<void> {
  const filename = path.split('/').pop() ?? '';
  if (!filename.endsWith('.md') || filename.endsWith('.review.md')) return;
  const proposalId = filename;
  let body = '';
  let mtimeMs = 0;
  let sizeBytes = 0;
  try {
    body = await fs.readFile(path, 'utf8');
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    sizeBytes = st.size;
  } catch {
    return;
  }

  const applied = /^applied:\s*true/m.test(body);
  const rejected = /^rejected:\s*true/m.test(body);
  const status = applied ? 'applied' : rejected ? 'rejected' : 'pending';
  const appliedAt = applied
    ? (parseFooterTimestamp(body, 'appliedAt') ?? Math.floor(mtimeMs))
    : null;
  const rejectedAt = rejected
    ? (parseFooterTimestamp(body, 'rejectedAt') ?? Math.floor(mtimeMs))
    : null;

  let reviewVerdict: string | null = null;
  let reviewSummary: string | null = null;
  let reviewedAt: number | null = null;
  const reviewPath = path.replace(/\.md$/, '.review.md');
  try {
    const reviewBody = await fs.readFile(reviewPath, 'utf8');
    const verdictMatch = reviewBody.match(/^VERDICT:\s*(accept|reject|defer)\b/im);
    if (verdictMatch) reviewVerdict = verdictMatch[1].toLowerCase();
    try { reviewedAt = Math.floor(statSync(reviewPath).mtimeMs); } catch {}
    const summaryLine = reviewBody
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^VERDICT:/i.test(l) && !/^#/.test(l));
    reviewSummary = summaryLine ? summaryLine.slice(0, 240) : null;
  } catch { /* no reviewer file */ }

  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const ts = Math.floor(mtimeMs);
  await db
    .insert(hps)
    .values({
      harnessSlug: slug,
      phase,
      proposalId: proposalId,
      status,
      reviewVerdict: reviewVerdict,
      reviewSummary: reviewSummary,
      reviewedAt: reviewedAt,
      appliedAt: appliedAt,
      rejectedAt: rejectedAt,
      sizeBytes: sizeBytes,
      payload: { body } as any,
      ts,
      mtimeMs: Math.floor(mtimeMs),
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [hps.harnessSlug, hps.phase, hps.proposalId],
      set: {
        status: dsql`EXCLUDED.status`,
        reviewVerdict: dsql`EXCLUDED.review_verdict`,
        reviewSummary: dsql`EXCLUDED.review_summary`,
        reviewedAt: dsql`EXCLUDED.reviewed_at`,
        appliedAt: dsql`EXCLUDED.applied_at`,
        rejectedAt: dsql`EXCLUDED.rejected_at`,
        sizeBytes: dsql`EXCLUDED.size_bytes`,
        payload: dsql`EXCLUDED.payload`,
        ts: dsql`EXCLUDED.ts`,
        mtimeMs: dsql`EXCLUDED.mtime_ms`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
}

async function deleteProposal(slug: string, phase: Phase, path: string): Promise<void> {
  const filename = path.split('/').pop() ?? '';
  if (!filename.endsWith('.md') || filename.endsWith('.review.md')) return;
  const proposalId = filename;
  const { db } = getOrgPg();
  await db
    .delete(hps)
    .where(and(eq(hps.harnessSlug, slug), eq(hps.phase, phase), eq(hps.proposalId, proposalId)));
}

// ── Mirror 4 retired: harness_pending_issues is now written at producer
// time by operator endpoints (/:slug/issues/pending, /:slug/issues/triage,
// /:slug/issues/clear). Validator role POSTs each finding directly.

// ── Mirror 5: harness_phases (config.json + worktree existence) ────────
//
// Triggered by config.json changes OR by the 60s reconcile sweep. Encodes a
// subset of /api/harness/<slug>/phases (the parts the dashboard actually
// reads). Runtime fields (alive, iteration, passed/total/cost) are best-
// effort: they reflect the snapshot at write time, not live process state.

async function upsertPhases(project: ProjectEntry): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  for (const { phase, harnessDir } of harnessDirsForProject(project)) {
    const phasePathStr = phasePath(project, phase);
    const exists = existsSync(harnessDir);
    let mtimeMs = 0;
    try { mtimeMs = statSync(harnessDir).mtimeMs; } catch {}
    // Best-effort per-phase fields from the workspace-PG instance config
    // (ProjectEntry.phases), not config.json (deprecate-harness-config-json-2026-06-06).
    // branch is derived (null for staging ⇒ read live from git HEAD by the
    // /phases route; the phase label otherwise), matching the phases route.
    const phaseInst = project.phases?.[phase];
    const branch: string | null = phase === 'staging' ? null : phase;
    const port: number | null = typeof phaseInst?.port === 'number' ? (phaseInst.port as number) : null;
    const publicUrl: string | null = typeof phaseInst?.publicUrl === 'string' ? (phaseInst.publicUrl as string) : null;
    await db
      .insert(hph)
      .values({
        harnessSlug: project.slug,
        phase,
        phasePath: phasePathStr,
        branch,
        port,
        publicUrl: publicUrl,
        existsOnDisk: exists,
        alive: false,
        passedCount: 0,
        totalCount: 0,
        costUsd: 0,
        iteration: 0,
        promotionInFlight: false,
        mtimeMs: Math.floor(mtimeMs),
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [hph.harnessSlug, hph.phase],
        set: {
          phasePath: dsql`EXCLUDED.phase_path`,
          branch: dsql`EXCLUDED.branch`,
          port: dsql`EXCLUDED.port`,
          publicUrl: dsql`EXCLUDED.public_url`,
          existsOnDisk: dsql`EXCLUDED.exists_on_disk`,
          mtimeMs: dsql`EXCLUDED.mtime_ms`,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
  }
}

// ── Mirror 6 retired: harness_tests is now written at producer time
// by bash run.sh's NEXT_TESTER block → /api/internal/test-snapshot.

// ── Mirror 7 retired: harness_escalations is now written at producer
// time by bash run.sh's plan-reviewer rejection path + bin/supervisor.sh
// → /api/internal/escalation-event.

// ── Mirror 7b retired: harness_archives is now written at producer
// time by bash run.sh's archiveOnDone hook → /api/internal/archive-event.

// ── Mirror 7b9 retired: harness_skills is now written at producer
// time by bash run.sh's _post_curator_outputs after `invoke curator`
// → /api/internal/skill-snapshot.

// ── Mirrors 7c1/7c2/7d retired: feature_prs, feature_debug_notes, and
// smoke_test are now written at producer time:
//   - PRs:        bash run.sh → POST /api/internal/pr-event
//   - debug note: bash run.sh debugger hook → POST /api/internal/feature-debug-note-event
//   - smoke test: bin/service-smoke-test.sh → POST /api/internal/smoke-test-event
// Watcher mirror handlers + reconcile sweeps deleted in this commit.

// ── Mirror 7c retired: harness_plan_review is now written at producer
// time by bash run.sh's plan-review block → /api/internal/plan-review-event.

// ── Mirror 7e retired: harness_checkpoints is now written at producer
// time by bash run.sh's checkpoint emitters → /api/internal/checkpoint-event
// (create) and the operator's grant endpoint (grant).

// ── Mirror 7f retired: harness_hook_logs is now written at producer
// time by bash run.sh's run_hook() → /api/internal/hook-log-event.
// HOOK_KEEP=50 cap is enforced by the endpoint on each insert.

// ── Mirror 7g retired: harness_screenshots is now written at producer
// time by the operator's POST/DELETE /:slug/screenshots endpoints.

// ── Mirror 7h retired: harness_decisions is now written at producer
// time by bash run.sh's log() → /api/internal/decision-event. The
// fs.watch + tail-grep parser was deleted in the same commit.

// ── Mirror 7i RETIRED: harness_git_log → on-demand REST ────────────────
// The git_log mirror was a pure cache over `git log` (git is the canonical
// producer). The UI (RealGitPanel / AdvGitPanel) now reads the on-demand
// /api/harness/<slug>/git/log route (3s-TTL cached, shells out live) — it
// always did, so the mirror was already UI-orphaned. The
// harness_shared.harness_git_log table is dropped in migration 258.
// (fs-watcher-retirement-2026-05-10 step 1.)

// ── Mirror 7k: harness_branch_actions (per-branch enriched action list) ─
//
// Mirrors the existing /api/harness/<slug>/branch/<branch>/actions
// payload shape, keyed on (slug, branch). Watcher inputs that trigger
// recompute via the dispatcher: action scripts (.sh) and action-run logs
// (.json). Other inputs (plugin enables/configs, global plugin manifests)
// pick up via the 60s reconcile pass — they change rarely.

const BRANCH_ACTION_BRANCHES = ['staging', 'testing', 'production'] as const;

async function replaceBranchActions(
  slug: string,
  branch: string,
  projectPath: string,
): Promise<void> {
  // Lazy-imported to keep harness-fs-watcher lightweight at module load
  // (these helpers pull plugin-config + manifest resolution).
  const [{ listActions, listRuns }, { resolveEnv }, { papercuspPath }] = await Promise.all([
    import('./branch-actions'),
    import('./branch-action-manifest'),
    import('./papercusp-root'),
  ]);
  const harnessConfigsDir = papercuspPath('harnesses', slug);
  const globalPluginsDir = papercuspPath('global-plugins');

  let payload: { branch: string; actions: unknown[] };
  try {
    const actions = await listActions(
      projectPath,
      branch as 'staging' | 'testing' | 'production',
      { harnessConfigsDir, globalPluginsDir },
    );
    const envReadCache = new Map<string, Promise<unknown>>();
    const enriched = await Promise.all(
      actions.map(async (a) => {
        const runs = await listRuns(
          projectPath,
          branch as 'staging' | 'testing' | 'production',
          a.name,
        );
        const envResolution = a.manifest?.env
          ? await resolveEnv(a.manifest, {
              harnessConfigsDir,
              contributingPlugin: a.pluginSlug,
              readCache: envReadCache,
            })
          : { env: {}, missing: [] };
        return {
          name: a.name,
          source: a.source,
          pluginSlug: a.pluginSlug,
          displayName: a.manifest?.displayName ?? a.name,
          description: a.manifest?.description,
          scriptPath: a.scriptPath,
          env: a.manifest?.env ?? null,
          envStatus: {
            ok: envResolution.missing.length === 0,
            resolved: Object.keys(envResolution.env),
            missing: envResolution.missing,
          },
          lastRun: runs[0] ?? null,
        };
      }),
    );
    payload = { branch, actions: enriched };
  } catch (e) {
    // Compute failure (e.g. plugin manifest parse error) — skip the
    // upsert rather than wiping the row with a bad payload.
    console.warn(`[harness-fs-watcher] branch-actions compute failed for ${slug}:${branch}:`, (e as Error)?.message);
    return;
  }
  const { db, sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const payloadJson = JSON.stringify(payload);
  // Diff check uses PG's `IS DISTINCT FROM` (semantic jsonb comparison).
  // Kept as raw sql since drizzle's eq() does string-equal, not the
  // jsonb-aware variant we need.
  const diff = await sql<{ changed: boolean }[]>`
    SELECT (
      NOT EXISTS (
        SELECT 1 FROM harness_shared.harness_branch_actions
         WHERE harness_slug = ${slug} AND branch = ${branch}
      )
      OR EXISTS (
        SELECT 1 FROM harness_shared.harness_branch_actions
         WHERE harness_slug = ${slug} AND branch = ${branch}
           AND payload IS DISTINCT FROM ${payloadJson}::text::jsonb
      )
    ) AS changed
  `;
  await db
    .insert(hba)
    .values({
      harnessSlug: slug,
      branch,
      payload: payload as any,
      lastCheckMs: Date.now(),
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [hba.harnessSlug, hba.branch],
      set: {
        payload: dsql`EXCLUDED.payload`,
        lastCheckMs: dsql`EXCLUDED.last_check_ms`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
  if (diff[0]?.changed) {
    await notifySyncInvalidate('harnessBranchActions.byHarnessAndBranch', { harnessSlug: slug, branch });
  }
}

function classifyAndDispatch(
  state: WatcherState,
  path: string,
  kind: 'add' | 'change' | 'unlink',
): void {
  // Git ref change: not dispatched. git is the producer and there's no
  // producer-event for "user committed" — and the harness_git_log mirror
  // is retired (fs-watcher-retirement step 1). The UI reads the on-demand
  // /api/harness/<slug>/git/log REST route (3s-TTL cached) instead.

  const match = phaseForPath(state, path);
  if (!match) return;
  const { project, phase, harnessDir: hd } = match;
  const slug = project.slug;

  if (path === join(hd, 'summary.md')) {
    debounce(state, `summary:${slug}:${phase}`, async () => {
      if (kind === 'unlink') await deleteSummary(slug, phase);
      else await upsertSummary(slug, phase, path);
    });
    return;
  }

  // Pending reviews: top-level *.json only. Skip nested archive subdirs.
  const reviewsDir = join(hd, 'pending-reviews');
  if (
    path.startsWith(reviewsDir + '/') &&
    path.endsWith('.json') &&
    !path.slice(reviewsDir.length + 1).includes('/')
  ) {
    debounce(state, `review:${slug}:${phase}:${path}`, async () => {
      if (kind === 'unlink') await deleteReview(slug, phase, path);
      else await upsertReview(slug, phase, path);
    });
    return;
  }

  // Proposals: top-level *.md only; .review.md siblings trigger an upsert
  // of the parent so review_verdict/review_summary refresh.
  const proposalsDir = join(hd, 'proposals');
  if (
    path.startsWith(proposalsDir + '/') &&
    path.endsWith('.md') &&
    !path.slice(proposalsDir.length + 1).includes('/')
  ) {
    if (path.endsWith('.review.md')) {
      const parent = path.replace(/\.review\.md$/, '.md');
      debounce(state, `proposal:${slug}:${phase}:${parent}`, async () => {
        await upsertProposal(slug, phase, parent);
      });
      return;
    }
    debounce(state, `proposal:${slug}:${phase}:${path}`, async () => {
      if (kind === 'unlink') await deleteProposal(slug, phase, path);
      else await upsertProposal(slug, phase, path);
    });
    return;
  }

  // Pending issues: written at producer time by the operator's
  // /:slug/issues/pending and /:slug/issues/triage endpoints.
  // Validator role POSTs each finding directly. Watcher mirror retired.

  // Phases: chokidar dispatch retired. config.json is updated by
  // operator endpoints (promotion, port assignment) and by bash
  // worktree creation; producer-time PG writes from those sites are
  // tracked separately. The reconcileAll() sweep below still calls
  // upsertPhases(proj) at 60s cadence as a safety net for structural
  // changes (worktree dirs created/destroyed) without a clean
  // producer hook.

  // Tests: written at producer time by bash run.sh's NEXT_TESTER block
  // → /api/internal/test-snapshot. Watcher mirror retired.

  // Escalations: written at producer time by bash run.sh (plan-reviewer
  // rejection) and bin/supervisor.sh → /api/internal/escalation-event.
  // Watcher mirror retired.

  // Archives: any *.tar.gz event in the archives/ dir → replace-all rescan.
  // Debounce key is per (slug, phase) so a burst of 5 file events does one
  // rescan, not five.
  // Archives: bash run.sh's archiveOnDone hook now POSTs each new
  // .tar.gz to /api/internal/archive-event at producer time.

  // Skills: written at producer time by bash run.sh's
  // _post_curator_outputs after `invoke curator` →
  // /api/internal/skill-snapshot. Watcher mirror retired.

  // PRs: bash run.sh's branch-iso onPass=pr handler now POSTs each PR
  // to /api/internal/pr-event at producer time. The .papercusp/prs.json
  // file write was retired alongside the chokidar mirror.

  // Plan-review: written at producer time by bash run.sh's plan-review
  // block after the reviewer LLM finishes → /api/internal/plan-review-event.
  // Watcher mirror retired.

  // Feature debug notes: bash run.sh's debugger hook now POSTs each
  // note to /api/internal/feature-debug-note-event at producer time.

  // Smoke test: bin/service-smoke-test.sh now POSTs the aggregated
  // outcome to /api/internal/smoke-test-event when it decides
  // pass/fail. The 4 sibling files are still written for human
  // inspection but the chokidar re-aggregation has been retired.

  // Checkpoints: chokidar dispatch retired.
  //   - checkpoint-*.md CREATE: bash run.sh's checkpoint emitters POST
  //     to /api/internal/checkpoint-event at producer time.
  //   - .granted: operator-side grant endpoint already writes the row
  //     directly (1c4a84f orchestrator-pg arc).

  // validation-contract.md presence is now refreshed by the 60s
  // reconcile sweep; chokidar dispatch retired (see SPEC.md note above).

  // Branch actions: KEPT mirror — this is a derived-view cache where the
  // input data is genuinely scattered across many sources (harness-shipped
  // .sh scripts, every enabled plugin's manifest, per-run audit JSON, env
  // resolution from plugin-configs + env.json). No single producer-time
  // hook can rebuild the cache without re-doing the same fan-in work the
  // mirror does on each chokidar event. Watching the two source dirs for
  // change events is the right primitive here.
  for (const dir of ['actions', 'action-runs'] as const) {
    const root = join(hd, dir);
    if (path.startsWith(root + '/')) {
      const rest = path.slice(root.length + 1);
      const branch = rest.split('/')[0];
      if ((BRANCH_ACTION_BRANCHES as readonly string[]).includes(branch)) {
        debounce(state, `branchActions:${slug}:${branch}`, async () => {
          await replaceBranchActions(slug, branch, project.path);
        });
        return;
      }
    }
  }

  // Hook logs: written at producer time by bash run.sh's run_hook
  // → /api/internal/hook-log-event. Watcher mirror retired.

  // Screenshots: written at producer time by the operator's POST/DELETE
  // /:slug/screenshots endpoints (which directly INSERT/DELETE the PG
  // row). Watcher mirror retired.

  // Decisions: bash run.sh's log() now POSTs each `ORCH decision: ...`
  // line directly to /api/internal/decision-event, which writes the
  // harness_decisions row at producer time. The fs.watch + tail-grep
  // mirror has been retired.
}

async function reconcileAll(state: WatcherState): Promise<void> {
  // Re-read the registry so newly-added harnesses get picked up.
  const reg = await loadHarnessRegistry();
  const newProjects = reg.projects ?? [];

  // If the project list (or path existence) shifted, re-add watch paths.
  // Diff against the *recorded* subscription sets, not a re-derivation —
  // see the watchedPathSet doc comment.
  const newPaths = new Set(newProjects.flatMap(watchedPaths));
  for (const p of newPaths) if (!state.watchedPathSet.has(p)) state.watcher.add(p);
  for (const p of state.watchedPathSet) if (!newPaths.has(p)) state.watcher.unwatch(p);
  state.watchedPathSet = newPaths;
  // Same housekeeping for the top-level (checkpoint-pattern) watcher.
  const newTopPaths = new Set(newProjects.flatMap(topWatchPaths));
  for (const p of newTopPaths) if (!state.topWatchedPathSet.has(p)) state.topWatcher.add(p);
  for (const p of state.topWatchedPathSet) if (!newTopPaths.has(p)) state.topWatcher.unwatch(p);
  state.topWatchedPathSet = newTopPaths;
  state.projects = newProjects;

  // Phases: re-mirror once per project (covers all 3 phases internally).
  for (const proj of newProjects) {
    try { await upsertPhases(proj); } catch {}
  }

  // Enabled-plugins reconcile: walk ~/.papercusp/harnesses/<slug>/ and
  // re-mirror each enabled-plugins.json into PG. Catches direct CLI
  // writes that happened while the watcher was down or before cold start.
  try {
    const { papercuspPath } = await import('./papercusp-root');
    const { mirrorHarness } = await import('./plugin-enables-pg');
    const epRoot = papercuspPath('harnesses');
    if (existsSync(epRoot)) {
      const entries = await fs.readdir(epRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = join(epRoot, e.name, 'enabled-plugins.json');
        if (!existsSync(file)) continue;
        try { await mirrorHarness(e.name); } catch {}
      }
    }
  } catch (e) {
    console.warn('[harness-fs-watcher] enabled-plugins reconcile failed:', (e as Error)?.message ?? e);
  }

  // Per-project sweeps (not phase-scoped).
  for (const proj of newProjects) {
    // Branch actions: recompute all 3 branches per project. This is the
    // catch-all for plugin-config / global-manifest changes that aren't
    // wired into chokidar — those land at 60s reconcile cadence.
    for (const branch of BRANCH_ACTION_BRANCHES) {
      try { await replaceBranchActions(proj.slug, branch, proj.path); } catch {}
    }
  }

  // Walk each (project, phase) and replay anything with diverged mtime.
  for (const proj of newProjects) {
    for (const { phase, harnessDir: hd } of harnessDirsForProject(proj)) {
      if (!existsSync(hd)) continue;

      // Pending issues: written at producer time by operator endpoints.
      // No reconcile sweep needed.

      // Tests: written at producer time by bash run.sh NEXT_TESTER →
      // /api/internal/test-snapshot. No reconcile sweep needed.

      // Escalations: written at producer time by bash run.sh +
      // bin/supervisor.sh → /api/internal/escalation-event. No
      // reconcile sweep needed.

      // Archives: written at producer time by bash run.sh
      // archiveOnDone → /api/internal/archive-event. No reconcile
      // sweep needed.

      // Screenshots: written at producer time by operator POST/DELETE
      // /:slug/screenshots endpoints. No reconcile sweep needed.

      // Decisions: written at producer time by bash run.sh log() →
      // /api/internal/decision-event. No reconcile sweep needed.

      // Plan-review: only stored once per harness (staging path only).
      if (phase === 'staging') {
        // Plan-review: written at producer time by bash run.sh →
        // /api/internal/plan-review-event. No reconcile sweep needed.

        // Checkpoints: written at producer time by bash run.sh →
        // /api/internal/checkpoint-event (create) and operator grant
        // endpoint (grant). No reconcile sweep needed.

        // Hook logs: written at producer time by bash run.sh run_hook
        // → /api/internal/hook-log-event. No reconcile sweep needed.

        // Smoke test: written at producer time by bin/service-smoke-test.sh
        // → /api/internal/smoke-test-event. No reconcile sweep needed.
      }

      const summaryPath = join(hd, 'summary.md');
      if (existsSync(summaryPath)) {
        try {
          const fsMtime = Math.floor(statSync(summaryPath).mtimeMs);
          const { db } = getOrgPg();
          const rows = await db
            .select({ mtime_ms: hsum.mtimeMs })
            .from(hsum)
            .where(and(eq(hsum.harnessSlug, proj.slug), eq(hsum.phase, phase)));
          if (rows.length === 0 || Number(rows[0].mtime_ms) !== fsMtime) {
            await upsertSummary(proj.slug, phase, summaryPath);
          }
        } catch {}
      }

      for (const sub of ['pending-reviews', 'proposals'] as const) {
        const dir = join(hd, sub);
        const fsIds = new Set<string>();
        if (existsSync(dir)) {
          try {
            const files = await fs.readdir(dir, { withFileTypes: true });
            for (const ent of files) {
              if (!ent.isFile()) continue;
              const f = ent.name;
              const isReview = sub === 'pending-reviews' && f.endsWith('.json');
              const isProposal = sub === 'proposals' && f.endsWith('.md') && !f.endsWith('.review.md');
              if (!isReview && !isProposal) continue;
              const path = join(dir, f);
              const id = isReview ? f.replace(/\.json$/, '') : f;
              fsIds.add(id);
              const fsMtime = Math.floor(statSync(path).mtimeMs);
              if (sub === 'pending-reviews') {
                const { db } = getOrgPg();
                const rows = await db
                  .select({ mtime_ms: prev.mtimeMs })
                  .from(prev)
                  .where(and(eq(prev.harnessSlug, proj.slug), eq(prev.phase, phase), eq(prev.reviewId, id)));
                if (rows.length === 0 || Number(rows[0].mtime_ms) !== fsMtime) {
                  await upsertReview(proj.slug, phase, path);
                }
              } else {
                const { db } = getOrgPg();
                const rows = await db
                  .select({ mtime_ms: hps.mtimeMs })
                  .from(hps)
                  .where(and(eq(hps.harnessSlug, proj.slug), eq(hps.phase, phase), eq(hps.proposalId, id)));
                if (rows.length === 0 || Number(rows[0].mtime_ms) !== fsMtime) {
                  await upsertProposal(proj.slug, phase, path);
                }
              }
            }
          } catch {}
        }

        // Orphan delete: rows in PG whose FS file is gone.
        try {
          const { db } = getOrgPg();
          if (sub === 'pending-reviews') {
            const pgIds = await db
              .select({ id: prev.reviewId })
              .from(prev)
              .where(and(eq(prev.harnessSlug, proj.slug), eq(prev.phase, phase)));
            for (const { id } of pgIds) {
              if (!fsIds.has(id)) {
                await db
                  .delete(prev)
                  .where(and(eq(prev.harnessSlug, proj.slug), eq(prev.phase, phase), eq(prev.reviewId, id)));
              }
            }
          } else {
            const pgIds = await db
              .select({ id: hps.proposalId })
              .from(hps)
              .where(and(eq(hps.harnessSlug, proj.slug), eq(hps.phase, phase)));
            for (const { id } of pgIds) {
              if (!fsIds.has(id)) {
                await db
                  .delete(hps)
                  .where(and(eq(hps.harnessSlug, proj.slug), eq(hps.phase, phase), eq(hps.proposalId, id)));
              }
            }
          }
        } catch {}
      }
    }
  }
}

/**
 * Idempotent. Starts the watcher on first call; subsequent calls return
 * the existing state. Safe to call from any /api/harness/* route.
 */
export async function ensureHarnessFsWatcher(): Promise<WatcherState> {
  if (_g.__harnessFsWatcher) return _g.__harnessFsWatcher;

  const reg = await loadHarnessRegistry();
  const projects = reg.projects ?? [];
  const allPaths = projects.flatMap(watchedPaths);
  const topPaths = projects.flatMap(topWatchPaths);

  const watcher = chokidar.watch(allPaths, {
    persistent: true,
    // ignoreInitial: true — initial state is captured by reconcileAll()
    // on watcher startup. The 'add' events for already-existing files
    // would otherwise fire 8× per (slug, path) every time Turbopack
    // HMR re-creates the watcher, which produces a sustained
    // multi-events/sec invalidation storm on the dashboard.
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    // Ignore swap/temp files AND high-volume `*.log` appends + bulky trees —
    // see WATCHER_IGNORED_RE. (The previous /\/\.\w/ regex matched '.h' in
    // '.papercusp' and silently dropped every event under the watched dirs;
    // this one is anchored to path segments + extensions so it can't.)
    ignored: isWatcherIgnored,
  });

  // Top-level watcher (depth: 0) catches checkpoint-*.md / *.granted
  // and any other top-of-harness files we can't enumerate ahead of
  // time. Events for files the recursive watcher already sees collapse
  // via the dispatcher's debounce keys.
  const topWatcher = chokidar.watch(topPaths, {
    persistent: true,
    ignoreInitial: true,  // see above
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: isWatcherIgnored,
  });

  // Watch ~/.papercusp/harnesses/<slug>/enabled-plugins.json. depth:1
  // so we see per-harness files but don't recurse into plugin payloads.
  const { papercuspPath: _ppForWatch } = await import('./papercusp-root');
  const enabledPluginsRoot = _ppForWatch('harnesses');
  const enabledPluginsWatcher = chokidar.watch(enabledPluginsRoot, {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: isWatcherIgnored,
  });

  const state: WatcherState = {
    watcher,
    topWatcher,
    enabledPluginsWatcher,
    projects,
    watchedPathSet: new Set(allPaths),
    topWatchedPathSet: new Set(topPaths),
    reconcileTimer: setInterval(() => {
      reconcileAll(state).catch((e) =>
        console.warn('[harness-fs-watcher] reconcile failed:', e?.message ?? e),
      );
    }, RECONCILE_INTERVAL_MS),
    debouncers: new Map(),
    stopped: false,
  };

  for (const w of [watcher, topWatcher]) {
    w.on('add', (p) => classifyAndDispatch(state, p, 'add'))
     .on('change', (p) => classifyAndDispatch(state, p, 'change'))
     .on('unlink', (p) => classifyAndDispatch(state, p, 'unlink'))
     .on('error', (e) => {
       console.warn('[harness-fs-watcher] chokidar error:', (e as Error)?.message ?? e);
     });
  }

  const onEnabledPluginsEvent = (p: string) => {
    if (!p.endsWith('enabled-plugins.json')) return;
    const slug = basename(dirname(p));
    if (!slug || slug === 'harnesses') return;
    debounce(state, `enabledPlugins:${slug}`, async () => {
      const { mirrorHarness } = await import('./plugin-enables-pg');
      try { await mirrorHarness(slug); } catch (e) {
        console.warn(`[harness-fs-watcher] mirrorHarness(${slug}) failed:`, (e as Error)?.message ?? e);
      }
    });
  };
  enabledPluginsWatcher
    .on('add', onEnabledPluginsEvent)
    .on('change', onEnabledPluginsEvent)
    .on('unlink', onEnabledPluginsEvent)
    .on('error', (e) => {
      console.warn('[harness-fs-watcher] enabled-plugins chokidar error:', (e as Error)?.message ?? e);
    });

  // Initial reconcile so cold-boot picks up anything that existed before
  // the watcher started.
  void reconcileAll(state).catch(() => {});

  // SIGTERM cleanup. SIGINT (Ctrl-C in dev) too.
  const shutdown = () => stopHarnessFsWatcher();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  _g.__harnessFsWatcher = state;
  return state;
}

export function stopHarnessFsWatcher(): void {
  const state = _g.__harnessFsWatcher;
  if (!state || state.stopped) return;
  state.stopped = true;
  for (const t of state.debouncers.values()) clearTimeout(t);
  state.debouncers.clear();
  clearInterval(state.reconcileTimer);
  void state.watcher.close();
  void state.topWatcher.close();
  void state.enabledPluginsWatcher.close();
  _g.__harnessFsWatcher = undefined;
}
