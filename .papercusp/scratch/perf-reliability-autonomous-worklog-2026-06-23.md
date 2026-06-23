# Perf + reliability improvements — autonomous loop work-log (su-7f3e0376)

> Owner directive: re-arm the 2m papercusp loop and keep picking up performance + reliability
> improvements, working on them completely autonomously. Self-paced via ScheduleWakeup (papercusp
> loop:arm unreachable). papercusp MCP (coord/locks/plans/work_items) UNREACHABLE all session.

## HARD CONSTRAINT — no coordination layer this session
locks:*/coord:* are unreachable, so I CANNOT safely coordinate edits to hot, fleet-shared,
actively-churned SOURCE (e.g. the inference-gateway runtime — many live EIs + auto-implement
workers). Editing those uncoordinated risks colliding with concurrent fleet fixers. So this loop
favors **LOW-COLLISION** work:
- ✅ NEW test files (characterization/regression) — collision-free; pin reliability-critical PURE
  logic so regressions are caught (a real reliability improvement).
- ✅ Contained fixes in demonstrably-STABLE (non-churned, check `git log`/mtime) code.
- ✅ Extending the perf-anti-pattern GUARD (perf-anti-patterns.test.ts) to cover un-guarded
  documented anti-patterns (A5/A8/A15/A17/A18/A19).
- ⛔ AVOID editing hot/churned shared runtime (gateway.ts etc.) uncoordinated. The flaky
  gateway.test.ts timing assertions (EI-2904) may guard REAL 429 slowness (WI-611 critical: bees
  die on 429) — weakening them could hide a bug; the code fix is high-stakes + hot → not autonomous.

## Target sources (surveyed iter 1)
- `apps/operator-docs/src/content/docs/performance.mdx` — anti-patterns A1–A19. The frontend guard
  `packages/operator-core/lib/perf-anti-patterns.test.ts` (covers A1/A2/A4/A6/A7/A9) is GREEN — no
  new frontend violations. Server-side A5/A8/A15/A17/A18/A19 are NOT guarded (a gap to close).
- `engineer_issues` (PG, 1925 open): most "Test failing repeatedly" issues are STALE (cli-entry 3/3,
  sync-resolver 54/54 pass now — issues never closed). The genuinely-failing ones are gateway
  (off-limits). Many EIs are operational (queen stalls, throttling), not in-repo code fixes.
- Untested PURE reliability-critical helpers (best collision-free source).

## Method (per wake)
Pick ONE contained low-collision target → read it FIRST → thorough DETERMINISTIC tests / contained
fix → green gate (`npx vitest run <file>` + a sibling + `npx tsc --noEmit -p tsconfig.json`, only NEW
errors in touched files; do NOT run *.integration.test.ts; never leave red) → TaskUpdate + work-log row.

## Done
| Iter | Target | Tests/Δ | Notes |
| --- | --- | --- | --- |
| 1 | `inference-gateway/egress-dispatcher.ts` | 13 ✓ | per-account egress routing: egressIsHttpProxy scheme handling, egressCacheKey (non-http collapses to empty), buildEgressDispatcher all branches (absent→{}, non-http→ignoredProxyUrl, http→ProxyAgent, localAddress→Agent, both→proxy-wins) via injectable importUndici |
| 2 | `inference-gateway/egress-probe.ts` | 12 ✓ | clean-IP gate: subnet24 /24 extraction; probeEgress (hasEgress, exitIp+reputation+asn, fetch-throw→error, socks→ignoredProxyUrl, lookup-miss→null); testEgressForAccount (unknown→null, compareOthers=false, ASN collision, /24 subnet collision, distinct, flagged→clean:false) — all via injected ProbeDeps |

**Loop tally: 25 tests across 2 modules. Gateway pure-untested helpers (egress-dispatcher, egress-probe) now done; the rest of the gateway dir has unit tests or is hot runtime.**

## Next: broaden beyond the gateway dir
Find untested reliability-critical PURE helpers elsewhere in operator-core (backoff/retry/dedup/cursor/circuit/AIMD math, idempotency, watermark/seq math) OR extend perf-anti-patterns.test.ts for a server-side anti-pattern (A18/A19). Verify uncovered + low-churn + genuinely pure before committing.

## Candidate backlog (verify uncovered + collision-safe per wake)
- Pure untested gateway helpers: `egress-probe.ts` (215, NONE — check purity), `index.ts` (shim, skip).
- Extend `perf-anti-patterns.test.ts` to detect a server-side anti-pattern (A19 /proc-walk, A18 module-cache-without-globalThis) + fix any STABLE-file hit.
- Untested reliability-critical pure helpers elsewhere in operator-core (backoff/retry/dedup/cursor/circuit math).
