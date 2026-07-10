/**
 * Reverse map: PG table → camelCase queryNames that read from it.
 *
 * Used by the sync-sse.ts LISTEN handler to bridge PG-trigger-driven
 * `emit_change_notify` events to the established camelCase consumer
 * subscriptions (P-067 from papercusp-dogfood-v5).
 *
 * Without this bridge, a PG INSERT on `harness_shared.harness_text_artifacts`
 * fires a `harness_shared.harness_text_artifacts.changed` event, but
 * existing `useSyncQuery({ queryName: 'harnessTextArtifact.byHarness' })`
 * subscribers see no matching name and don't refetch. With this bridge,
 * the LISTEN handler synthesizes additional events with the camelCase
 * names the consumers subscribe to. The dedupe window in sync-sse.ts
 * collapses repeated identical (name, args) within 90s, so this stays
 * cheap even under heavy write load.
 *
 * Maintenance: each entry corresponds to a v2 registry entry in
 * `apps/operator/lib/sync-resolver/index.ts`. When you add a new
 * registry entry that reads from table T, add (T → name) here too.
 * The `T` is the FULL `<schema>.<table>` string that the PG trigger
 * emits.
 *
 * Scoped (per-row) invalidation — caching-layer-tag-eca-2026-06-22 P-006:
 * migration 368 made `emit_change_notify` emit the changed row's PK in
 * `args.id` (+ a corrected `args.workspace_id`). Where a mapped query is
 * keyed PER-ROW, the bridge now uses `args.id` to invalidate ONLY that
 * row's cache key instead of full-busting the whole query.
 *
 *   - A bare-STRING entry (the default, and every entry today) → FULL-BUST:
 *     the bridge emits the name with NO `args`, so the SSEAdapter's
 *     name-only predicate invalidates every cache entry under that name.
 *     This is correct and unchanged for queries keyed by harness_slug /
 *     workspace_id / plan_slug etc. — a `byHarness` list isn't keyed by the
 *     changed row's surrogate PK, so per-row scoping can't narrow it.
 *
 *   - A `{ name, scope }` entry → SCOPED when the event carries an identifying
 *     key (`args.id`, or a natural-key fallback like `args.plan_slug` for
 *     id-less tables — EI-7433) AND `scope(key, workspaceId)` returns a key
 *     object. The bridge emits the name WITH those `args`; the SSEAdapter
 *     invalidates via `queryClient.invalidateQueries({ queryKey })`, which is
 *     a NON-exact, PARTIAL match (`@tanstack/react-query`'s
 *     `partialMatchKey` — verified live against v5.100.5): every key `scope`
 *     returns must match the consumer's cached args, but the consumer's args
 *     MAY carry additional keys `scope` omits (e.g. `mode`, `harness`) — they
 *     are not required to match. So `scope` only needs to return the subset
 *     of args that uniquely identifies the row (e.g. `{ slug }`), NOT the
 *     consumer's complete args object — a MISSING key in `scope`'s return is
 *     fine, a WRONG value for a key it does include is what breaks the
 *     match. Returns `null` to opt out of scoping for this event → the
 *     bridge falls back to a full-bust for that name. When the event has NO
 *     identifying key at all (neither `id` nor a nominated natural key),
 *     every entry full-busts regardless.
 *
 * The fan-out (and the 90s (name,args) dedupe in the bus) stays cheap: a
 * scoped event dedupes per row, a full-bust dedupes per name.
 */

/** Build the scope (consumer-key) args for a per-row query from the event's
 *  row PK + workspace. Return `null` to fall back to a full-bust. */
export type ScopeKeyBuilder = (
  rowId: string,
  workspaceId: string | undefined,
) => Record<string, unknown> | null;

/** A mapped target: a bare query name (full-bust) or a name + per-row scope. */
export type QueryNameTarget = string | { name: string; scope: ScopeKeyBuilder };

/**
 * Map of (schema.table) → camelCase queryNames that scope reads on it.
 * Keys are the exact strings the PG trigger emits in the `name` field
 * (`harness_shared.<table>.changed` becomes the lookup key after
 * stripping the `.changed` suffix). Values are {@link QueryNameTarget}s —
 * a bare string full-busts; `{ name, scope }` opts into per-row scoping.
 */
export const TABLE_TO_QUERY_NAMES: Readonly<Record<string, readonly QueryNameTarget[]>> = {
  // The harness registry is one JSONB row per workspace (mig 025); its
  // trigger (mig 222) is what defeats the bus's 90s source-side dedupe for
  // back-to-back registry changes (EI-206 — a create followed by a delete
  // inside the window left open harness lists stale).
  // network.board: a hive create/dissolve changes its tier 1–2 rows.
  'harness_shared.harness_registry': ['harnessProjects.lite', 'harnessWorkspaces.byHarness', 'network.board'],
  'harness_shared.contributors': ['contributors.byHarness'],
  'harness_shared.auto_review_audit': ['contributors.byHarness'],
  'harness_shared.adv_sessions': ['advSessions.list', 'advRoster.list'],
  // ── Per-harness HYPERBEE-bucket tables ────────────────────────────
  'harness_shared.harness_text_artifacts': ['harnessTextArtifact.byHarness'],
  // harness_design_artifacts backs the Design tab's sketch pane (designSketches.byFeature).
  // Trigger attached in mig 380 (data-sync-push-completion P-003) so a sketch save — POST
  // /api/design/sketches, raw SQL, or a FEDERATED git-doc write — pushes the pane live.
  'harness_shared.harness_design_artifacts': ['designSketches.byFeature'],
  'harness_shared.harness_project_files': ['harnessProjectFiles.byHarness'],
  'harness_shared.harness_skills': ['harnessSkills.byHarness'],
  'harness_shared.harness_decisions': ['harnessDecisions.byHarness'],
  'harness_shared.harness_lanes': ['harnessLanes.byHarness', 'harnessLanes.snapshot'],
  'harness_shared.harness_escalations': ['harnessEscalations.byHarness'],
  'harness_shared.harness_checkpoints': ['harnessCheckpoints.byHarness'],
  'harness_shared.harness_feature_prs': ['featurePrs.byHarness', 'featureTimeline.byFeature'],
  'harness_shared.harness_status': ['harnessStatus.byHarness', 'harnessStatus.snapshot'],
  'harness_shared.harness_tests': ['harnessTests.byHarness'],
  'harness_shared.harness_archives': ['harnessArchives.byHarness'],
  'harness_shared.harness_hook_logs': ['harnessHookLogs.byHarness'],
  'harness_shared.harness_smoke_test': ['harnessSmokeTest.byHarness'],
  // Plans went PG-canonical (plans-pg-canonical-migration-2026-06-03): a write to
  // harness_plans invalidates the plan directory + per-plan reads. plan_revisions
  // / plan_runs feed the audit + run panels.
  'harness_shared.harness_plans': [
    'plans.list',
    // plans.get (EI-7433): scoped by plan slug (mig 507's natural-key
    // fallback). The one live consumer (usePlan's `live:true` path,
    // apps/operator/app/admin/plans/plans-api.ts) always subscribes with
    // `{ slug, mode:'full', ...(harness && {harness}) }` — `scope` only
    // needs to return `{ slug }` (a MATCHING subset; extra consumer-side
    // keys like `mode`/`harness` are not required to match — see the
    // file-top note). `planSlugScope` falls back to full-bust when the
    // event carries no plan_slug (shouldn't happen for this table, but a
    // defensive `null` costs nothing).
    { name: 'plans.get', scope: planSlugScope },
    // plans.items stays a full-bust: it has NO live useSyncQuery consumer
    // today (grep apps/operator for queryName:'plans.items' — none), so
    // there's no confirmed consumer args shape to scope against; scoping a
    // name with an unconfirmed/no shape risks a silent stop-refreshing bug
    // the moment a consumer lands with different args. Revisit when one exists.
    'plans.items',
    'plans.attention',
    'plans.search',
    // plans.byHive (WI-259 P-006) — the cross-member plan rollup. A FEDERATED plan
    // write lands on harness_plans under the author member's slug + fires the change
    // notify, so a peer member's new/edited plan live-refreshes the hive rollup.
    'plans.byHive',
    // plans.schedule + plans.scheduledOccurrences (data-sync-push-completion P-002) —
    // the schedule lives in COLUMNS on harness_plans (schedule jsonb / schedule_active /
    // scheduled_at / expires_at / tzid — mig 299), NOT a separate plan_schedules table.
    // Every schedule-write path writes harness_plans: plans:set-schedule (setPlanSchedule),
    // plans:arm-schedule / disarm-schedule (UPDATE … SET schedule_active), and the routine
    // engine's own one-shot/expiry deactivations. Bridging here pushes the Calendar
    // (scheduledOccurrences, window-keyed → full-bust) + Routines (schedule) panes live on
    // ANY of those writes — including raw SQL / FEDERATED — which an explicit
    // notifySyncInvalidate in the 3 tools alone would miss.
    'plans.schedule',
    'plans.scheduledOccurrences',
    // rubrics.list (rubrics-tab-scorecard-ui-2026-07-09 P-002): rubrics are
    // plan-doc-backed (template = rubric, lib/rubrics.ts queryRubricPlans), so a
    // rubric create/ratify/edit is a harness_plans write — refresh the Rubrics tab.
    'rubrics.list',
  ],
  'harness_shared.plan_revisions': ['plans.revisions'],
  // plan_runs feeds BOTH the Agents-tab flat list (plans.runs, { slug }) and the
  // Runs-tab history+rollup (plans.runHistory, { planSlug }) — a row write busts both.
  'harness_shared.plan_runs': ['plans.runs', 'plans.runHistory'],
  'harness_shared.harness_brainstorm': ['harnessBrainstorm.byHarness'],
  'harness_shared.pending_reviews': ['pendingReviews.byHarness'],
  'harness_shared.harness_pending_issues': ['harnessPendingIssues.byHarness'],
  'harness_shared.harness_screenshots': ['harnessScreenshots.byHarness'],
  'harness_shared.agent_chats_consolidated': ['agentChats.byHarness'],
  'harness_shared.harness_feature_notes': ['featureNotes.byHarness'],
  'harness_shared.harness_feature_debug_notes': ['featureDebugNotes.byHarness', 'featureTimeline.byFeature'],
  'harness_shared.feature_audit_consolidated': ['featureAudit.byHarness'],
  // chunkPlans contributes 2 query names sharing 1 table; both fire.
  'harness_shared.harness_chunk_plans': [
    'chunkPlans.byHarness',
    'chunkPlans.byFeature',
  ],
  'harness_shared.harness_proposals_shared': ['proposalsShared.byHarness'],

  // ── Per-workspace tables ──────────────────────────────────────────
  'harness_shared.toast_log': ['toastLog.recent'],
  'harness_shared.operator_budget': ['operatorBudget.byWorkspace'],
  'harness_shared.audit_log': ['auditLog.operatorDecisions'],
  'harness_shared.user_actions': ['userActions.byHarness', 'userActions.byKind', 'userActions.recent'],
  'harness_shared.plugin_configs': ['pluginConfigs.byHarness'],
  'harness_shared.plugin_enables': ['pluginEnables.byWorkspace'],
  'harness_shared.project_spec_revisions': ['projectSpecRevisions.byProject'],

  // ── Cross-harness *Consolidated tables ────────────────────────────
  // work_items is the UNIFIED base table (mig-374 renamed harness_features_consolidated
  // -> work_items and backfilled engineer_issues into it). It carries emit_change_notify,
  // so a write — including raw-SQL / FEDERATED — fires harness_shared.work_items.changed.
  // This is the REAL invalidation producer for the work-item read families; the two
  // *_consolidated / engineer_issues names below are now compat VIEWS over work_items
  // (relkind 'v', so they cannot carry a row trigger and never emit .changed themselves —
  // a write routed through a view's INSTEAD-OF trigger still lands on work_items and fires
  // THIS event). The view keys are kept for documentation + are COVERAGE_EXEMPT in
  // cache-tag-trigger-coverage.integration.test.ts.
  'harness_shared.work_items': [
    'featuresConsolidated.bySlug',
    'featuresConsolidated.byPlanSlug',
    'harnessStatus.snapshot',
    // designFeatures.byHarness (data-sync-push-completion P-003) — the Design dashboard's
    // "features needing design" list reads work_items (needs_design / design_status /
    // design_spec_id columns) via harness_features_consolidated. A design-state flip on a
    // feature lands on work_items + fires work_items.changed, so the dashboard push-updates
    // instead of going stale until interaction.
    'designFeatures.byHarness',
    // featuresConsolidated.byHive (WI-259 P-006) — the cross-member rollup. A
    // FEDERATED content write lands on work_items under the AUTHOR member's slug and
    // fires work_items.changed (emit_change_notify), so a peer member's new/edited
    // feature live-refreshes every hive member's rollup. Coarse by design: a write
    // to any member busts the whole hive rollup (the rollup is hive-grained).
    'featuresConsolidated.byHive',
    'workItems.byHarness',
    'contributors.byHarness',
    'featureTimeline.byFeature',
    // scheduler.running (the live-execution view) reads work-item claims (taken_by /
    // taken_at / last_progress_at) off work_items via fleet_assignment — a claim/progress
    // flip refreshes the bee-run list (hybrid-bee-scheduler P-001).
    'scheduler.running',
    // rubrics.* / scorecards.* (rubrics-tab-scorecard-ui-2026-07-09 P-002): a
    // scorecard IS an engineer_issues row (compat view over work_items — THIS base
    // table is the invalidation producer), so a newly filed grading refreshes the
    // Rubrics-tab rollup, the per-rubric history, and the trend. Coarse by design:
    // any work-item write busts them; rubric-graded reads are cheap + low-rate.
    'rubrics.list',
    'scorecards.list',
    'rubrics.trend',
  ],
  // Compat view over work_items (post-374) — see the work_items producer above.
  'harness_shared.harness_features_consolidated': [
    'featuresConsolidated.bySlug',
    'featuresConsolidated.byPlanSlug',
    'featuresConsolidated.byHive',
    'harnessStatus.snapshot',
    'workItems.byHarness',
    'contributors.byHarness',
    'featureTimeline.byFeature',
    'scheduler.running',
    // designFeatures.byHarness (P-003) — documentary mirror of the work_items producer
    // above; this key is a compat VIEW (COVERAGE_EXEMPT) so the real .changed comes from
    // work_items, but listing it keeps the two arrays in sync.
    'designFeatures.byHarness',
  ],
  'harness_shared.harness_issues_consolidated': ['issuesConsolidated.bySlug'],
  // engineer_issues = the issue-family compat view over work_items (post-374; the base
  // table is the real producer above).
  'harness_shared.engineer_issues': ['workItems.byHarness'],
  // coord_links = the rel='blocks' feature/work-item blocking edge table (EI-1/D-027,
  // the single source of truth for blocking) + the rel='implements' plan↔work-item
  // ledger edges. A blocks-edge add/remove is the single most important
  // READINESS-changing mutation — it flips a work-item between ready/blocked — yet the
  // table emitted NO change-notify before caching-layer-tag-eca P-013 (mig-396 attaches
  // emit_change_notify here). Mapping it makes a blocker change live-refresh the
  // work-items grid (blocked/ready badges) AND brings the table under the cache-tag
  // coverage guard. Coarse by design: the row trigger fires on ALL rels (implements /
  // relates too), so an implements write also busts workItems.byHarness — harmless +
  // bus-deduped at coord_links's low write rate (~30/hr).
  'harness_shared.coord_links': ['workItems.byHarness'],
  'harness_shared.agent_runs_consolidated': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.recent',
    'featureTimeline.byFeature',
  ],
  // The agentRunsConsolidated.* rows JOIN spawned_agents for the run outcome
  // (spawnStatus/exitCode/errorMessage/sessionId — adv-harness-tab-migration
  // P-023), so an outcome flip must re-fire those queries too. The trigger is
  // column-targeted (migration 213) so heartbeat writes don't spam this.
  // workItems.byHarness joins the latest spawn per feature (spine position).
  'harness_shared.spawned_agents': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.recent',
    'workItems.byHarness',
    'fleetAssignments.byHarness',
    'advRoster.list',
    // sidebar.fleetCups reads the SAME fleet_assignment view as
    // fleetAssignments.byHarness, so a spawn/claim/presence flip must push the
    // Swarm sidebar's "Bees" cells too (else they stay stale until next
    // interaction). Bridged wherever fleetAssignments.byHarness is.
    'sidebar.fleetCups',
    // hiveRoster.byHive (presence-v2 P-006 fold) reads spawned_agents for the
    // Tier-1 model tier; an outcome/model flip re-fires it too. byHarness (P-007,
    // the MemberWorkPanel repoint) is the same fold keyed by harness→hive.
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    // scheduler.running resolves a bee run's holder liveness through the nursery
    // identity aliases (the fleet_assignment view), so a spawn status/heartbeat flip
    // moves a run between progressing/alive/dead.
    'scheduler.running',
  ],
  // fleetAssignments.byHarness (progress-tab-agents-convergence P-001) reads the
  // fleet_assignment view = presence + plan-item claims + work-item claims.
  // coord_presence fires on heartbeats too — the 90s (name,args) dedupe window
  // bounds the refetch rate; claim flips are what actually matter.
  // network.board reads live-agent counts off the same fleet view, so a
  // presence/claim flip refreshes its tier 1–3 liveAgents too (90s dedupe bounds
  // the heartbeat churn; grant/ask/beacon changes ride explicit
  // notifySyncInvalidate('network.board', {}) from their writers + the 60s
  // consumer safety-net).
  // dev.coordPresence is the live-agents roster (the Mod+U PresenceRail +
  // /coord dashboard read it): a heartbeat/intent/claim write must push the
  // roster too, not just the fleet view (shared-hive-collaboration P-006 — the
  // rail was a 30s poll before; SSE push replaces it).
  'harness_shared.coord_presence': [
    'fleetAssignments.byHarness',
    'sidebar.fleetCups', // same fleet_assignment view — keep the Swarm sidebar live
    'network.board',
    'dev.coordPresence',
    'agentDetail.byOwner',
    'advRoster.list',
    // hiveRoster.byHive (presence-v2 P-006) folds coord_presence + the fleet
    // work-detail; a presence/intent/claim/last_active write refreshes it too.
    // byHarness (P-007) is the same fold keyed by harness→hive.
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    // dev.assignableMembers (P-016) unions live presence + offline members — a
    // presence flip moves a person between the online/offline groups in the picker.
    'dev.assignableMembers',
    // scheduler.running derives each bee run's idle/blocked reason from the holder's
    // presence liveness — a heartbeat/intent flip refreshes the live-execution view.
    'scheduler.running',
  ],
  // hive_members (admission) is the offline half of the @-assign picker — a new
  // admitted member becomes assignable the moment they're admitted (P-016).
  'harness_shared.pot_members': ['dev.assignableMembers'],
  // hive_settings backs the owner-steering:* keys (queen-steering-panel B-01/C-1) —
  // a steering write refreshes the 👑 Queen tab's hive.steering query. The set tool
  // also fires notifySyncInvalidate explicitly; this covers a FEDERATED steering
  // write arriving from a peer Swarm (the keys federate via the capture trigger).
  'harness_shared.pot_settings': ['hive.steering'],
  'harness_shared.feature_claims': ['fleetAssignments.byHarness', 'sidebar.fleetCups', 'network.board', 'hiveRoster.byHive', 'hiveRoster.byHarness', 'scheduler.running'],
  'harness_shared.claim_audit': ['fleetAssignments.byHarness', 'sidebar.fleetCups', 'hiveRoster.byHive', 'hiveRoster.byHarness', 'scheduler.running'],
  // cup_claim_specs (né bee_claim_specs, cup-lexicon-full-rename-2026-07-09 P-009
  // Phase 2 / WI-3954) backs the per-run claim-spec specId@revision shown by the
  // live-execution view (scheduler.running) — a Queen set_claim_spec re-steer bumps the
  // revision a running bee shows (hybrid-bee-scheduler P-001 / D-007).
  'harness_shared.cup_claim_specs': ['scheduler.running'],
  // dev.coordFeed is the live coordination firehose (the PresenceRail Activity
  // tab + the /adv Conversations Feed). The emit_change_notify trigger on
  // coord_event_log is filtered to ORIGINAL rows (body->>'notify_kind' IS NULL)
  // so the per-subscriber fan-out delivery copies don't each fire — the busiest
  // coord table stays cheap (shared-hive-collaboration P-006). The (name,args)
  // dedupe bounds burst refetches.
  'harness_shared.coord_event_log': ['dev.coordFeed'],
  'harness_shared.harness_snapshots_consolidated': ['snapshotsConsolidated.bySlug'],

  // ── Insights / activity ledger (v5 addendum 3) ──────────────────
  // No camelCase query names yet — Insights tab + activity-feed reads
  // are P-073+ work. Mapped here in advance so trigger events have a
  // home the moment the consumers land; until then, the trigger fires
  // events with no matching subscriber (harmless no-op, dedupe handles).
  'harness_shared.contributor_usage_events': ['contributorUsageEvents.byHarness', 'contributors.byHarness'],
  'harness_shared.insights_first_visit': ['insightsFirstVisit.byHarness'],
};

/** The PG-trigger payload shape (`emit_change_notify`, migrations 368 + 507). */
export interface TriggerEventArgs {
  workspace_id?: unknown;
  op?: unknown;
  /** The changed row's `id` PK; absent (JSON null) for id-less tables. */
  id?: unknown;
  /** Natural-key fallback (mig 507, EI-7433) for id-less tables — currently
   *  only `harness_plans` carries this column; JSON null for every other
   *  triggered table. */
  plan_slug?: unknown;
}

/** A bridged invalidation target: a bare name (full-bust) or name + scoped
 *  args. Mirrors `@papercusp/sync/server`'s `BridgeTarget` (kept local so this
 *  module stays import-light; the bus accepts `string | { name, args }`). */
export type BridgedInvalidation =
  | string
  | { name: string; args: Record<string, unknown> };

/** Coerce the trigger payload's `id` to a non-empty string, else undefined.
 *  Postgres `to_jsonb(row)->'id'` yields a JSON null for id-less tables and a
 *  JSON number/string otherwise; either form normalizes here. */
function rowIdOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.id;
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'number' || typeof raw === 'bigint') return String(raw);
  return undefined;
}

function workspaceIdOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.workspace_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Natural-key fallback (mig 507, EI-7433): non-empty string `args.plan_slug`,
 *  else undefined. Absent (JSON null) for every table but `harness_plans`. */
function planSlugOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.plan_slug;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Scope builder for `plans.get` (EI-7433) — the resolved key IS the plan
 *  slug (harness_plans has no `id`, so {@link queryNamesForTriggerEvent}
 *  resolves the natural-key fallback into the same "key" slot `resolveBridgeTarget`
 *  passes as this function's first argument). Returns a SUBSET of the
 *  consumer's real args (`{ slug, mode, harness? }`) — see the file-top note
 *  on why a matching subset is sufficient for `invalidateQueries`.
 *
 *  A hoisted `function` declaration (not a `const` arrow) — `TABLE_TO_QUERY_NAMES`
 *  above references it and is itself a module-top `const`, so a `const` here
 *  would TDZ-fail at import time. */
function planSlugScope(slug: string): Record<string, unknown> | null {
  return slug ? { slug } : null;
}

/**
 * Resolve ONE mapped target against an event's row id + workspace.
 *
 *   - bare string → bare name (FULL-BUST), unchanged behavior.
 *   - `{ name, scope }` → SCOPED `{ name, args }` when `rowId` is present AND
 *     `scope(rowId, workspaceId)` returns a key object; otherwise the bare
 *     name (full-bust fallback — no id, or scope opted out for this event).
 *
 * Pure + exported so the scoping decision is unit-testable directly against a
 * `{ name, scope }` target (the live registry has only full-bust entries yet).
 */
export function resolveBridgeTarget(
  target: QueryNameTarget,
  rowId: string | undefined,
  workspaceId: string | undefined,
): BridgedInvalidation {
  if (typeof target === 'string') return target;
  if (rowId !== undefined) {
    const scopedArgs = target.scope(rowId, workspaceId);
    if (scopedArgs !== null) return { name: target.name, args: scopedArgs };
  }
  return target.name;
}

/**
 * The trigger-LESS append-heavy LOG tables the debounced change-detector must POLL
 * (append-heavy-invalidator.ts; data-sync-push-completion P-005/D-012). These are MAPPED above
 * but INTENTIONALLY carry NO per-row emit_change_notify trigger — a per-row pg_notify on a
 * high-write log is the notify-storm anti-pattern (mig 376 drops it; cache-tag-trigger-coverage's
 * COVERAGE_EXEMPT documents it). The detector MAXes a monotonic column per tick and synthesizes a
 * `<table>.changed` invalidation when it advances, so consumers push-update WITHOUT the per-row storm.
 *
 * RELATIONSHIP to cache/debounced-invalidate.ts (cache-expensive-tool-reads P-008): that module's
 * `APPEND_HEAVY_TABLES` Set is the CONSUMER-side cache coalescer — it debounces L1 cache-tag bumps
 * WHEN a `<table>.changed` fires. This list is the PRODUCER side — who FIRES `.changed` for the
 * trigger-less tables. They compose automatically: a synthesized `.changed` flows through sync-sse's
 * bridge → emitSystemEvent → the cache ECA's coalescer AND → the client query-name push. This list
 * is a strict SUBSET of that Set (it excludes coord_event_log, which already has a real mig-275
 * trigger, so it is NOT polled). A drift-guard test asserts the subset relation.
 *
 * `changeKey` = the MONOTONIC-on-insert bigint column the detector MAXes to detect new rows. NOT
 * every table has a usable integer `id`: audit_log's `id` is TEXT, and agent_runs_consolidated /
 * harness_hook_logs have NO `id` column — they carry a bigint epoch `ts` instead. (Found live: the
 * first cut assumed `id` everywhere and errored on 3 of 6.) All changeKeys are bigint so the sweep
 * compares them uniformly via BigInt(). Detection catches new rows; a pure UPDATE that doesn't
 * advance changeKey lags to the next insert / 180s drift-repair.
 */
export interface AppendHeavyTableSpec {
  readonly table: string;
  readonly changeKey: string;
}
export const APPEND_HEAVY_POLL_SPECS: readonly AppendHeavyTableSpec[] = [
  { table: 'audit_log', changeKey: 'ts' }, // id is TEXT — use the bigint ts
  { table: 'agent_runs_consolidated', changeKey: 'ts' }, // no id column
  { table: 'user_actions', changeKey: 'id' },
  { table: 'harness_hook_logs', changeKey: 'ts' }, // no id column
  { table: 'toast_log', changeKey: 'id' },
  { table: 'feature_audit_consolidated', changeKey: 'id' },
] as const;

/**
 * Given a trigger-event name like `harness_shared.<table>.changed` (+ the
 * trigger's `args` payload), return the bridged invalidation targets. See
 * {@link resolveBridgeTarget} for the per-target scope/full-bust decision.
 *
 * Returns an empty array for unknown tables / malformed names. Pure —
 * caller emits the synthesized events.
 */
export function queryNamesForTriggerEvent(
  triggerEventName: string,
  triggerArgs?: TriggerEventArgs,
): readonly BridgedInvalidation[] {
  // Strip the `.changed` suffix.
  if (!triggerEventName.endsWith('.changed')) return [];
  const tableKey = triggerEventName.slice(0, -'.changed'.length);
  const targets = TABLE_TO_QUERY_NAMES[tableKey];
  if (targets === undefined) return [];

  // EI-7433: prefer the true row PK; fall back to the natural-key (mig 507)
  // for id-less tables (today: harness_plans's plan_slug). Whichever is
  // present becomes the "key" resolveBridgeTarget hands to a target's
  // `scope` builder — a target's own scope function decides what it means
  // (an id-keyed scope treats it as a PK; planSlugScope treats it as a slug).
  const rowId = rowIdOf(triggerArgs) ?? planSlugOf(triggerArgs);
  const workspaceId = workspaceIdOf(triggerArgs);
  return targets.map((t) => resolveBridgeTarget(t, rowId, workspaceId));
}

/** Test-only — enumerate every camelCase name covered by the bridge. */
export function allBridgedQueryNames(): string[] {
  const set = new Set<string>();
  for (const targets of Object.values(TABLE_TO_QUERY_NAMES)) {
    for (const t of targets) set.add(typeof t === 'string' ? t : t.name);
  }
  return Array.from(set).sort();
}
