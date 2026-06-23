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
| 4 | `card-link.ts` | 7 ✓ | unblockLinkedCard: unlinked/non-string correlationId → no-op (resolver not called); submit picks:[choice]; expectedWorkspaceId conditional; res.ok passthrough; throw swallowed |
| 5 | `log.ts` (coordLog seam) | 7 ✓ | configureCoordLog/resetCoordLog swap; coordWorkspaceId (impl.workspaceId ?? DEFAULT); coordHasPgFastPath (typeof getSql); coordSql returns backend handle; coordLog delegates every method; reset restores PG fast-path |

| 6 | `audience-host.ts` (pure surface) | 5 ✓ | audienceMode() env kill-switch ('broadcast' exact else 'scoped'); listActivePresence drops stale/revoked + maps to {ownerId,planSlug,files} |

**FINAL TALLY: 53 tests across 6 modules (feed 15, topics-core 10, plan-events 9, card-link 7, log 7, audience-host 5).**

## LOOP CONCLUDED 2026-06-23 — pure/seamable backlog EXHAUSTED
Final sweep confirms every remaining uncovered coordination module is one of:
- **PG-only (no mockable seam → integration-test territory, SKIP):** conversations-store (318),
  presence-snapshot (323), slot-parked-store (217), presence (126), topics (94), message-log-gc (93),
  escalation-log-gc (81), notify-gc (30), subscription-store (31).
- **Re-export shim / boot wiring (no logic):** envelope.ts (16), wire-agent-question-gate.ts (25).
- **Already covered under `__tests__/` or referenced by a test:** agent-question-gate,
  agent-question-decider-gate, conversations-core (+3 integration), watermarks, promote, handoffs,
  ask-knowledge-tier.
No genuinely-uncovered pure/seamable module with real logic remains. Loop stopped (no further wakes).

## Backlog status (thinning — approaching exhaustion)
Genuinely-uncovered remaining: `audience-host.ts` (mostly PG wiring; only `audienceMode()` env-pure + `listActivePresence` filter testable), `log.ts` (small pure `coordScopeWorkspace`/`coordWorkspaceId`), `agent-question-gate.ts` (207, check purity), `agent-question-decider-gate.ts` (74). PG-only (SKIP): `message-log-gc.ts`, `escalation-log-gc.ts`, `notify-gc.ts` (getOrgPg().sql, no seam). Covered under `__tests__/`: watermarks, promote, conversations-core/store.

## Skipped + caveats
- `presence.ts` — SKIPPED: PG host adapter, module-scoped PgPresenceStore (no injectable seam); only brittle-mock logic.
- `conversations-core.ts` — ALREADY COVERED (`__tests__/conversations-core.test.ts` + 3 integration tests). Integration-flavored (no in-memory ConversationStoreLike double).
- ⚠ **CAVEAT:** the colocated `<name>.test.ts` scan OVER-REPORTS gaps — some modules are tested under `__tests__/<name>.test.ts`. Before committing a module, check BOTH `ls <name>.test.ts __tests__/<name>.test.ts` AND `grep -rl <exportName> **/*.test.ts`.

## Candidate backlog (verify purity per-wake before committing)
`presence.ts` (126), `log.ts` (pure surface: coordScopeWorkspace/coordWorkspaceId), `conversations-core.ts` (510),
`messages.ts` (307), `watermarks.ts` (seam-injected store), `slot-parked-store.ts` (sql-injected — only if assertions on
query shape are worthwhile), `escalation-log-gc.ts`, `message-log-gc.ts`, `notify-gc.ts`, `card-link.ts`, `audience-host.ts`,
`agent-question-gate.ts`. When the pure/seamable set is exhausted → stop the loop + report.
