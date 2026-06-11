---
rel_path: "audit/full-app-audit-2026-06-09.md"
updated_at: 1781035142115
_body: "content"
---

# Papercusp full-app audit — full evidence (2026-06-09)

Companion artifact to plan `papercusp-full-app-audit-2026-06-09`. Verbatim findings from 9 parallel read-only subsystem reviewers, staging @ ~8747c8641. Each plan item P-NNN points back here for the Evidence + suggested Fix. RE-VERIFY every cited line at HEAD before implementing (plan D-001).

---

## 1. Operator server-side (apps/operator/lib + bin, endpoint routes)

### [BUG] critical — root cause of EI-125: outbox GC scans the entire table, not per-harness
- Where: packages/operator-core/lib/sync/hyperbee/outbox-drain.ts:120-134
- Evidence: The GC CTE selects rows WHERE drained_at IS NOT NULL AND drained_at < cutoff with NO workspace_id/harness_slug predicate. Every drain instance for every harness runs this global GC; with ~15 booted harnesses at 5s poll, concurrent global DELETEs fight over the same locks and the table inflated to 102GB. Pre-batching, the single unbounded DELETE never committed before the 12-min memory-watchdog recycle.
- Fix: Add workspace_id + harness_slug predicates to the GC CTE so each drain instance GCs only its own rows.

### [BUG] critical — root cause of EI-64: GET /api/harness/projects issues N PG probes per harness
- Where: packages/operator-core/lib/endpoint-route/routes/harness/projects.ts:156-163
- Evidence: The hasState check calls getLegacyClient(p.slug) → getHarnessPg(p.slug) per harness inside Promise.all — 767 PG round-trips against an LRU pool cap of 8. 76s on :3070 (408), 16s on :3170. The 5s TTL cache does not prevent this on first fill after invalidation.
- Fix: Batch into a single SQL over all slugs (or an FS existence check). See also the stale cache-signature finding below.

### [BUG] critical — root cause of EI-82: DELETE /harness/projects/:slug read-modify-write race
- Where: packages/operator-core/lib/endpoint-route/routes/harness/projects.ts:394-409
- Evidence: loadHarnessRegistry() → filter → saveHarnessRegistry() with no CAS/transaction. Concurrent DELETE + POST race and resurrect removed entries.
- Fix: Optimistic-lock UPDATE … WHERE data = prev, or a pg advisory lock keyed on workspace_id||'harness_registry'.

### [BUG] major — root cause of EI-127/EI-79 (contributor): module-level handles/inflight Maps in boot-all.ts hold live Hypercore/Hyperswarm handles; never closed before watchdog exit
- Where: packages/operator-core/lib/sync/hyperbee/boot-all.ts:44-45
- Evidence: BootedHarnessHandle holds a Hypercore + Hyperswarm peer socket + close-hooks (LISTEN connection + poll timer). closeAllBootedHarnesses() is never called before the memory watchdog's process.exit(0).
- Fix: Call closeAllBootedHarnesses() inside the watchdog onTrip before server.close().

### [BUG] major — root cause of EI-119/EI-80: embed-backfill opens a raw pg.Client per sweep
- Where: packages/operator-core/lib/search/embed-backfill.ts:243-250
- Evidence: runBackfillSweep() calls new Client() + connect() every invocation (every 5min). On the deployed pure-ESM operator the CJS pg build's internal require() surfaces "require is not defined" — embeddings silently stop backfilling.
- Fix: Use the shared getOrgPg().sql pool; rewrite queries as tagged templates. Also pin _sweepRunning/_lastResult to globalThis (A18).

### [BUG] major — SSE route lacks timeoutSec:null; 30s route-stack watchdog kills healthy streams (root cause of EI-110)
- Where: packages/operator-core/lib/endpoint-route/routes/zero-harness/sse.ts:20-53; route-stack.ts:155
- Evidence: invokeStep applies exec.def.timeoutSec ?? 30. Under PG contention the SSE setup exceeds 30s, abort fires, and the stack discards the already-streaming response and returns 408.
- Fix: timeoutSec: null on SSE routes; audit MCP transport routes similarly.

### [BUG] major — sweepAgentRunsRunning interpolates schema + cutoff into sql.unsafe
- Where: packages/operator-core/lib/harness-status-sweep.ts:100-103
- Evidence: UPDATE ${schema}.agent_runs … < ${cutoff} via sql.unsafe — unparameterized identifier+value; plan-cache miss every 30s tick; latent injection if slug sanitization ever weakens.
- Fix: sql(schema) ident escaping + $1 parameter.

### [BUG] major — boot-all reads workspace IDs from registry.json (FS) post-PG-migration; silently boots zero harnesses when stale
- Where: packages/operator-core/lib/sync/hyperbee/boot-all.ts:432-446 (+ readdirSync at :68)
- Fix: Source from the PG registry path used by host-bootstrap.

### [IMP] major — projects cache signature stats a dead legacy JSON; registry changes never bust the cache
- Where: packages/operator-core/lib/endpoint-route/routes/harness/projects.ts:126-131
- Fix: Bust on a PG harness_registry sequence/timestamp; clear sig on mutations.

### [IMP] major — EI-100 confirmed: all 767+ routes auth:'public'; hono-host bind falls back to HOSTNAME before 127.0.0.1
- Where: apps/operator/bin/hono-host.ts:66; defineTool calls across endpoint-route/routes/**
- Fix: Default 127.0.0.1 unconditionally; auth tier for mutating routes.

### [IMP] minor — harness-status-sweep SIGTERM/SIGINT handlers accumulate across ensure/stop cycles
- Where: packages/operator-core/lib/harness-status-sweep.ts:198-200
- Fix: process.off in stopHarnessStatusSweep.

Health summary: the most critical failure modes are structurally linked single-line fixes (GC scoping, projects N+1, SSE watchdog); the deeper RSS leak traces to substrate handles never closed before exit; security exposure is real but LAN-limited until route auth lands.

---

## 2. Operator UI (apps/operator/app + operator-vite SPA)

### [BUG] critical — ForkCompletionForm calls retired /api/snapshots endpoints
- Where: apps/operator/app/_components/ForkCompletionForm.tsx:114
- Evidence: Fetches /api/snapshots/:id/shape and POSTs /api/snapshots/:id/instantiate; snapshot system retired 2026-06-09, migration 199 drops snapshot_index. Any render path silently 404s.
- Fix: Remove or redirect to the blueprint-install successor.

### [BUG] major — six dock panels hand-roll fetch + setInterval instead of useSyncQuery
- Where: app/harness/dock/RealLogsPanel.tsx:41-65, RealFeaturesPanel.tsx:48-71, RealIssuesPanel.tsx:56-77, RealHarnessOverviewPanel.tsx:91-116, PinnedFeaturePanel.tsx:53-81, PinnedIssuePanel.tsx:61-88
- Evidence: Individual 3s/5s/10s intervals hitting harness status endpoints — the exact pattern CLAUDE.md forbids; forks reconnect/invalidate logic and adds steady :3070 load.
- Fix: useSyncQuery + resolver entries; drop intervals.

### [BUG] major — CoordHistory re-creates its polling interval per filter change; stale fetches race setData
- Where: app/coord/CoordHistory.tsx:84-103
- Fix: AbortController/cancel flag; better, migrate to useSyncQuery.

### [BUG] major — RealLogsPanel unstable composite key ts-idx
- Where: app/harness/dock/RealLogsPanel.tsx:169
- Fix: stable content-derived key or server id.

### [IMP] major — DelegatesSection filter tab in useState (nuqs violation)
- Where: app/_components/DelegatesSection.tsx:65
- Fix: useQueryState + parseAsStringEnum.

### [IMP] major — gsap imported/used; perf docs list it under "Don't use"
- Where: app/_components/OracleDock.tsx:18,61; ChromeShell.tsx:6; RouteTransitionProvider.tsx:5
- Fix: motion / CSS keyframes.

### [IMP] major — raw <details> mounts children eagerly (A6)
- Where: app/settings/api-keys/page.tsx:477-509; app/users/github/[id]/UserProfile.tsx:128-143; app/dev/_components/TablesTab.tsx:458,470; voice/page.tsx:1136
- Fix: LazyDetails.

### [IMP] major — width transitions on data-driven bars (perf rule 4)
- Where: app/harness/InsightsPanel.tsx:123,158; app/harness/dock/RealHarnessOverviewPanel.tsx:279; harness.css:1310
- Fix: transform: scaleX, transform-origin left.

### [IMP] major — OracleDock polls the DOM every 750ms for a Chatwoot iframe src (A7)
- Where: app/_components/OracleDock.tsx:938
- Fix: MutationObserver or postMessage.

### [IMP] minor — CollectionTab hardcodes ?item= (instances collide); missing selected-item-deleted guard; effect deps
- Where: app/harness/CollectionTab.tsx:53,64-66
- Fix: paramKey prop; gate on items.some(i => i.id === selectedId).

### [IMP] minor — RealHarnessOverviewPanel one-shot hydration spreads stale params
- Where: app/harness/dock/RealHarnessOverviewPanel.tsx:56-89
- Fix: paramsRef.

Health summary: the systemic problem is the data-sync violation across dock panels + several pages; A6/width-transition/gsap violations and the dead snapshot form round it out; nuqs compliance is good in main pages, weak in panel components.


---

## 3. operator-core tool surface (agent-tools, endpoint-route, sync-resolver, plans/locks/coord)

### [BUG] critical — EI-118 root cause: withPlanLock holds the PG transaction open across afterWrite, which opens a SECOND connection (recordPlanRevision)
- Where: packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts:112,198-202; revisions.ts:104
- Evidence: withPlanLock opens withWorkspace(workspaceId) (one BEGIN) and, still inside it, calls opts.afterWrite which calls recordPlanRevision opening its own withWorkspace(DEFAULT_WORKSPACE_ID) transaction. If the inner call hangs (PG contention), the outer plans-write transaction sits idle-in-transaction, blocking all pg_advisory_xact_lock attempts on that plan — exactly EI-118's fleet-wide wedge.
- Fix: Run afterWrite after the outer withWorkspace resolves; revisions are best-effort.

### [BUG] critical — recordPlanRevision (and 6 sibling fns) hardcode DEFAULT_WORKSPACE_ID
- Where: packages/operator-core/lib/agent-tools/plans/revisions.ts:104,339,394,446,502,525,572
- Evidence: Plan content is written workspace-scoped but ALL revisions land in the default workspace — invisible to the owning workspace, polluting default.
- Fix: Thread the resolved workspaceId through RecordPlanRevisionArgs + all callers.

### [BUG] major — set-content-chunk leaves the tmp draft on disk on busy/stale/lint-failed
- Where: packages/operator-core/lib/agent-tools/plans/set-content-chunk.ts:270-291 (removeDraft only on success at :304)
- Fix: try/finally removeDraft + TTL janitor for the drafts dir (os.tmpdir()/papercusp-plan-content-drafts).

### [BUG] major — EI-141 root cause: add-decision heading regex matches "## Decisions (settled)"
- Where: packages/operator-core/lib/agent-tools/plans/add-decision.ts:118 (headingRe …Decisions\b[^\n]*$)
- Fix: Anchor strictly / skip parenthetical-suffix headings. Also the double blank line from block's leading \n at :109,130-131.

### [BUG] major — EI-117 root cause candidate: revisions-backfill count+insert in SEPARATE transactions
- Where: packages/operator-core/lib/agent-tools/plans/revisions-backfill.ts:98-103 (+ 200× sequential git-show INSIDE the plan lock at :122-141)
- Fix: Single transaction for count+insert; hoist git reads out of the lock.

### [BUG] major — locks grant_cascade ON CONFLICT DO NOTHING loses grant rows (EI-129/EI-130 root-cause candidate)
- Where: libs/papercusp/packages/locks/src/sql/003-grant-cascade.sql:49-56
- Evidence: A waiter can be flipped status='granted' while fewer than |paths| rows landed in agent_file_locks — it believes it holds all paths; missing paths are unprotected/un-acquired.
- Fix: DO UPDATE … WHERE owner = EXCLUDED.owner + post-insert count check; roll back to FIFO on shortfall.

### [BUG] major — SU_ROLES duplicated 42× with no canonical export (EI-145 root cause)
- Where: e.g. agent-tools/plans/set-content.ts:46-56, set-content-chunk.ts:26-36 + 40 more files
- Fix: One exported SU_ROLES (pattern: coordination/roles.ts COORD_ROLES).

### [BUG] major — withPlanLock busy result reports the CALLER's deadline as expires_ts
- Where: packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts:130-143
- Fix: Report holder TTL or omit.

### [BUG] major — plans:list/search load + parse every plan body per request, no LIMIT (EI-98/EI-174/EI-175)
- Where: agent-tools/plans/source.ts:362-379 (listPlanRows); search.ts:130
- Fix: SQL-side filters via the indexed projection columns + LIMIT cap.

### [IMP] major — plans:set-content has no mass-deletion guard (EI-83)
- Where: agent-tools/plans/set-content.ts:61-64
- Fix: suspicious_shrink rejection (>80% shrink without allowShrink:true).

### [BUG] minor — add-decision double blank line; [IMP] minor — inbox-wake dynamic flag imports per call (a transient load failure silently disables the gate)
- Where: add-decision.ts:130-131; coordination/inbox-wake.ts:84-91

Health summary: plans write path structurally sound (advisory lock, CAS, lint) but the afterWrite transaction-leak is critical; grant_cascade is the likely locks-wake root cause; 42-copy SU_ROLES is the standing maintenance hazard.

---

## 4. operator-core engine (dbos, fleet, events/wake, iq-battery)

### [BUG] critical — EI-172 root cause: INVOKE_TIMEOUT_MS frozen at module init; gen0 --timeout-ms ignored
- Where: packages/operator-core/lib/dbos/orchestrator-runner.ts:75
- Evidence: Top-level const captured at import; bee-instance never passes opts.timeoutMs through spawnInvokeOnce, so runChild always uses the frozen 600s and SIGTERMs heavy bees.
- Fix: Read env lazily AND thread timeoutMs through OperatorSpawnInput → spawnAgentInHarness → spawnInvokeOnce.

### [BUG] major — GOVERNOR_MAX_WAIT_MS same frozen-at-init pattern
- Where: dbos/orchestrator-runner.ts:78

### [BUG] critical — EI-94 root cause: getKnownHooks greps the retired main-loop.ts; always returns ['pre-worker']
- Where: packages/operator-core/lib/known-hooks.ts:23
- Evidence: orchestrator/src/main-loop.ts no longer exists in the live tree (retired to _retired/orchestrator-run-loop); existsSync false → fallback forever. UI hook picker permanently shows one entry.
- Fix: Static registry of live DBOS hook points (runHook call sites in orchestrator-runner.ts).

### [BUG] critical — EI-164 root cause: beekeeper_runs UNIQUE(instance_id, case_id) blocks repeats>1
- Where: libs/papercusp/libs/db/sql/180-beekeeper-runner.sql:31; iq-battery/beekeeper-store-pg.ts:50-66
- Evidence: run_id encodes the repeat so ON CONFLICT(run_id) never fires; the second repeat violates UNIQUE(instance_id,case_id) and crashes the battery.
- Fix: Migration dropping (or extending) the constraint.

### [BUG] major — EI-73 root cause: spawn cap-check and recordSpawn not atomic; no idempotency key
- Where: packages/operator-core/lib/fleet/operator-spawn.ts:347-386
- Fix: Caller-supplied idempotency key + single-transaction reclaim/count/insert.

### [BUG] major — events/await pumpInFlight is one module-global boolean across all workspaces
- Where: packages/operator-core/lib/events/await/engine.ts:149,197-198
- Evidence: A slow pump for workspace A blocks pumps for B; concurrent emit kicks silently dropped.
- Fix: Per-workspace keying.

### [BUG] major — EI-162 root cause: fix-injected-bug corpus groundTruth points at non-existent code
- Where: packages/operator-core/lib/iq-battery/corpus.ts:44 (work-items.ts:rankItems), :110 (inbox.ts:subscribe), :173 (search.ts:executeSearch)
- Fix: Real injection tooling (inject→verify→score) or corrected locations.

### [BUG] major — DBOS debugger-hook/finalizer open a fresh postgres() pool per invocation
- Where: dbos/orchestrator-runner.ts:495-534
- Fix: Cached per-harness pool / getOrgPg().

### [BUG] minor — wake-executor omp resume sends text+CR as ONE write (paste-detector swallows the submit)
- Where: events/await/wake-executor.ts:425-430 (claude inject path at :310-318 already splits)
- Fix: Split writes with TURN_SUBMIT_CR_DELAY_MS.

### [BUG] minor — dispatchOneHarness swallows ALL errors silently
- Where: dbos/orchestrator-loop.ts:654-658
- Fix: console.warn in the catch.

### [IMP] minor — meanComposite divides by scored.length → NaN when all runs errored
- Where: iq-battery/beekeeper-runner.ts:229-232

### [BUG] major — spawn count can re-count just-reclaimed rows (read-committed gap)
- Where: fleet/operator-spawn.ts:347-356
- Fix: Reclaim + count in one transaction/CTE.

Health summary: orchestrator-runner/fleet-spawn architecturally sound but carry compounding module-init freezes and the stale known-hooks grep; iq-battery has two correctness bugs making gen-0 multi-repeat non-functional; pumpInFlight starvation worsens with workspace count.


---

## 5. agent-mcp (MCP server, auth, role gating)

### [BUG] critical — principal CACHE never evicted: capability revocation is inoperative
- Where: packages/agent-mcp/src/auth.ts:38-43,141-143
- Evidence: Module-scoped Map grows unboundedly; the doc-comment promises a PG NOTIFY→invalidate() wiring but invalidate() is only imported by auth.test.ts — no production LISTEN exists. Revocations take effect only on process restart.
- Fix: Wire PG LISTEN→invalidate() and/or per-entry TTL.

### [BUG] critical — same CACHE is an unbounded leak per distinct pi session (EI-79 contributor)
- Where: packages/agent-mcp/src/auth.ts:38
- Evidence: Every pi principal has a unique session_id slug → unbounded key space; ended sessions aren't cached (null not stored) so they also cause a PG round-trip per call.
- Fix: TTL/LRU + cache the null result.

### [BUG] major — EI-68 root cause: hono-host swallows ERR_INVALID_STATE on client disconnect mid-write; tool result permanently lost
- Where: apps/operator/bin/hono-host.ts:32-45
- Evidence: The tool executed (DB write committed) but the response is discarded; caller can't distinguish "ran, result dropped" from "never ran".
- Fix: Idempotency key + persisted last-result replay (short-lived PG row keyed by spawnId+toolName).

### [BUG] major — artifacts tools bypass the workspace-scoped tx via getOrgPg() (BYPASSRLS)
- Where: packages/agent-mcp/src/tools/artifacts/save.ts:59-68, append.ts:60, load.ts:59, delete.ts:49
- Fix: Use ctx.tx like every other tool.

### [BUG] major — phantom 'tester' role in artifacts allowlists (not in AGENT_ROLES)
- Where: tools/artifacts/save.ts:19, append.ts:19, load.ts:24

### [BUG] major — dead tools still registered: hindsight:recall (always degraded-empty since 2026-05-09), dev:hello-card fixture
- Where: tools/hindsight/recall.ts:1-8,76-85; tools/dev/hello-card.ts:7-10; bootstrap.ts:28,50

### [BUG] major — messages:inbox SLUG_RE admits dots that survive into the schema ident
- Where: packages/agent-mcp/src/tools/messages/inbox.ts:36-47
- Fix: replace(/[^a-z0-9]/g,'_') like resources/harness/issues.ts:42, or tighten SLUG_RE.

### [BUG] minor — search:query per-kind ILIKE fallbacks not isolated; one failure errors the whole search
- Where: packages/agent-mcp/src/tools/search/query.ts:65-83

### [IMP] major — prompt-assembly Role union (11) diverges from AGENT_ROLES (20+)
- Where: packages/operator-core/lib/prompt-assembly.ts:103-115
- Fix: Derive from typeof AGENT_ROLES[number].

### [IMP] minor — tool-manifest parse failure caches null (expose-all) permanently until manual reload
- Where: packages/agent-mcp/src/tool-manifest.ts:33-61

Health summary: auth/dispatch logically sound (timingSafeEqual, signed URLs verified), but the permanent principal cache breaks revocation and leaks; artifacts tools bypass RLS; EI-68 needs a structural idempotency layer.

---

## 6. libs/papercusp (engine, blueprints, db, embedded-pg, orchestrator)

### [BUG] major — readFeaturesPg substitutes '' for a missing harnessSlug; joins match nothing and gates silently pass
- Where: libs/papercusp/packages/orchestrator/src/state-pg.ts:109,134
- Fix: Early-return like readStartedPlanSlugsPg (:194).

### [BUG] major — prompt-resolve never includes the documented base/<role>.md layer
- Where: libs/papercusp/packages/orchestrator/src/prompt-resolve.ts:50-73 (prompts/base/*.md exist on disk, never read)
- Fix: Add base candidates + concatenate, or fold base into concrete prompts + fix README.

### [BUG] major — migration-number collisions still occur despite the reservations table (EI-170)
- Where: libs/db/sql/205-tool-invocations-error-code.sql:3-6 and 206-watchdog-ticks-deferred-keys.sql:6 record renumber-after-collision histories
- Fix: db:next-migration must fail unreserved numbers; lint duplicate NNN prefixes.

### [BUG] major — harnessSlug() does execFileSync(curl) — synchronous, blocks the event loop up to 4s; default operator base is :3055 (wrong port, Vite)
- Where: libs/papercusp/packages/orchestrator/src/state.ts:147-162
- Fix: Default :3070; make async or rely on the projectDir fallback.

### [BUG] major — chunk-plan-pg persistPlan: DELETE + per-chunk INSERTs with no transaction
- Where: libs/papercusp/packages/orchestrator/src/chunk-plan-pg.ts:43-61
- Fix: One transaction.

### [BUG] minor — migration runner double-wraps files containing their own BEGIN/COMMIT; strips ON_ERROR_STOP silently
- Where: libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js:99 (85 files contain BEGIN/COMMIT)
- Fix: Lint raw BEGIN; in migrations; document the runner-provides-transaction contract.

### [IMP] major — durableOwnedFeatureIdsPg defaults ON contradicting its documented default-off; +2 serial PG round-trips per director turn
- Where: state-pg.ts:145-166

### [IMP] minor — beekeeper_instances UNIQUE(workspace_id, code_sha, genome_id) inert when genome_id IS NULL
- Where: libs/db/sql/180-beekeeper-runner.sql:15
- Fix: Partial unique index WHERE genome_id IS NULL.

### [IMP] minor — invoke.test.ts checkpoint-tree coverage appears removed rather than fixed (EI-146); state.test.ts asserts status values possibly absent from FeatureRecord union (EI-167)
- Where: orchestrator/src/invoke.test.ts; state.test.ts:133-138

Health summary: engine core well-tested; the two most impactful live bugs are known-hooks (cross-listed §4) and the beekeeper UNIQUE constraint; migration discipline improved but races persist.

---

## 7. papercusp-desktop (Tauri shell)

### [BUG] critical — kill_sidecar called twice on normal close (CloseRequested + RunEvent::Exit) — double-kill race
- Where: papercusp-desktop/src-tauri/src/main.rs:1486-1496
- Fix: shutdown_done AtomicBool guard.

### [BUG] critical — static updater endpoints baked at :3055 in tauri.conf.json; background update polls always fail packaged
- Where: papercusp-desktop/src-tauri/tauri.conf.json:76 (dynamic resolve_update_endpoint at main.rs:613-628 is correct)
- Fix: Remove the static entry. Also dev resolve_update_endpoint hardcodes :3055 while devUrl is :3070 (main.rs:615-617).

### [BUG] major — beforeDevCommand spawns dev:operator with no reaper; children orphaned to PID 1 per tauri dev restart (root cause of EI-142)
- Where: tauri.conf.json:7; bin/dev-operator-ifneeded.sh:35
- Fix: trap + kill the process group on exit.

### [BUG] major — Windows path hard-kills (TerminateProcess) with no grace; embedded PG never gets pg_ctl stop
- Where: main.rs:1526-1540

### [BUG] major — wait_for_operator blocks the Tauri setup thread up to 120s (frozen app; macOS watchdog risk)
- Where: main.rs:431-447,1376
- Fix: async task + loading window with visible failure state.

### [BUG] minor — build-desktop-sidecar.sh rm -rf + mkdir with no flock; concurrent builds clobber (EI-160)
- Where: bin/build-desktop-sidecar.sh:115-117
- Fix: flock + temp-dir + atomic mv -T.

### [BUG] minor — NativeTerminal shutdown uses Child::kill (SIGKILL) despite comment claiming graceful
- Where: src-tauri/src/native_terminal.rs:1801

### [IMP] minor — dev_bridge Condvar wait .unwrap() panics on poisoned mutex, silently killing the bridge thread
- Where: src-tauri/src/dev_bridge.rs:810 (also token-file guard at :471-511)
- Fix: unwrap_or_else(|e| e.into_inner()).

### [IMP] minor — tauri-bridge.mjs committed with a static token + fixed port
- Where: papercusp-desktop/tauri-bridge.mjs:2-3
- Fix: Delete (superseded by token-file discovery).

Health summary: lifecycle architecture sound; most dangerous are the double-kill race, the baked updater endpoint, and the blocking 120s setup poll. EI-142 confirmed as script-layer (no reaper).


---

## 8. Generic libs (sync, locks, rate-limit, hyperbee, flags)

### [BUG] critical — EI-81 root cause: mergeAdmittedLogsIncremental hot-loops without yielding
- Where: packages/operator-core/lib/sync/hyperbee/read-merge.ts:369-389
- Evidence: Inner for-loop awaits readOpBoundedDetailed sequentially; local-corestore gets resolve via microtask, so up to 50,000 consecutive awaits never yield a macrotask — monopolizes the event loop at the 1Hz poll, matching the ~1.5-core burn.
- Fix: await new Promise(setImmediate) every ~1k ops.

### [BUG] critical — EI-115/EI-116 root cause: proc-mesh 'admitted' detection is a 100ms polling race
- Where: lib/sync/hyperbee/perf/child-driver.ts:237-243; peer-child.ts:252-257
- Fix: Emit 'admitted' directly from the admission callback; drop the poll.

### [BUG] major — admitPeer mutates admitted/pubkeyToLogKey OUTSIDE the merging gate; pending-retry setInterval is not re-entrant-safe
- Where: lib/sync/hyperbee/boot.ts:1002-1035,1079-1136
- Fix: Queue admissions drained under the merge lock; sequential rescheduling instead of bare setInterval.

### [BUG] major — rate-limit: checkHard never prunes recent; after a lockout expires the FIRST new failure immediately re-locks
- Where: libs/generic/rate-limit/src/index.ts:151-168
- Fix: Prune recent in checkHard; reset lockedUntilMs after window filter in burnHard.

### [BUG] major — invalidation-bus dedupe key serializes the FULL payload (CPU per notify; dedupe defeated for data-bearing events)
- Where: libs/generic/sync/src/server/invalidation-bus.ts:205-210

### [BUG] major — transport fallback is a one-way ratchet: a single SSE blip pins the component to POLLING until remount; stale fallback timer not cancelled on delay change
- Where: libs/generic/sync/src/fallback/useTransportFallback.ts:34-61

### [BUG] major — hyperbee cursor re-apply after reset relies on SQL ts-guards; a del re-applied over a newer put from a not-yet-cursored log can incorrectly delete
- Where: lib/sync/hyperbee/read-merge.ts:385-388 + applyHyperbeeOpToPg projections
- Fix: Verify/tighten every projection's ts-guard; document as load-bearing; regression test.

### [BUG] minor — usePollingQuery queryKey uses the raw args object; non-memoized callers trigger refetch storms
- Where: libs/generic/sync/src/transports/polling/usePollingQuery.ts:39-49
- Fix: use argsKey string.

### [BUG] minor — FLAG_DEFAULTS: ORACLE/HARNESS_PHASES/DESIGN false-defaults look like stale V1-cut batch vs the alpha default-ON policy
- Where: libs/flags/src/types.ts:71-100 — owner confirms each flip.

### [IMP] minor — resilient-event-source registers visibilitychange even when no EventSource ctor exists (SSR/test listener leak)
- Where: libs/generic/sse/src/client/resilient-event-source.ts:279-281,310-319

### [IMP] minor — invalidation-bus stop() doesn't drain in-flight notifies (silent discard)
- Where: libs/generic/sync/src/server/invalidation-bus.ts:221-225 — document or add drain.

Health summary: hyperbee substrate architecturally sound but three load-bearing concurrency hazards (yield starvation, admitPeer race, retry re-entrancy); sync transport solid except the one-way fallback ratchet; rate-limit has the post-lockout re-lock bug.

---

## 9. Cross-cutting security + hygiene sweep

### [BUG] major — public unauthenticated process-kill routes lack the loopback guard their siblings use
- Where: packages/operator-core/lib/endpoint-route/routes/harness/process-control.ts:48,64,80 (pause/unpause/stop → SIGSTOP/SIGCONT/SIGTERM via /proc walk)
- Fix: requireLoopbackOr403 or trust tier like dev/processes-kill.ts.

### [BUG] major — public plugin-runtime dispatcher exposes secrets/db/fetch/storage; slug/plugin not traversal-checked
- Where: packages/operator-core/lib/endpoint-route/routes/plugin-runtime/catchall.ts:42-50
- Fix: loopback/trust auth + normalize/confine before join().

### [BUG] major — npm ci broken (EI-84 confirmed): vitest@4.1.8 vs @vitest/coverage-v8@4.1.7 exact-peer; @xterm addons peer-require ^5 against ^6
- Where: root package.json / package-lock.json

### [IMP] major — 475-error lint:tsc baseline neutralizes strictness for operator-core (EI-104 pattern)
- Where: packages/operator-core/.tsc-baseline.json; scripts/lint-tsc.mjs:50-63
- Fix: Ratchet-only-down + hard-fail never-compiling files.

### [IMP] major — ~55 raw fetch+setInterval pollers in apps/operator/app/** (data-sync law violation; steady :3070 load)
- Where: exemplars CoordDashboard.tsx:191, HarnessTopBar.tsx:64, ProcessesTab.tsx:91, OperatorActiveToggle.tsx:90

### [BUG] major — :3070 RSS leak only mitigated by self-recycle; TTL caches never delete expired keys
- Where: lib/memory-watchdog.ts (documents ~0.2GB/min growth); endpoint-route/routes/agent-mcp/operator-el-spend.ts:17; harness-insights/github-facts.ts:243-560 (×4 caches)
- Fix: Eviction sweeps/LRU caps + heap-profile under fleet load.

### [IMP] minor — PG-mirror anti-pattern: promote.ts dual-writes review to PG AND a JSON file
- Where: endpoint-route/routes/harness/promote.ts:95-119

### [IMP] minor — spawnSync(shell:true) on repo/docs-harvested test command
- Where: lib/blueprint/detect-from-repo.ts:336-338; orchestrator/src/scratch-env.ts:173

### [IMP] minor — Drizzle generated schema: 20 TODO columns dropped to unknown (bytea/tsvector/vector)
- Where: libs/papercusp/libs/db/src/schema/generated.ts:593,886,926 et al.

### [IMP] minor — default superuser DB password baked into frame provisioning
- Where: lib/deployment/frame-bootstrap.ts:307-312 (CREATE ROLE harness_admin … PASSWORD 'harness_admin_pwd' SUPERUSER)

### [IMP] minor — plugins hardcode localhost:5432 DSN fallbacks (no discovery)
- Where: libs/papercusp/plugins/{jira-sync,linear-sync,postgres-manager}/index.ts; design-phase/index.cjs:436,659,708

### [IMP] minor — possible live ZQL importer in libs/papercusp/apps/web
- Where: libs/papercusp/apps/web/app/harness/issues/IssuesList.tsx:11 — confirm retirement or migrate.

### [IMP] minor — execSync(`command -v ${bin}`) shell interpolation
- Where: lib/ensure-omp-su.ts:34

Health summary: structurally disciplined repo (strict tsconfigs, storage policy, _retired quarantine, loopback helpers) with enforcement gaps: the tsc baseline neutralizes strictness, several public mutating routes skip the loopback guard, npm ci is un-runnable, and the RSS leak is mitigated-not-fixed. No live secrets committed; dev DB passwords baked into provisioning.

---

END OF AUDIT EVIDENCE. Plan: papercusp-full-app-audit-2026-06-09 (81 items, 9 phases).

