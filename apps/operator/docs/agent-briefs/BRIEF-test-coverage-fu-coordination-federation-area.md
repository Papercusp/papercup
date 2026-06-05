# BRIEF — Follow-up: coordination-substrate federation-area coverage

**Parent:** BRIEF-test-coverage-2026-06-04 (lead: su-5cf8c). **Readiness: COORDINATE FIRST** — every target below sits in or beside **su-584a8's** active federation build (`distributed-coordination-shared-harness-2026-06-04`: coord_* tables/migrations, lib/sync/hyperbee projections, presence-reconcile, fanout). The parent brief deliberately **avoided** these to not collide. **Before starting: `coord:presence` for su-584a8; `coord:send` them this brief and ask whether to (a) fold these tests into their build, or (b) own them once their Track A/B settles.** Tests-ship-with-the-build is the default here.

## Why this matters
The coordination-substrate audit rated the **coord-inbox-bus producer the single most important untested seam** — it's the path that turns substrate writes into the human's live inbox, the exact place the originally-shipped `writer_key==='human'` filter bug silently woke on zero real messages, and today **only its pure `isHumanRelevantRow` predicate is tested** while the cursor/peek/coalescing machine that actually decides whether a human sees a message is unguarded. The parent brief covered the federation-INDEPENDENT cores (answer-capture, ask-knowledge-tier dedup, conversations resolve/reparent edges); these federation-area gaps remain.

## Targets (NEW test files; confirm each file isn't mid-rewrite by su-584a8 first)
1. **`coord-inbox-bus.ts` producer end-to-end** (`coord-inbox-bus-producer.integration.test.ts`) — a real `coord_event_log` insert → NOTIFY → `peekHumanRelevant` cursor advance → wake. Assert: a handler registered via `onCoordInbox` fires **exactly once and only** on a human-addressed row; pre-seeded rows below the initial cursor never wake it; the `draining`/`dirty` re-entrancy coalescing; the `handlers.size===0` skip. (Only `isHumanRelevantRow` is tested today.)
2. **`fanout-delivery.ts`** — `buildInjectEnvelope` digest flag on a conversation/issue subscriber (`digest:true` row) and `deliverInjectMany` partial-failure (one subscriber's sink throws → the rest still deliver; `deliverInject` catch→false).
3. **`presence.ts:sweepStalePresence`** — the GC mutator (deletes rows older than `maxAgeMs`, returns count) is untested; only the `deriveLiveness` boundary is. ⚠ su-584a8 does "presence reconcile" — coordinate before touching presence.
4. **`topics-feed.ts:topicFeed`/`tagObject`** — empty-topic `[]`, a conversation-kind item, a dangling tag (backing row deleted) degrading gracefully vs throwing.

## Rules
- Canonical home: Vitest integration (`packages/operator-core/lib/agent-tools/coordination/*.integration.test.ts`) via `@papercusp/test-config`. The shared baseline-schema globalSetup is now wired into operator-core's integration config (`inject('baselineSchemaDsn')` works); read `agent-tools/plans/__tests__/_pg-tool-fixture.ts` for the env-repoint pattern, or `conversations.integration.test.ts` for the capability-store setup.
- Do NOT edit federation projection source. If a target turns out to BE a file su-584a8 is rewriting (coord_* migration, a hyperbee projection, the SSE route wrapper), hand it back to them.
- Verify: `cd packages/operator-core && npx vitest run --config vitest.integration.config.ts <file>`; `cd apps/operator && npm run lint:tests`.
