/**
 * The registered derived-read producers — the three measured offenders from the
 * WI-5460 audit (precompute-derived-sync-reads-2026-07-19 P-003/P-004/P-005).
 *
 * Each one moves an expensive computation OFF the user-facing sync read path and
 * onto the `system:precompute-derived-reads` routine. The resolver then does a
 * plain SELECT against `harness_shared.derived_read_snapshots`.
 *
 * Imported for side effect by the routine action and by the sync resolver, so a
 * read and a refresh always agree on which producers exist.
 *
 * TTLs are chosen from how fast the underlying signal actually moves, NOT from
 * how expensive the compute is — an expensive producer with a short ttl is the
 * routine's problem to schedule, never the reader's problem to wait for.
 */
import { withWorkspace } from '@papercusp/db-org';
import { registerDerivedRead } from './registry';

// ── storage.usage (P-003) — measured 20.0s on the read path ──────────────────
//
// A recursive du-style disk walk plus PG catalog sizing. The pre-fix code ran it
// inline and mitigated the pain with a wall-clock budget (DISK_BUDGET_MS,
// EI-6045) that returned PARTIAL sizes with an apologetic note — a mitigation
// that existed only because the walk was on the read path. Precomputed, the walk
// can run to completion and report accurate sizes.
//
// Disk usage moves slowly; a 30-minute snapshot is far fresher than a Settings
// page needs.
registerDerivedRead({
  key: 'storage.usage',
  ttlMs: 30 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { computeStorageUsage } = await import('../storage/usage');
    // `offReadPath` raises the disk-walk budget: nobody is waiting on this, so
    // the walk can finish and report complete sizes instead of the partial ones
    // the 20s read-path budget produced on a large store.
    return computeStorageUsage({ offReadPath: true });
  },
});

// ── plans.lint (P-004) — measured 13.8s on the read path, 158.8s to compute ──
//
// ⚠ THIS PRODUCER ALSO FIXES A SILENTLY-BROKEN QUERY (found while backfilling).
//
// The resolver has always done `Array.isArray(r?.reports) ? r.reports : []`. But
// the lint tool's ALL-PLANS default branch returns `summarizeLintReports(reports)`
// — a bounded summary object with NO `reports` field (`reports` exists only on the
// `full: true` branch, and on the per-slug bulk envelope). So the nullary
// `plans.lint` sync query has ALWAYS returned `[]`: it linted the entire corpus
// and threw the result away. The backfill made it obvious — 158.8s of compute
// producing a 5-byte payload.
//
// Passing `full: true` gives the resolver the `reports` array it always declared.
// `full` is documented as OFF-by-default because the complete dump (484 plans ×
// hundreds of warnings → 170KB+) can exceed the AGENT result-size cap — a limit
// that does not apply here: this payload goes into a jsonb column, not an agent's
// context, and it is no longer on a read path at all.
//
// SIX-HOUR ttl — deliberately the longest here, on a cost/benefit the other two
// do not face. At ~159s per compute this is by far the most expensive producer:
// on a 30-minute cadence it would spend ~9% of wall-clock doing heavy fs+PG work
// inside the operator process, which is real event-loop pressure (the EI-6045
// lesson) for a query that currently has NO UI consumer — nothing in
// apps/operator-vite or apps/operator reads `plans.lint`. A corpus-wide lint also
// changes slowly by nature.
//
// If a live consumer appears and needs it fresher, the fix is to make the lint
// itself incremental (lint only plans whose updated_at moved), not to shorten
// this ttl — see WI-5460.
registerDerivedRead({
  key: 'plans.lint',
  ttlMs: 6 * 60 * 60_000,
  producerVersion: 2,
  scope: 'workspace',
  compute: async () => {
    const { callPlansRead } = await import('../agent-tools/plans/read-dispatch');
    const r = (await callPlansRead('lint', { full: true })) as { reports?: unknown[] };
    return Array.isArray(r?.reports) ? r.reports : [];
  },
});

// ── learning.soakReport (P-005) — measured 27.3s on the read path ────────────
//
// The worst offender: a host-global `journalctl` scan that sat INSIDE a per-pot
// fan-out, so ~12 hives meant ~24 concurrent scans of a 1.2GB journal per
// Learnings-tab load, all returning byte-identical results.
//
// Precompute replaces the getOrSet cache landed earlier in WI-5460, which was
// always a stopgap: a cache still pays the full 27s on cold load, and on a host
// with no journald it fails rather than degrades (see the P-005 capability
// detection in pot/soak-report.ts).
//
// The rolling window is 12–24h, so the report barely moves minute to minute;
// 10 minutes is comfortably fresh for a readiness panel.
registerDerivedRead({
  key: 'learning.soakReport',
  ttlMs: 10 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async ({ workspaceId }) => {
    const { listPots } = await import('../agent-tools/pot/_resolve');
    const { readPotSoakReport } = await import('../pot/soak-report');
    const homes = await listPots(workspaceId).catch(() => []);
    const reports = (
      await Promise.all(
        homes.map(async (home: { slug: string }) => {
          try {
            return await readPotSoakReport(home.slug, {});
          } catch {
            return null;
          }
        }),
      )
    ).filter((report): report is NonNullable<typeof report> => report != null);
    return [{ hives: reports }];
  },
});

// ── The three dev.* diagnostics (WI-5476) ────────────────────────────────────
//
// `dev.serviceHealth` / `dev.deployState` / `dev.gitPipelineHives` each spawned a
// subprocess (systemctl / git) on the /admin/git panel's read (measured 1.34s /
// and the git ones per-hive). They are DEV-only — the rail that reads them is
// gated `import.meta.env.DEV` and absent from user builds — so the shipped-desktop
// hard-fail hazard is muted, but they still spawned on a sync read and the
// no-heavy-io-on-read-path guard rightly flagged them. Precompute takes the
// subprocess off the read entirely, so the resolver is a plain snapshot SELECT.
//
// These share the substrate's per-producer ttl, so the routine's short (2-min)
// cadence keeps them fresh without re-running the expensive storage/plans/soak
// producers, which stay gated behind their own long ttls.

// deployState + gitPipelineHives track the deploy pipeline, which moves on a
// ~15-min cadence, so a 5-minute snapshot is amply fresh.
registerDerivedRead({
  key: 'dev.deployState',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { devDeployState } = await import('../dev-deploy-state');
    return [await devDeployState()];
  },
});

registerDerivedRead({
  key: 'dev.gitPipelineHives',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async ({ workspaceId }) => {
    const { gitPipelineHiveRows } = await import('../git-pipeline-hives');
    return gitPipelineHiveRows(workspaceId);
  },
});

// dev.gitPipeline (whole-app-sync-payload-audit P-007) — measured 3.1s COLD /
// 13ms warm on the /admin Git panel's `dev.gitPipeline` sync read. The snapshot's
// PG sub-reads (routines/escalations/pipeline_events) are cheap; the cost is
// `gitPipelineSnapshot()` → `devDeployState()`, which fans out ~6 `git` fork/execs
// to resolve staging/main/deployed refs + gaps. That git spawn was pinned TWICE as
// the #1 application-attributable event-loop cost (P-015, P-009). devDeployState's
// own 10s single-flight cache did NOT cover this read path in practice: GitClient
// polls with staleTime 30s > the 10s TTL, so EVERY panel refetch was a cold fan-out.
//
// Precompute mirrors the two siblings above (dev.deployState, dev.gitPipelineHives,
// both precomputed in the same WI-5476 effort) — the resolver becomes a plain
// snapshot SELECT and no git spawns on the sync read path. This slims ONLY the
// UI-sync boundary: every DIRECT caller of gitPipelineSnapshot() (git-pipeline-
// position, why-chain, release-deploy-launch, the green-stall / release-deploy-
// staleness watchdogs, the release:trace tool) still computes a LIVE snapshot and
// is untouched — matching the P-005/P-006 "slim at the UI boundary, never the
// shared loader" pattern.
//
// 90s ttl (NOT the 5-min of the deploy-gap siblings): unlike a slow deploy gap,
// this snapshot carries liveness-sensitive gate-health verdicts (consecutiveReds,
// verdictStale, fireStale) that a human watches on the /admin Git panel during a
// pipeline incident. 90s < the routine's 2-min cron floor, so it recomputes on
// EVERY tick — the freshest the substrate offers, same rationale as serviceHealth.
// The panel surfaces computedAt via _meta.derivedRead ("as of HH:MM").
registerDerivedRead({
  key: 'dev.gitPipeline',
  ttlMs: 90_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
    // includeActiveRun (overview-tab-expansion P-001): the "judging vs idle" systemd
    // probe runs HERE, in the background precompute, so the Overview Deploy tile gets
    // it while live gitPipelineSnapshot() callers stay fork-free.
    return [await gitPipelineSnapshot(undefined, { includeActiveRun: true })];
  },
});

// serviceHealth is a LIVENESS probe — a stale snapshot is more misleading than
// for the pipeline ones — so it gets a short ttl (recomputed on essentially every
// 2-min routine tick). The panel surfaces the snapshot's computedAt via _meta, so
// a viewer sees "as of HH:MM:SS" rather than mistaking stale for live.
registerDerivedRead({
  key: 'dev.serviceHealth',
  ttlMs: 90_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { probeAll } = await import('../service-health');
    const services = await probeAll();
    return [{ services }];
  },
});

// ── rubrics.list (owner-reported 2026-07-19: the Learnings → Rubrics tab took
// ~0.7s to OPEN on a LOCAL desktop app — "loading a little data should be
// instant"). Root cause: an N+1 over-fetch on the user-facing read path. The
// resolver ran, PER rubric, a `listScorecards({ rubricRef, limit: 500 })` (≈13
// rubrics × up to 500 FULL scorecard rows) purely to project each rubric's
// latest + average score10 in JS. score10 is a read-time projection over the
// ratings jsonb, so the aggregation is genuinely expensive to do on read.
//
// This class was MISSED by the WI-5460 audit, which enumerated only the
// `learning.*` sync queries — the `rubrics.*` / `scorecards.*` namespace behind
// the imported RubricsPanel slipped through (the audit gap the owner flagged).
// It also evaded the no-heavy-io-on-read-path guard, which catches
// subprocess/recursive-fs, not a heavy N+1 PG over-fetch.
//
// The Rubrics tab is a read-mostly REVIEW surface (agents grade via
// scorecards:emit; this tab reviews health/scores/trends), so a short precompute
// lag on the aggregate OVERVIEW is invisible — the per-rubric DETAIL panel
// (scorecards.list / rubrics.trend) stays a live read. 2-min ttl recomputes on
// essentially every routine tick; the list surfaces computedAt via _meta.
registerDerivedRead({
  key: 'rubrics.list',
  ttlMs: 2 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { listRubrics } = await import('../rubrics');
    const { listScorecards, scorecardTotalCountsByRubric } = await import('../scorecards');
    const rubrics = await listRubrics({});
    // Per-rubric latest/avg window (WI-5415: a per-rubric window, not one shared
    // globally-capped read, so a high-volume rubric never crowds a low-volume one
    // out of the window) + a real UNBOUNDED total count.
    const [totalCounts, perRubricScorecards] = await Promise.all([
      scorecardTotalCountsByRubric(),
      Promise.all(rubrics.map((r) => listScorecards({ rubricRef: r.rubricId, limit: 500 }))),
    ]);
    return rubrics.map((r, i) => {
      const cards = perRubricScorecards[i] ?? [];
      let latestAt: string | null = null;
      let latestScore10: number | null = null;
      let scoreSum = 0;
      let scoreN = 0;
      for (const s of cards) {
        if (!latestAt || s.createdAt > latestAt) {
          latestAt = s.createdAt;
          latestScore10 = s.score10;
        }
        // avgScore10 = mean of the read-time 0–10 projections; null-scored
        // (all-unknown) scorecards excluded, matching the per-scorecard rule.
        if (s.score10 !== null) {
          scoreSum += s.score10;
          scoreN += 1;
        }
      }
      return {
        rubricId: r.rubricId,
        characteristic: r.characteristic,
        title: r.title,
        status: r.status,
        proposedBy: r.proposedBy,
        ratifiedBy: r.ratifiedBy,
        criteriaCount: r.criteria.length,
        ratingScale: r.ratingScale,
        methodRef: r.methodRef,
        updatedAt: r.updatedAt,
        // TRUE unbounded total (WI-5415) — never the capped per-rubric read length.
        scorecardCount: totalCounts[r.rubricId] ?? cards.length,
        latestScorecardAt: latestAt,
        latestScore10,
        avgScore10: scoreN > 0 ? Math.round((scoreSum / scoreN) * 10) / 10 : null,
      };
    });
  },
});

// ── insights.coordTokens (phase2 P-002) — measured 0.5-0.8s / 4.6KB on the
// Learnings → Tokens subtab's Coordination panel read (WI-5584). Three
// workspace-scoped rollups recomputed on EVERY read: the model_pricing rate book,
// the coord-cost breakdown ($ by turn-trigger and by role-class over a 7-day
// window of harness_shared.agent_usage_samples), and the coord-poll volume (a
// COUNT + COUNT(DISTINCT) over a 1-day window of harness_shared.tool_invocations
// — the ~75%-of-all-rows wake-poll aggregate). All three are GROUP BY / COUNT
// aggregations over the two highest-volume telemetry tables, so the cost scales
// with fleet activity and lands entirely on a user-facing sync read.
//
// Coord cost is fleet-wide, so the resolver's `harness` arg is OPTIONAL and the
// window defaults are fixed (7d cost / 1d poll). Derived-read snapshots key on
// (workspace_id, harness_slug, key) with NO arg dimension, so this producer
// precomputes ONLY the DEFAULT variant (whole-workspace, default windows) — the
// exact shape the Tokens panel requests on mount. A resolver call that passes an
// explicit `harness` or `windowMs` is a non-default view and falls through to
// inline compute (see the gate in sync-resolver/index.ts).
//
// 5-minute ttl: these rollups aggregate 1-7 DAY windows, so they barely move
// minute to minute — a 5-min snapshot is far fresher than the panel needs, and
// on the routine's 2-min cron it recomputes every ~2-3 ticks rather than every
// tick, keeping this off the hot compute path. The panel surfaces computedAt via
// _meta.derivedRead ("as of HH:MM"), and a manual invalidate still forces a live
// refetch of the non-default views.
registerDerivedRead({
  key: 'insights.coordTokens',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async ({ workspaceId }) => {
    const { loadModelPricingBook, loadCoordTokenBreakdown, loadCoordPollVolume } = await import(
      '../harness-insights/load-token-rollups'
    );
    return withWorkspace(workspaceId, async (tx) => {
      const runQuery = async <T>(query: string, params: unknown[]): Promise<T[]> =>
        (await tx.unsafe(query, params as never)) as unknown as T[];
      // Default variant only: no harness_slug, default windows (7d cost / 1d poll).
      const [pricingBook, coordBreakdown, pollVolume] = await Promise.all([
        loadModelPricingBook(runQuery),
        loadCoordTokenBreakdown({ workspace_id: workspaceId, runQuery }),
        loadCoordPollVolume({ workspace_id: workspaceId, runQuery }),
      ]);
      return [{ pricingBook, coordBreakdown, pollVolume }];
    });
  },
});

// ── learning.improvements (phase2 P-003) — measured 0.4-0.5s / 134KB on the
// Learning tab's self-improvement feed (WI-5460 follow-up). buildDigest +
// human-queue ranking + flow-metrics get rebuilt over the WHOLE improvement
// corpus (~380 items) on every user-facing read. Precompute moves that compute
// onto the routine; the resolver's default mount ({} args) becomes a plain
// snapshot SELECT.
//
// The compute is shared with the resolver's live inline path
// (computeLearningImprovementsSnapshot) so the precomputed default and the
// on-read non-default variants can never drift. The `recordQueueExposure`
// owner-preference side-effect is DELIBERATELY excluded from the shared compute
// (it must fire on the real read, not the routine thread) — the resolver fires
// it from whatever humanQueue the read returns.
//
// FRESHNESS (the plan's "verify Scout/owner freshness needs; short ttl"):
//   - Scout reads the improvements:digest TOOL, not this sync resolver, so it is
//     UNAFFECTED by precomputing the resolver.
//   - Owner: a 90s ttl (the liveness-sensitive tier, matching dev.serviceHealth /
//     dev.gitPipeline) recomputes on essentially every 2-min routine tick, so the
//     Learning queue is at most ~one tick stale — consistent with the already
//     shipped, owner-accepted rubrics.list / storage.usage precompute behavior
//     under the substrate's D-003 "a read never computes" invariant. The panel
//     surfaces computedAt via _meta.derivedRead ("as of HH:MM"). NON-default views
//     (state/limit/hive) stay fully live.
registerDerivedRead({
  key: 'learning.improvements',
  ttlMs: 90_000,
  // BUMPED for learning-tab-surface P-002/D-002: the default variant's POPULATION
  // changed (every captured improvement → only what the learning loop produced), so
  // a cached v1 row is not merely stale, it answers a different question. The bump
  // invalidates it instead of serving the old corpus under the new view's name.
  producerVersion: 2,
  scope: 'workspace',
  compute: async () => {
    const { computeLearningImprovementsSnapshot } = await import(
      '../harness/improvements/learning-digest-snapshot'
    );
    // The DEFAULT variant: no state filter, default limit, whole workspace (no hive
    // lens), and the DEFAULT provenance scope ('loop' — LearningImprovementsArgs.scope).
    // Keeping this call argument-free is what keeps the tab's own view on the fast
    // path: the resolver only serves its default variant from this snapshot.
    return computeLearningImprovementsSnapshot({});
  },
});

// ── coord.history (phase2 P-004) — measured 0.1-0.8s (variable) / 160KB on the
// legacy /coord history viewer (WI-5460 follow-up). loadCoordHistory reads the
// ENTIRE coord corpus (all plan-events + messages + escalations + handoffs) then
// filters/sorts/slices in JS — so the compute grows with total coord volume, and
// the variable latency the plan flagged is that full scan.
//
// Only the DEFAULT view (all sources, no planSlug/owner/sinceTs filter, the
// default limit of 200 — exactly what the /coord screen mounts with) is
// precomputed; snapshots have no arg dimension, so any filtered/custom-limit view
// falls through to the live inline scan. The heavy per-item `payload` is KEPT (the
// screen's on-demand expand renders it), served fast from the snapshot's jsonb.
//
// 90s ttl (live-feed tier): the routine recomputes on essentially every 2-min
// tick, so the viewer is ≤1 tick stale — fine for a review/debug surface with a
// manual Refresh (staleTime 30s), and consistent with the substrate's D-003 "a
// read never computes". NOTE (follow-up, not P-004 scope): loadCoordHistory's
// scan-everything-then-filter-in-JS is shared with the /api/coord/history HTTP
// route (pui TUI); pushing the filter/limit into the DB is a broader refactor.
registerDerivedRead({
  key: 'coord.history',
  ttlMs: 90_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { loadCoordHistory } = await import('../endpoint-route/routes/coord');
    // DEFAULT variant only: no filters, default limit (200) — the /coord mount.
    return (await loadCoordHistory({})).items;
  },
});

// ── learning.releaseReadiness (phase2 P-005) — measured 0.27s / 2.3KB on the
// Verify stage's GO/NO-GO strip. readReleaseReadiness reruns
// buildProgramSuccessReport + rubric governance reads (getRubric/listScorecards)
// on every mount; small payload, pure compute → a clean thin precompute. No args,
// so the resolver is an unconditional snapshot SELECT. 5-min ttl: release-
// readiness (six success bars + rubric governance state) moves slowly.
registerDerivedRead({
  key: 'learning.releaseReadiness',
  ttlMs: 5 * 60_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { readReleaseReadiness } = await import('../sync-resolver/learning-release-readiness-read');
    return [await readReleaseReadiness()];
  },
});

// ── learning.observations (phase2 P-005) — measured 0.22s / 152KB on the
// Observations browse pane. listIssues + countIssues + per-row map/sort over the
// whole OBSERVATION lane on every mount; the 152KB is the per-observation `body`.
// Only the DEFAULT view (no state filter, default limit 200 — the pane's mount)
// is precomputed via the shared computeLearningObservations; a state filter /
// custom limit falls through to the live inline compute (snapshots have no arg
// dimension). 90s ttl (browse feed, invalidated on a new observation file): the
// routine keeps it ≤1 tick fresh, consistent with the substrate's D-003.
registerDerivedRead({
  key: 'learning.observations',
  ttlMs: 90_000,
  producerVersion: 1,
  scope: 'workspace',
  compute: async () => {
    const { computeLearningObservations } = await import('../sync-resolver/learning-observations-read');
    // DEFAULT view: no state filter, default limit (200).
    return computeLearningObservations({});
  },
});
