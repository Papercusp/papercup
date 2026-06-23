# coordination-layer test-hardening — autonomous loop work-log (su-7f3e0376)

> Resumes the set-aside `coordination-layer-test-hardening-2026-06-22` loop. Driven via
> ScheduleWakeup (2m) because the papercusp `loop:arm` MCP tool is UNREACHABLE this session
> (the papercusp MCP tools aren't callable — handshakes but empty tool catalog). Plan/work_item
> bookkeeping is therefore deferred to an authorized session; durable state lives HERE + in the
> task list + the committed tests.

## Method (one focused module per wake)
1. Pick the next PURE/seamable module under `packages/operator-core/lib/agent-tools/coordination/`
   that lacks a colocated `*.test.ts`. SKIP modules that only execute live PG with no mockable
   seam (e.g. `*-store.ts` that just run `await sql\`...\``, `presence-snapshot.ts`,
   `conversations-store.ts`). Mockable seams (coordLog via vi.mock, injected stores, InjectSink)
   ARE fine — reuse the real in-memory doubles from `@papercusp/coordination/capabilities`
   (InMemoryTopicStore / InMemoryEntitySubscriptionStore / InMemoryThreadStore).
2. Write thorough DETERMINISTIC unit tests (no Date.now reliance, fixed ISO ts, console-clean).
   Don't test impl-dependent/unreachable edges (e.g. the topics merge cycle-guard — resolve()
   folds cycles so `canonical===from` is effectively unreachable with the in-memory double).
3. Green gate before closing: `npx vitest run <file>` + a sibling + `npx tsc --noEmit -p tsconfig.json`
   (only NEW errors in files you touched count — the suite has pre-existing test-file tsc noise).
   Do NOT run *.integration.test.ts. Never leave red.
4. TaskUpdate + append the row below.

## Done
| Iter | Module | Tests | Notes |
| --- | --- | --- | --- |
| 1 | `feed.ts` (readCoordFeed) | 15 ✓ | union/tag, broadcast, sort+tiebreak, limit clamp 1..500, nextCursor, kind/owner/plan/text/time filters, byKind pre-cap |
| 2 | `topics-core.ts` | 10 ✓ | ensureBuiltinTopics idempotent; createTopicCore notify (creator-excluded, mention dropped, re-create/new_topic no-broadcast); mergeTopicsCore re-point to canonical head + delivery_mode preserved |
| 3 | `plan-events.ts` | 9 ✓ | emitPlanEvent envelope (from/system, to=['*'], before/after/detail !==undefined so null kept); emitPlanEventForCaller best-effort swallow (identity-throw→system, append-throw→no-throw); readPlanEvents filesBack passthrough + filterPlanEvents (drop non-plan_event, planSlugs filter, ts-asc) |

## Skipped + caveats
- `presence.ts` — SKIPPED: PG host adapter, module-scoped PgPresenceStore (no injectable seam); only brittle-mock logic.
- `conversations-core.ts` — ALREADY COVERED (`__tests__/conversations-core.test.ts` + 3 integration tests). Integration-flavored (no in-memory ConversationStoreLike double).
- ⚠ **CAVEAT:** the colocated `<name>.test.ts` scan OVER-REPORTS gaps — some modules are tested under `__tests__/<name>.test.ts`. Before committing a module, check BOTH `ls <name>.test.ts __tests__/<name>.test.ts` AND `grep -rl <exportName> **/*.test.ts`.

## Candidate backlog (verify purity per-wake before committing)
`presence.ts` (126), `log.ts` (pure surface: coordScopeWorkspace/coordWorkspaceId), `conversations-core.ts` (510),
`messages.ts` (307), `watermarks.ts` (seam-injected store), `slot-parked-store.ts` (sql-injected — only if assertions on
query shape are worthwhile), `escalation-log-gc.ts`, `message-log-gc.ts`, `notify-gc.ts`, `card-link.ts`, `audience-host.ts`,
`agent-question-gate.ts`. When the pure/seamable set is exhausted → stop the loop + report.
