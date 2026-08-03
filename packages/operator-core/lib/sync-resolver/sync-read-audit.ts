/**
 * sync-read-audit.ts — the repeatable sync-read audit harness + its recurrence
 * guard (precompute-sync-reads-phase2 P-008).
 *
 * THE METHODOLOGY GAP THIS CLOSES
 * -------------------------------
 * Two rounds of audit found fat/slow sync reads (rubrics.list-class compute;
 * workItems.byHarness 3.79MB, agentRunsConsolidated 1.44MB, featuresConsolidated
 * 907KB, learning.analyze 370KB payloads) only because someone measured by hand.
 * Nothing systematically enumerates EVERY registered queryName and measures its
 * payload + latency, so a newly-fattened read silently ships to the desktop until
 * a human notices the lag. This module is that systematic instrument.
 *
 * TWO HALVES, by design (the invoke-in-CI trap):
 *   1. A HERMETIC guard (sync-read-audit.test.ts) — enumerate the registry,
 *      auto-detect which queries REQUIRE args (argsSchema rejects `{}`), and FAIL
 *      when an arg-requiring query has no fixture or the allowlist rots. O(1) per
 *      entry, NO I/O. This deliberately does NOT invoke resolvers: an older
 *      "dispatch every entry against real PG" breadth test repeatedly blew the
 *      green gate under load (index.ts getRegistryEntryV2 note — timeout bumped
 *      10s→30s→120s then past it at ~123 entries). Structural inspection catches
 *      the coverage-rot class without that cost.
 *   2. A LIVE audit (`measureSyncReadPayloadsViaRest`) — run ON DEMAND against a
 *      RUNNING operator's rest-query endpoint (`GET /api/zero-harness/rest-query`),
 *      because a payload-SIZE budget is only meaningful against POPULATED data (an
 *      empty testcontainer measures ~0 bytes and catches nothing). Measuring the
 *      live operator also sidesteps the in-process resolver-invocation cost that
 *      wedged the gate. This returns the ranked report + budget VIOLATIONS so an
 *      agent/human can re-audit in one call after any sync-read change.
 *
 * Re-run the live audit: see measureSyncReadPayloadsViaRest below — point it at
 * :3170 (staging, carries your staging edits after dev:restart) or :3070 with the
 * superuser token, pass a harness/workspace, and read `.violations`.
 */

/** Desktop budgets (plan P-008). A user-facing sync read should compute fast and
 *  ship small; over either without an allowlist entry is a regression. */
export const PAYLOAD_BUDGET_BYTES = 250_000; // 250KB parsed into the webview
export const LATENCY_BUDGET_MS = 150; // compute time on the operator

/** Representative args for the queries whose argsSchema REQUIRES them (the
 *  "58 need args" set). Keyed by queryName. Values target the papercusp harness /
 *  papercusp-workspace tenant — the populated substrate the audit runs against.
 *  The hermetic test FAILS if a registered arg-requiring query is missing here,
 *  so this map cannot silently fall behind the registry. Extend it (don't work
 *  around it) when you add an arg-requiring sync query.
 *
 *  `null` = intentionally UNMEASURABLE in a generic audit (needs a per-run id
 *  that does not exist as a stable fixture — e.g. a specific run/session/cycle
 *  id). Listed so coverage is explicit; the live audit skips these. */
export type QueryFixture = Record<string, unknown> | null;

/** The args most harness/workspace-scoped reads need. The coverage guard tries
 *  THIS automatically for any arg-requiring query without an explicit fixture —
 *  so the ~common `*.byHarness` / `*.byWorkspace` / `*.byHive` reads are covered
 *  with zero hand-authoring, and only queries needing a per-run id (detail /
 *  byFeature / byConversation / …) require an explicit entry (usually `null`). */
export const DEFAULT_HARNESS_ARGS: Record<string, unknown> = {
  harnessSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
};

/** EXPLICIT fixtures — only where DEFAULT_HARNESS_ARGS does NOT satisfy the
 *  argsSchema. `null` = intentionally UNMEASURABLE in a generic audit (needs a
 *  per-run id with no stable fixture — a specific run/feature/cycle/conversation
 *  id); listed so coverage is explicit and the live audit skips it. A non-null
 *  entry supplies the specific args the query requires. Extend this (don't work
 *  around the guard) when you add an arg-requiring sync query the default misses. */
export const SYNC_QUERY_FIXTURES: Record<string, QueryFixture> = {
  // ── measurable with specific (non-default) args ──
  'workItems.byHarness': { harnessSlug: 'papercusp', limit: 500 },
  // plans.items takes NO required args, so it would default to `{}` — but `{}` is
  // a shape NO consumer ever requests, and measuring it overstates this read by
  // ~8x. All four live call sites filter SERVER-side: `{needsHuman:true}` (13,150 B),
  // `{actionable:true}` (188,095 B), `{status:'blocked'}` (66,124 B) and `{slug}`
  // (~1,644 B). `actionable` is the largest, so it is the honest worst case to
  // hold to the budget. Measured 2026-08-02 post-WI-7086.
  //
  // ⚠ This does NOT mean the unfiltered read is cheap — `{}` really does serve
  // 1,460,403 B and stays reachable over REST. It is excluded because the audit
  // asks "what do clients receive", and nothing asks for that shape. If a
  // consumer ever DOES call plans.items unfiltered, change this fixture back to
  // `{}` rather than allowlisting the result.
  'plans.items': { actionable: true },
  'agentRunsConsolidated.bySlug': { harnessSlug: 'papercusp' },
  'agentRunsConsolidated.recent': { harnessSlug: 'papercusp' },
  'featuresConsolidated.byPlanSlug': { planSlug: 'precompute-sync-reads-phase2-compute-latency-2026-07-19' },
  // pot/hive-scoped (potHomeSlug / potSlug, not harnessSlug)
  'featuresConsolidated.byHive': { potHomeSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
  'plans.byHive': { potHomeSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
  'hive.overrides': { potSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
  'hiveRoster.byHive': { potSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
  'insights.tokens': { harness: 'papercusp' }, // `harness`, not `harnessSlug`
  'planSessions.list': { planSlug: 'precompute-sync-reads-phase2-compute-latency-2026-07-19' },
  'plans.runHistory': { planSlug: 'precompute-sync-reads-phase2-compute-latency-2026-07-19' },
  'plans.scheduledOccurrences': { rangeStartMs: 0, rangeEndMs: 9_999_999_999_999 },
  'p2p.grants': { potSlug: 'papercusp' },

  // ── needs a per-run id → skipped by the live audit (null) ──
  'workItems.detail': null, // a specific work-item id
  'featuresConsolidated.detail': null, // a specific featureId
  'featureTimeline.byFeature': null, // a specific featureId
  'learning.analyzeCycle': null, // a specific cycleId (from learning.analyze)
  'agentChats.detail': null,
  'agentDetail.byOwner': null,
  'agentOrders.byOwner': null, // a specific ownerId, like its agentDetail sibling
  'chunkPlans.byFeature': null,
  'conversations.agentChatDetail': null,
  'conversations.agentMessageDetail': null, // a specific coord_event_log msg_id
  'conversations.deliberationDetail': null,
  'conversations.questionDetail': null,
  'designFeatures.detail': null, // a specific featureId (WI-7232 list/detail split)
  'designSketches.byFeature': null,
  'dockLayouts.byName': null,
  'evals.benchRun': null,
  'evals.benchRunLive': null,
  'evals.coordTrace': null,
  'evals.report': null,
  'featureAudit.byHarness': null, // needs a featureId despite the name
  'featureDebugNotes.byHarness': null,
  'featureNotes.byHarness': null,
  'hiveFromRepo.progress': null,
  'operatorTurns.page': null,
  'planItems.byPlan': null,
  'plans.attentionItem': null, // a specific attention item id (slim-plans-attention-sync-payload-2026-07-26 P-004) — no stable fixture
  'plansDrafts.bySlug': null,
  'projectSpecRevisions.byProject': null,
  'snapshotsConsolidated.bySlug': null,
  'userActions.byKind': null,
  // needs a specific id / key / coordinate with no stable representative value
  'hive.beaconConsent': null, // a specific potId
  'network.hive.beacons': null, // a federation hiveKey (device pubkey)
  'network.hive.wakes': null, // a federation hive key
  'rubrics.trend': null, // a specific rubricRef
  'scorecards.list': null, // a specific rubricRef
  'sidebar.cupMail': null, // a specific owner id
  'userMemory.feedbackStats': null, // a specific userId
  'userMemory.list': null, // a specific userId
  'weather.current': null, // lat/lon — an external fetch, not a DB sync-read payload
};

/** An accepted over-budget read: WHY it is allowed + WHEN to re-review. A bounded
 *  list whose per-row waste is already removed (its size is row COUNT × minimal
 *  fields) can legitimately exceed the byte budget — but it must be JUSTIFIED
 *  here, not silently ignored. The hermetic test asserts each entry names a real
 *  query + carries a reason; the live audit only flags NON-allowlisted breaches. */
export interface SyncReadAllowlistEntry {
  maxBytes?: number;
  maxMs?: number;
  reason: string;
  /** ISO date to re-examine whether this can now meet budget. */
  reviewBy: string;
}

export const SYNC_READ_ALLOWLIST: Record<string, SyncReadAllowlistEntry> = {
  codeRecipes: {
    maxBytes: 450_000,
    reason:
      "The /admin/recipes corpus (LIMIT 1000 of 8,923 recipes). WI-7085 found this was the FATTEST sync read in the tree at 2,936,018 B — ~11.7x budget, unallowlisted, and never measured by anything until the full 175-query audit ran. NOT the WI-7083 fabricated-row class (distinct id 1000/1000, ratio 1.0000): it was the unread-field class (D-023) in its purest form, with `script` — the recipe BODY — alone accounting for 2,309,736 B / 79.21% of the payload. No list caller had ever read it (recipes:list, the learning-retain read and this resolver each projected it straight back off), so listRecipes now returns CodeRecipeListRow and never SELECTs it — saving the Postgres->node leg too, not just the wire. A UI-read allow-list (code-recipes-ui-projection.ts) then dropped 7 more unread columns and, per D-025, the null-valued keys (promotedTool null on 1000/1000). Measured live 2,906,331 -> 393,406 B (-2,512,925 B, -86.46%) on a SIMULTANEOUS two-operator paired fetch: 0 rows lost, 0 rows added, 0 read-set value diffs, 0 residual nulls. Over the 250KB budget and honestly so: the residual is 382 B/row x 1000 rows of exclusively rendered fields (description 29%, title 17%, id 16%, lastRunAt 11%). The next real cut is windowing the list itself, not fewer bytes per row.",
    reviewBy: '2026-09-01',
  },
  'agentRunsConsolidated.bySlug': {
    maxBytes: 600_000,
    reason:
      'Bounded run-history list (RUNS_LIST_CAP=2000). P-007 dropped the 10 never-rendered fields; P-028/D-022 then found errorMessage was still 51% of the ~1041KB payload and that 464,840 B of it rode on the 1,874 rows whose featureId is NULL — provably unreachable, since it renders only inside DetailPanel featureRuns (filtered by featureId). Now nulled on those rows (rows that CAN render keep the full 1000-char cap), and harnessSlug dropped as redundant with the query arg. Budget ratcheted 1,100,000 -> 600,000. Any further cut needs a per-feature on-demand run split.',
    reviewBy: '2026-09-01',
  },
  'featuresConsolidated.bySlug': {
    maxBytes: 520_000,
    reason:
      "Bounded feature list. P-007 dropped the heavy per-row summary at the sync boundary (detail on demand). WI-7203 then removed the last per-row waste: `harnessSlug` (1,606 copies of the very slug the caller passes in args — redundant, the same cut agentRunsConsolidated.recent made) and `updatedTs` (ORDER BY only, server-side), NEITHER of which the sole consumer's SyncFeatureRow even declares, plus the D-025 null-omit (claims null on 1,560 of 1,606 rows, tags on 1,603, sourcePlanSlug on 437). Measured 637,015 -> 502,813 B (-21.1%), lossless. ⚠ THE CEILING WENT UP 500,000 -> 520,000 AND THE JUSTIFICATION MUST BE READ, because raising a ceiling to silence a red is normally the anti-pattern: this is a re-ratchet AFTER the fix, not instead of it, and PER-ROW cost FELL 394 -> 313 B/row (-20%). The 500,000 was set against ~1,181 rows; there are now 1,606 (+36%), so the breach was pure ROW GROWTH against a fixed byte ceiling — something no per-row projection can ever answer. All 9 surviving columns are genuinely read, and `title` (42.76%) is already capped at ~200 chars upstream (p50=p90=p99=200), so no honest per-row cut remains. THE NEXT BREACH IS A WINDOWING TRIGGER, NOT ANOTHER RAISE (WI-7209).",
    reviewBy: '2026-09-01',
  },
  'featuresConsolidated.byHive': {
    maxBytes: 450_000,
    reason:
      "Cross-member feature rollup behind HiveContentPanel (1,605 rows on papercusp). WI-5412 slimmed the sibling .bySlug and MISSED this one, and the resolver comment wrongly claimed the two projections mirrored each other exactly — so byHive kept the heavy per-row `summary` that .bySlug had already moved behind featuresConsolidated.detail under the P-006 list/detail split. Measured live: `summary` alone was 831,678 B = 56.58% of a 1,469,953 B payload and NO consumer had ever read it. WI-7087 cut the projection to the FIVE columns HiveContentPanel's own HiveFeatureRow declares, dropping summary + attempts/claims/tags/needsHumanReview/sourcePlanSlug/workingUsers: 1,469,953 -> 424,897 B (-1,045,056 B, -71.1%), LOSSLESS (1,605 rows both sides, 0 read-set value diffs, 0 non-null values lost, latest-first ordering preserved). Over the 250KB budget and honestly so: the residual is row COUNT x four light rendered fields, of which `title` alone is 272,224 B, and the rollup is unscoped by design (the panel browses every member's features). Budget ratcheted to 450,000 so the win cannot silently drift back. The next real cut is windowing the list, not fewer bytes per row. No rows-delta config: feature ids are PER-HARNESS, so `featureId` is unique here only because this hive currently has one contributing member — a genuine multi-member hive can repeat it, and the composite (harnessSlug, featureId) is not expressible as a single itemKeyField.",
    reviewBy: '2026-09-01',
  },
  'plans.attention': {
    maxBytes: 950_000,
    reason:
      'The whole owner-attention feed (173 groups / ~1114 items). P-003 already split it list/detail (actions dropped, body clipped 609KB -> ~256KB); P-028/D-025 then removed the null-valued keys, measured 1,062,144 -> ~907,000 B (-14.6%) live. Still far over the 250KB budget and honestly so: the residual is item COUNT x rendered fields, and the feed is unscoped by design (the sidebar badge counts decisions workspace-wide). The next real cut is fewer items on the wire, not fewer bytes per item — the aggregate half already left via plans.attentionCounts, so what remains is paginating/windowing the list itself.',
    reviewBy: '2026-09-01',
  },
  'plans.list': {
    maxBytes: 720_000,
    reason:
      'The unscoped plan list (934 rows) behind the plans rail, the Create-tab picker, the Mug/Swarm steering trees and the ADV overview tiles. nextAction is already clipped to a 280-char tooltip preview (P-005); WI-7045/D-025 then removed the null-valued keys, measured 827,320 -> 701,767 B (-125,553 B, -15.2%) live against :3070, all 7,155 nulls gone with 0 non-null values lost. Over the 250KB budget and honestly so: the residual is row COUNT x light rendered fields, and the feed is unscoped by design (the rail offers every plan in the workspace). The next real cuts are, in order: the nested identity avatarUrl (null on all 1,436 occurrences, ~26 KB, needs its own audit of the shared AuthorIdentity type), then windowing the list itself.',
    reviewBy: '2026-09-01',
  },
  'plans.byHive': {
    maxBytes: 720_000,
    reason:
      "The hive rollup of plans.list — same rows, same read, so the same ceiling as plans.list. WI-7083 found it was serving the hive's plan set once PER MEMBER: the harness_slugs fan-out deduped on the REQUESTED slug, but plans are HIVE-scoped so every member collapses onto the same home, and the downstream `${harnessSlug}:${slug}` row-dedupe key cannot see across batches. Measured 1,249,750 -> 682,955 B (-566,795 B, -45.4%) live, 1,820 -> 910 rows, lossless (0 rows and 0 keys lost; the surviving value diffs were live edits to two plans, reproduced as drift). That duplication was also what BLOCKED the rows-delta config here, since `slug` had only 910 distinct values across 1,820 rows; with it fixed the resource keys on `slug` and a warm poll costs 225 B instead of 683 KB. Still over the 250KB budget and honestly so: the residual is row COUNT x light rendered fields, inherited wholesale from plans.list, and shrinks when plans.list does — next up there is the nested identity avatarUrl (null on all 1,404 occurrences here).",
    reviewBy: '2026-09-01',
  },
  'workItems.byHarness': {
    maxBytes: 300_000,
    reason:
      'Bounded work-items grid (limit 500). P-006 dropped the heavy per-row summary (detail on demand); P-028/D-022 then replaced that deny-list with an ALLOW-LIST of the 18 fields the panels actually render, measured 429KB -> 258KB (-40%) on the live papercusp harness. The residual IS the grid page x those light fields — row count, not per-row waste. Budget ratcheted 450K -> 300K so the win cannot silently drift back.',
    reviewBy: '2026-09-01',
  },
  'coord.plans': {
    maxBytes: 390_000,
    reason:
      "The whole-workspace plan list behind CoordDashboard's PlansPanel (973 rows, no args — unscoped by design: the panel offers every plan in the workspace). FIRST-TIME allowlist entry, not a raise: this read had none, and the 250,000 default is what it was breaching. ⚠ READ THE DIRECTION OF TRAVEL: WI-7246 made this payload very slightly BIGGER (394,269 -> 395,430 B, +1,161 B) and that was CORRECT. The read was reporting each plan's SELF-DECLARED markdown frontmatter slug/status instead of the canonical row, and a `<slug>@run-<epochms>` snapshot copies its parent's body verbatim — frontmatter included — so 51 distinct plans collapsed into ONE identity (973 rows but only 923 distinct slugs; `critical-severity-alert-2026-07-06` appeared 51x BYTE-IDENTICAL). That was a correctness bug wearing a byte bug's clothes: 51 duplicate React keys, all 51 rows fetching the PARENT's markdown on click, one click expanding all 51, and `superseded` snapshots rendering as `draft`. Identity + lifecycle now come from `p.row` (planSlug/status/updated), which costs 1,161 B more because a canonical slug is longer than the parent's — the right trade. Verified live: 973 rows, 973 distinct slugs, 973 distinct whole rows. NO PER-ROW WASTE REMAINS: all SEVEN surviving columns are rendered by the sole consumer, `now_state` is already stripped at the sync boundary (projectCoordPlansForUi) and `now_next` is already clipped to 280 (COORD_TEXT_PREVIEW_MAX). Clipping `now_next` harder is MEASURED AND REJECTED — at 140 it saves 58,268 B (~342 KB, still over), and even at 80 it saves only 97,070 B (~303 KB, STILL over) while truncating 724 of 953 rendered previews. So no per-row projection can answer this breach. THE BREACH IS PURE ROW GROWTH. WI-7256 then removed HALF of it — the SNAPSHOT half — and the ceiling is RATCHETED 450,000 -> 390,000 so that win cannot silently drift back. A scheduled plan mints a `<template>@run-<token>` instance row per fire and nothing prunes them; projectCoordPlansForUi now drops the FINISHED ones. Measured live on :3170, paired against a pre-restart capture: 395,690 -> 380,590 B (-15,100 B, -3.82%), 973 -> 923 rows, LOSSLESS on the surviving set (923 matched by slug, 0 value diffs, 0 non-null keys lost, 0 keys added, all 50 removed rows verified terminal instances, control falsified as old-shape by containing all 50). ⚠ ONLY THE TERMINAL ONES, AND THAT DISTINCTION IS LOAD-BEARING: an instance is minted `active` (plan-run-action.ts:254) and becomes `superseded` when the run ends, so dropping every `@run-` row would have silently hidden an IN-FLIGHT scheduled run from the panel. What survives is bounded by CONCURRENT runs instead of by all runs ever. Nothing became unreachable — the parent template keeps its own row and the unprojected /api/coord/plans HTTP route still serves full run history. ⚠⚠ THE OTHER HALF OF THE ROW GROWTH IS UNTOUCHED AND IS THE LARGER TERM: authored plans accrue at ~45-50/week (measured, papercusp, weeks of 2026-07-20 and 2026-07-27) = ~19 KB/week at ~412 B/row, so this read is expected back at the 390,000 ceiling within ~3-4 days of 2026-08-03. THAT RED IS THE WINDOWING TRIGGER — WI-7256's second half, still open — NOT ANOTHER RAISE. Unlike conversations.agentMessageList, PlansPanel has no filter predicate at all, so windowing here is safe rather than a silent search regression.",
    reviewBy: '2026-09-01',
  },
  'conversations.agentMessageList': {
    maxBytes: 300_000,
    reason:
      "The unified Convos inbox's agent<->agent source — a FIXED 100-row window over the append-only coord_event_log (both consumers pass limit 100 explicitly; resolver default clampedLimit(500,100)), so this read does NOT grow with the corpus. WI-7240 found it was 445,731 B / 100 rows = ~4.3 KB/row because `toAgentMessageRow` is SHARED by this list and conversations.agentMessageDetail: P-033 added the `authored` block to that mapper for the DETAIL views on 2026-08-02 and the LIST silently inherited 188,386 B (43.90%) that NOTHING reads — both <AuthoredFields> render sites (AdvConversationsTab.tsx:2406, ConversationsTab.tsx:687) take their row from the detail query. Mapper parameterised (not forked) so the two shapes cannot drift; measured 445,731 -> 251,350 B (-43.6%), per-row 4,484 -> ~2,514 B, LOSSLESS on the read-set (0 value diffs and 0 non-null lost across the 89 rows shared between captures; the other 11 are append-only window drift — every added row is strictly newer than every dropped one, and the shared rows keep their order). ⚠ CEILING RAISED 250,000 (default) -> 300,000 AND THE JUSTIFICATION MUST BE READ, because raising a ceiling to silence a red is normally the anti-pattern: this is a raise AFTER a real 43.6% cut, per-row cost FELL 44%, and the residual is ~0.5% over the default. THE REMAINING 79% IS `body`, WHICH CANNOT BE CLIPPED: composeUnifiedConversationRows maps it to UnifiedConversationRow.preview and AdvConversationsTab.tsx:318 feeds that into the CLIENT-SIDE SEARCH HAYSTACK, so a server-side clip silently stops matching any phrase past the cut — fewer search hits, no error. (Clipping at 200 would have saved a further 177,897 B; it is otherwise safe — summary non-empty on 100/100 so the body.slice(0,140) title fallback never fires, and summary===body on 0/100 — the haystack is the sole blocker and it is decisive.) THE NEXT BREACH IS A SERVER-SIDE-SEARCH TRIGGER, NOT ANOTHER RAISE (WI-7243): give the resolver a `q` arg that filters in Postgres and `body` stops shipping to be grepped client-side.",
    reviewBy: '2026-09-01',
  },
};

/** One measured query. */
export interface SyncReadMeasurement {
  name: string;
  bytes: number;
  ms: number;
  rows: number | null;
  overBudget: boolean;
  allowlisted: boolean;
  /**
   * The ceilings this row was ACTUALLY judged against — raised when allowlisted,
   * the defaults otherwise. Carried so a reader never has to re-derive them from
   * SYNC_READ_ALLOWLIST (re-deriving is how "over budget" and "over ITS budget"
   * got conflated in the first place — WI-7084).
   */
  byteCeil: number;
  msCeil: number;
  /** WHICH axis busted. `overBudget` is just `overBytes || overMs`. */
  overBytes: boolean;
  overMs: boolean;
  error?: string;
}

export interface SyncReadAuditReport {
  measured: SyncReadMeasurement[]; // sorted by bytes desc
  /**
   * Over the DEFAULT budget with NO allowlist entry — an unrecorded regression.
   * This is the "new fat read" bucket.
   */
  violations: SyncReadMeasurement[];
  /**
   * ALLOWLISTED yet over its OWN ratcheted ceiling — the ratchet has ROTTED
   * (WI-7084). Previously invisible: the report filtered `overBudget &&
   * !allowlisted`, so an allowlisted read busting the very ceiling its entry
   * exists to hold was silently dropped from BOTH buckets. It sat in `measured`
   * with `overBudget: true` and nothing surfaced it.
   *
   * Measured live 2026-08-02: `featuresConsolidated.bySlug` was 633,664 B against
   * its ratcheted 500,000 ceiling and appeared in NO bucket. That is the exact
   * failure a ratchet is supposed to prevent, so it must be LOUDER than a plain
   * violation, not quieter: someone already looked at this read, wrote down a
   * number, and it has since drifted past it.
   */
  ratchetRegressions: SyncReadMeasurement[];
  skipped: string[]; // fixture === null (unmeasurable generically)
  budgetBytes: number;
  budgetMs: number;
  /**
   * Host conditions the `ms` column was measured under — WITHOUT these the
   * latency axis is uninterpretable, and silently so.
   *
   * Measured 2026-08-02 on a box at load 129 (16 cores): `plans.attentionCounts`
   * returned **103 bytes in 442ms** and `dev.toolFormatAdoption` 121 B in 268ms,
   * reproducibly. A 103-byte response cannot be slow for payload reasons — that
   * is queue time, not a regression. On the same run THREE of the four
   * `ratchetRegressions` were flagged on latency alone, which would have sent a
   * reader chasing ghosts.
   *
   * `bytes` is load-INDEPENDENT and stays trustworthy under any load; `ms` is not.
   * Rule of thumb: treat the ms axis as advisory whenever `loadPerCore` is above
   * ~1, and re-measure a latency finding on a quiet box before acting on it.
   */
  host: {
    loadAvg1Start: number;
    loadAvg1End: number;
    cores: number;
    /** loadAvg1End / cores — above ~1 means the box is oversubscribed. */
    loadPerCore: number;
  };
}

/** True when the query's argsSchema REQUIRES a non-empty args object (i.e. it
 *  cannot be resolved with `{}`). Pure schema validation — no I/O. `entry` is a
 *  registry entry ({ argsSchema?: { safeParse } }). No argsSchema ⇒ no args. */
export function queryRequiresArgs(entry: { argsSchema?: { safeParse?: (v: unknown) => { success: boolean } } } | undefined): boolean {
  const schema = entry?.argsSchema;
  if (!schema || typeof schema.safeParse !== 'function') return false;
  return schema.safeParse({}).success === false;
}

type SchemaLike = { argsSchema?: { safeParse?: (v: unknown) => { success: boolean } } };

/** Resolve the fixture to measure a query with — the recurrence-guard core.
 *  Precedence: an EXPLICIT SYNC_QUERY_FIXTURES entry (incl. `null` = skip) wins;
 *  else if the query needs args and DEFAULT_HARNESS_ARGS satisfies its argsSchema,
 *  use the default; else if the query needs NO args, use `{}`; else it needs an
 *  explicit entry the map doesn't yet have (`needsExplicit`). Pure — no I/O. */
export function resolveFixture(
  name: string,
  entry: SchemaLike | undefined,
): { fixture: QueryFixture } | { needsExplicit: true } {
  if (Object.prototype.hasOwnProperty.call(SYNC_QUERY_FIXTURES, name)) {
    return { fixture: SYNC_QUERY_FIXTURES[name] };
  }
  if (!queryRequiresArgs(entry)) return { fixture: {} };
  if (entry?.argsSchema?.safeParse?.(DEFAULT_HARNESS_ARGS).success) return { fixture: DEFAULT_HARNESS_ARGS };
  return { needsExplicit: true };
}

/** Build the full name→fixture map for a live audit, resolving each name through
 *  resolveFixture. Names that still need an explicit entry are OMITTED (the
 *  hermetic coverage test fails on those, so a live run never hits an unresolved
 *  one). `getEntry` is the registry accessor (getRegistryEntryV2). */
export function buildLiveFixtureMap(
  names: string[],
  getEntry: (name: string) => SchemaLike | undefined,
): Record<string, QueryFixture> {
  const map: Record<string, QueryFixture> = {};
  for (const name of names) {
    const r = resolveFixture(name, getEntry(name));
    if ('fixture' in r) map[name] = r.fixture;
  }
  return map;
}

/**
 * The ceilings a query is judged against: its allowlist entry's raised values
 * where present, the defaults otherwise.
 *
 * ⚠ THE LATENCY AXIS IS DELIBERATELY *NOT* RAISED BY A BYTES-ONLY ENTRY. Every
 * current allowlist entry sets `maxBytes` alone, so each is still held to the
 * DEFAULT 150ms — being allowed to be BIG is not being allowed to be SLOW, and
 * an entry that genuinely needs latency headroom has to say so with `maxMs`.
 * Kept as-is on purpose (WI-7084): the bug was that a bust went UNREPORTED, not
 * that the ceiling was wrong, and silently widening latency while fixing the
 * reporting would have hidden the very regressions this change exists to show.
 */
export function budgetCeilings(name: string): { byteCeil: number; msCeil: number } {
  const allow = SYNC_READ_ALLOWLIST[name];
  return {
    byteCeil: allow?.maxBytes ?? PAYLOAD_BUDGET_BYTES,
    msCeil: allow?.maxMs ?? LATENCY_BUDGET_MS,
  };
}

/**
 * Evaluate one measured (bytes, ms) against the budget + allowlist.
 *
 * Reports the axes SEPARATELY. `overBudget` alone cannot distinguish "too big"
 * from "too slow", and on an allowlisted read it also cannot distinguish "over
 * the default" from "over the raised ceiling its entry set" — the conflation
 * behind WI-7084.
 */
export function evaluateBudget(
  name: string,
  bytes: number,
  ms: number,
): { overBudget: boolean; allowlisted: boolean; byteCeil: number; msCeil: number; overBytes: boolean; overMs: boolean } {
  const { byteCeil, msCeil } = budgetCeilings(name);
  const overBytes = bytes > byteCeil;
  const overMs = ms > msCeil;
  return {
    overBudget: overBytes || overMs,
    allowlisted: Boolean(SYNC_READ_ALLOWLIST[name]),
    byteCeil,
    msCeil,
    overBytes,
    overMs,
  };
}

/**
 * LIVE audit — measure every registered queryName that has a (non-null) fixture
 * against a RUNNING operator's rest-query endpoint. This is the re-runnable
 * "audit harness": call it after any sync-read change to get the ranked payload
 * report + budget violations. Not part of the CI green gate (needs a live,
 * populated operator); run on demand.
 *
 *   const names = knownQueryNamesV2();
 *   const fixtures = buildLiveFixtureMap(names, getRegistryEntryV2);
 *   const report = await measureSyncReadPayloadsViaRest({
 *     baseUrl: 'http://127.0.0.1:3170',           // :3170 staging (your edits) / :3070
 *     token: fs.readFileSync(os.homedir()+'/.papercusp/superuser-token','utf8').trim(),
 *     fixtures,
 *   });
 *   report.violations         // → fat reads with NO allowlist entry
 *   report.ratchetRegressions // → allowlisted reads that BUST their own ceiling
 *
 * READ BOTH. `violations` alone answers "what is newly fat"; it says nothing
 * about a read whose recorded ceiling has rotted, which is the more serious case
 * because someone already measured it and wrote the number down (WI-7084).
 *
 * `fixtures` is name→(args | null); a `null` fixture is SKIPPED (unmeasurable
 * generically). `fetchImpl` is injectable for tests; defaults to global fetch. */
export async function measureSyncReadPayloadsViaRest(opts: {
  baseUrl: string;
  token: string;
  fixtures: Record<string, QueryFixture>;
  fetchImpl?: typeof fetch;
}): Promise<SyncReadAuditReport> {
  const doFetch = opts.fetchImpl ?? fetch;
  const measured: SyncReadMeasurement[] = [];
  const skipped: string[] = [];
  const os = await import('node:os');
  const cores = os.cpus().length || 1;
  const loadAvg1Start = os.loadavg()[0];

  for (const [name, fixture] of Object.entries(opts.fixtures)) {
    if (fixture === null) {
      skipped.push(name);
      continue;
    }
    const url = `${opts.baseUrl}/api/zero-harness/rest-query?name=${encodeURIComponent(name)}&args=${encodeURIComponent(JSON.stringify(fixture))}`;
    const started = Date.now();
    try {
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${opts.token}` } });
      const text = await res.text();
      const ms = Date.now() - started;
      if (!res.ok) {
        // An errored fetch is never judged over-budget (its bytes are an error
        // body), but it still carries the ceilings so a reader can see what it
        // WOULD have been held to.
        measured.push({
          name,
          bytes: text.length,
          ms,
          rows: null,
          overBudget: false,
          overBytes: false,
          overMs: false,
          ...budgetCeilings(name),
          allowlisted: Boolean(SYNC_READ_ALLOWLIST[name]),
          error: `HTTP ${res.status}`,
        });
        continue;
      }
      let rows: number | null = null;
      try {
        const parsed = JSON.parse(text) as unknown;
        const arr = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown[] })?.rows;
        rows = Array.isArray(arr) ? arr.length : null;
      } catch {
        /* non-JSON body — keep rows null, still measure bytes */
      }
      measured.push({ name, bytes: text.length, ms, rows, ...evaluateBudget(name, text.length, ms) });
    } catch (err) {
      measured.push({
        name,
        bytes: 0,
        ms: Date.now() - started,
        rows: null,
        overBudget: false,
        overBytes: false,
        overMs: false,
        ...budgetCeilings(name),
        allowlisted: Boolean(SYNC_READ_ALLOWLIST[name]),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  measured.sort((a, b) => b.bytes - a.bytes);
  // The two buckets are DISJOINT and both are derived from the same `overBudget`
  // — the point of WI-7084 is that every over-budget row now lands in exactly one
  // of them instead of an allowlisted one landing in neither.
  const violations = measured.filter((m) => m.overBudget && !m.allowlisted);
  const ratchetRegressions = measured.filter((m) => m.overBudget && m.allowlisted);
  const loadAvg1End = os.loadavg()[0];
  return {
    measured,
    violations,
    ratchetRegressions,
    skipped,
    budgetBytes: PAYLOAD_BUDGET_BYTES,
    budgetMs: LATENCY_BUDGET_MS,
    host: { loadAvg1Start, loadAvg1End, cores, loadPerCore: loadAvg1End / cores },
  };
}
