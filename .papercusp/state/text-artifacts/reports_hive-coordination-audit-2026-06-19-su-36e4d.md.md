---
rel_path: "reports/hive-coordination-audit-2026-06-19-su-36e4d.md"
updated_at: 1781857496755
_body: "content"
---

# Hive coordination audit — queen / overwatch / bees / scout / watchdog
**Author:** su-36e4d39f · **Date:** 2026-06-19 (overnight, owner asleep, full authority)
**Status:** Investigation + 2 fixes shipped. Live E2E DEFERRED — another agent owns the papercup→papercusp migration; live testing waits for that to complete.

## TL;DR
The coordination system is **fundamentally healthy and richly instrumented**. Detection (watchdog), triage (improvements pipeline), the Queen's placement (parallel batched spawns, difficulty-tiered models), and self-healing are all working. The weak spots are all **downstream of infra instability** (inference-gateway egress + host restarts), plus a known **rebrand-migration gap** (member-less hive) and an **escalation-lifecycle GC gap** I fixed.

## How the system is supposed to work (verified from docs + code)
- **Queen** = a privileged `kind:'hive'` blueprint, **fresh per wake** (no transcript; durable state in work-items/placements/decision-ledger). Wakes on a time schedule, event subscriptions (`work_items:create`, `plans:start`, `coord:escalate`), watchdog fallback, or manual. Reads `hive:survey` (member-scoped plan + frontier ranking), places `bee`s by judgment via `fleet:spawn`/`fleet:place_batch`.
- **Placement watchdog** (`lib/hive/placement-watchdog.ts`) = completion guarantee: re-place dead/stalled bees (P-020), curse-breaker after N fails (P-021, latches per EI-865), stranded-blocker escalation (P-022), edge-resolution wakes (P-032).
- **Scout** (`lib/scout/`) = prompt-free generative ideation: corpus digest → divergent lenses → adversarial critics → recombine → route (plan draft / gym / improvements). Queen-gated. Singleton loop fires ~every 27 min.
- **Overwatch** = read-mostly health watcher with its own dead-man's-switch; routes health signals to the owner queue.
- **Watchdog/improvements** = deterministic tool-error classifier (`structural`/`transient`/`rate-limit`/`caller`), dedup by `<tool>:<class>`, auto-implement lane for `kind=bug` non-protected items; infra→human.
- **Git-sync** = per-member routine, commit→fetch→merge→push, origin-serialized multi-pusher; merge-resolver on conflict.

## The 13 questions — evidence + verdict

**1. Full flow observation→scout→queen→queue→bee→code→git-sync.** Architecturally sound and exercised historically (decision ledger shows real Queen→bee placements landing features; canary F-CANARY passes cleanly). NOT live-verifiable right now: papercusp hive is member-less (post-rebrand) so the frontier is empty, and inference-gateway egress was flapping. → **Defer live end-to-end run to post-migration** (the user's instruction).

**2. Is Scout producing good ideas/plans?** Scout singleton loop is firing (last 08:03, ~27-min cadence). Has an empty-digest $0 guard (EI-303) so a quiet hive doesn't burn budget. Per-harness `scout-cycle` on papercup last fired 2026-06-14 (5d ago) — the SINGLETON loop is the live one. Idea-quality grading exists (`scout:grade-idea` → lens weighting). VERDICT: mechanism healthy; **idea-quality sampling deferred** (needs reading routed drafts live). Recommend a periodic `scout:grade-idea` discipline so lens weights actually learn.

**3/4. Queen work-item & plan selection.** GOOD. `hive:survey` ranks by plan-importance(4) + escalation-pressure(5) + staleness(3) + blocking-impact(1) — sensible weights. Decision ledger shows the Queen acts ("disposition: act") on real features, attributes spawns to the right parent wake, and records `why`.

**5. Parallelization / grouping / topic-subscription.** Queen ALREADY parallelizes: one wake spawned 7 bees in ~18s across distinct papercup features (F-FIX-031..037 + WI-217/220); offsite-demo spawned 4 in ~2s. Difficulty-tiered models (opus:xhigh "deep" for hard items, sonnet "quick" for routine). `fleet:place_batch` + `work_items:co_locate` exist. **OPPORTUNITY (the user's idea is valid):** there's no evidence the Queen auto-subscribes a spawned *group* to a shared topic for cross-bee coordination — worth adding to the Queen brief + possibly auto-subscribing co_located batches to a per-wave topic. Filed as a recommendation, not yet a fix (touches the Queen persona which the migration may rewrite).

**6. Are bees doing good work?** MIXED-GOOD. 511 completions vs 58 reverts (~10%). Churn hotspots: F-015 reverted 13×, F-AUTOFIT-001 7×, several F-FIX 3–5× (validating→failing) — either hard features or under-specced briefs. Canary + research tasks pass cleanly.

**7. Bee observations.** Bees use `work_items:observe`/`checkpoint`; the watchdog reads them. Not separately sampled this pass.

**8. Overwatch observations.** Overwatch ran 162×/$82 on papercup-hive (active). Produces health/saturation/queue signals. Quality not separately sampled (deferred).

**9. Watchdog deterministic catching.** STRONG. Last 15 ticks: captured 10, declined 7 dups, prefiltered 178 known-open + 106 stale-resolved, dropped 150 benchmark-noise, ZERO self-escalations. Tool-error classes bucketed correctly. The change-feed shows a steady stream of watchdog-caught issues getting resolved (service-down, plans:list scoping, memory-tool errors, fleet-saturation). It catches infra + tool + stalled-feature signals deterministically.

**10. Constructive inter-agent communication.** GOOD. Queen triage comments are substantive; su-6620a's EI-1578 investigation was careful (declined to hack an owner-gated rebrand); su-91881 posted an honest, detailed completion message. handoffs/acks present.

**11. Excess chatter (design-removable).** YES — the dominant problem. Coord stream = 40,078 rows: **escalation 13,511, message 15,685, plan_event 8,607**. The live stream is saturated by `system:attention-reconcile` auto-resolving the ~13k stale `hive-placement-watchdog` escalations one-every-few-seconds. ROOT: (a) member-less hive → workspace-wide survey swept benchmark debris → curse-storm (EI-1525); (b) cursed escalations never GC'd when items go terminal with no live bee (EI-1524/1518). **FIXED (b)** below; **(a) resolves when the migration wires membership.**

**12. Implemented coordination types agents aren't using.** `work_items:co_locate`, `fleet:place_batch`, `plan_items:join_group` exist but appear under-used for *group* coordination. Topic auto-subscription of bee waves is available but not wired into placement. (Recommendation, not yet actioned.)

**13. Available tools agents should use but don't.** Found + FIXED the inverse: a NEEDED tool was **missing** — `hive:add-member` (the `addHarnessToHive` producer was never exposed), which is exactly what blocked the migration. Shipped it (EI-1582).

## Issues discovered (prioritized)
- **P0 (infra, owner/peer-owned):** inference-gateway :8788 egress flapping → gym-cycle circuit-open (46 consecutive errors) + **auto-implement dispatch 148/191 orphaned (78%)** via host-restart-mid-dispatch. Already captured (EI-1528/1530 + watchdog-embed-resilience plan). NOT mine to fix (infra).
- **P1 (rebrand, migration-agent-owned):** papercusp hive member-less → empty frontier + workspace-wide survey curse-storm (EI-1525/1578/1581). Migration agent is wiring this now.
- **P1 (coordination hygiene) — FIXED:** escalation lifecycle GC gap (EI-1524/1518).
- **P2 (capability) — FIXED:** missing `hive:add-member` tool (EI-1582).
- **P2 (open, follow-ups):** aging-detector counts cumulatively not distinct-open (EI-1524 defect #2 — separate curation component); escalation severity design (operational/health escalations share the durable decision queue and need GC rather than being ephemeral).

## Fixes shipped this session (in-tree, tested, pending auto-deploy)
1. **`hive:add-member` tool (EI-1582, resolved).** New `agent-tools/hive/add_member.ts` wrapping the existing `addHarnessToHive` producer; registered in `agent-tools/index.ts` + the MCP allowlist. 5 unit tests. Unblocks the migration + future member-less-hive self-remediation.
2. **Backstop escalation GC (EI-1524/1518, resolved).** New pure decider `evaluateStalePlacementEscalation` + sweep `reconcileStalePlacementEscalations` in `placement-watchdog.ts` (step 4 of `reconcileOneHive`): resolves cursed/stranded advisories whose subject item went terminal/gone even with no live bee re-anchoring it — the root of stale-escalation accumulation. 6 new unit + 4 new real-PG integration tests. **All tests green: 55 unit + 20 integration.**

## Recommendations for the owner
1. After migration: run the deferred live E2E (Queen→bee→git-sync on the papercup frontier) and grade scout ideas + bee output quality with fresh observation.
2. Consider wiring **bee-wave topic auto-subscription** into placement (the user's grouping idea) — co_located batches share a per-wave topic so siblings coordinate without Queen round-trips.
3. Treat **operational/health escalations as ephemeral** (derived live) rather than persisting them to the durable decision queue that then needs GC — this is the structural cure for the chatter in Q11.
4. The infra P0 (gateway egress / host-restart orphans) is the single biggest throughput drag — it defeats the otherwise-healthy auto-implement lane.

