# `topics:subscribe` — retired 2026-08-09

Plan `coordination-spec-adoption-2026-08-03`, **D-102** (which corrects D-100).
Preserved-not-active: not built, not tested, not registered, not to be extended.
`lint:no-retired` fails any live import of this directory.

## What was retired

| file | was |
|---|---|
| `topics-subscribe.ts` | `packages/operator-core/lib/agent-tools/coordination/tools/topics-subscribe.ts` |
| `topics-subscribe.test.ts` | same directory |

The **tool door only**. Nothing in the subscription substrate was removed:
`subscribeTopic()` (`coordination/topics.ts`), the `coord_entity_subscriptions`
rows, the delivery modes (`full`/`digest`/`mention`), TTLs, and every reader are
untouched and live.

## Why — and why this one and not the other five

`topics:subscribe` was the named sugar for one cell of the unified subscription
primitive (`unify-watch-primitive-2026-06-06`, D-007):

```
topics:subscribe { topic, mode }  ==  watch:create { pattern: topic, targetKind: 'topic', wake: false, mode }
```

The base primitive **`watch:create` stays**, so the capability is fully intact —
only the duplicate door is gone. Measured over 30 days: **0 calls**, while being
prescribed *by name* in seven role prompts (worker, reviewer, validator,
architect, scoper, debugger, plus both su playbooks and the base su blueprint).
That is this plan's D-001 finding on a single verb: prompt text is not an
enforcement tier.

D-100 originally listed six retirements. A code audit before cutting falsified
five of them, each because a zero call-count was read as an absent function
without checking who else held the door open (D-102):

- **`coord:catch-up`** — the `coord:orient` fold covers `@fleet:` only, i.e.
  451 of ~28,700 audience-addressed messages in 30d. It remains the sole
  `coord:read`-tier door to the other 98.4%.
- **`watch:create`** — the *base*, not the duplicate. `state:subscribe` imports
  its handler directly, and it is the only door to the standing (`once:false`)
  and inject (`wake:false`) cells.
- **`coord:message-agent`** — a live human affordance
  (`POST /api/admin/coord/message-agent` → `MessageOwnerThread.tsx`), invisible
  to an agent-call denominator.
- **`coord:couple`** — declared edges union with derived ones in the live
  `presence.ts`; its sibling `coord:decouple` has no substitute.
- **`coord:handoff`** — deferred, not kept: it shares the 30-day re-measure
  armed for `coord:dispatch`, because deleting both doors to work-handoff before
  that measurement destroys the evidence needed to judge it.

## Migration for callers

```diff
- topics:subscribe { topic: 'coord-dx', mode: 'digest', ttl_sec: 3600 }
+ watch:create { pattern: 'coord-dx', targetKind: 'topic', wake: false, mode: 'digest', ttl_sec: 3600 }
```

`topics:unsubscribe` is unchanged and still stops a subscription however it was
registered. `topics:list` still reports your active subscriptions, including
those written by the hysteresis machine and `adjacency-cross-feed`.

Bulk had no direct equivalent: the retired tool accepted `topics:[…]` /
`items:[…]`. Register per topic instead — the rows are identical either way.

## To restore

1. `mv _retired/topics-subscribe/topics-subscribe.ts packages/operator-core/lib/agent-tools/coordination/tools/`
   (and the `.test.ts` beside it).
2. Re-add `import './coordination/tools/topics-subscribe';` to
   `packages/operator-core/lib/agent-tools/index.ts` in the topics block.
3. Restore the `topics-handlers.test.ts` block (`topics:subscribe handler
   projection (bulk envelope)`) — its `subscribeTopic` mock and `sub()` helper
   are still in that file, used by the `topics:list` tests.
4. Revert the `watch:create { targetKind:'topic' }` re-pointing in
   `topics-list.ts`, `topics-create.ts`, `topics-unsubscribe.ts`,
   `conversations-join.ts`, `events/await.ts`, `events/sugar.ts`,
   `events/watch.ts`, `state/subscribe.ts`, `routing-gate-hints.ts`, and the
   nine prompt files listed in `scripts/retirement-surfaces/topics-subscribe-2026-08-09.json`.
5. `npm run lint:tool-prompts`.

Restoring is only correct with evidence the base primitive's ergonomics are the
blocker — not on the grounds that a name reads more nicely. The retirement's
whole claim is that a nicer name with no delivery tier buys nothing.
