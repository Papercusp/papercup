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

| 3 | `authority/file-lock-routing.ts` | 7 ✓ | file-claim lock routing: resolver seams (configure/get/default domain+hive, _testing); routeFileLockOp D-009 scope guard (unmanaged→local), hot-path guard (no remote peers→local via injected fetchPresenceRows:[]), harness-vs-hive scope selection (spy which presence fetch is consulted). Module-global resolvers + remote-peers cache reset between tests. |

| 4 | `external-bench/grader/swe-bench-pro.ts` | 9 ✓ | parseSweBenchProReport (PURE: resolved bool passthrough, missing/non-boolean→graderError); makeSweBenchProGrader.grade (injected exec+fs: no-diff→[], predictions.json content, eval-arg assembly + --use_local_docker toggle + pythonBin/numWorkers/dockerhub overrides, read-error→batchError w/ exit code, scratch rm in finally) |

**Loop tally: 41 tests across 4 modules.**
⚠ Verification caveat reaffirmed: `graduation/evidence.ts` was a candidate but evidenceItemsFromIssues is ALREADY tested in `graduation/scan.test.ts` — ALWAYS `grep -rl <export> **/*.test.ts` (incl. sibling test files, not just colocated) before committing.

## Best target pattern: untested modules exporting a `*Deps` injectable-deps interface
`grep -rlE "export interface [A-Za-z]+Deps" packages/operator-core/lib --include=*.ts | <filter to no colocated test>`.
Next candidates (verify uncovered + low-churn + filter I/O): `graduation/evidence.ts` (evidenceItemsFromIssues PURE),
`cross-hive-ask-send.ts` (SendCrossHiveAskDeps), `external-bench/grader/swe-bench-pro.ts` (SweBenchProGraderDeps),
`sync/hyperbee/hive-epoch-boot-deps.ts` (HiveRekeyBootDeps), `harness-seed.ts` (SeedHarnessDeps). SKIP I/O-coupled
(run-launcher, hive-eval/live-ops, bee-transcript-cap-action) + lock-guard (no injection seam, 6 hard imports).
Also still open: extend perf-anti-patterns.test.ts for a server-side anti-pattern (A18/A19).

## Candidate backlog (verify uncovered + collision-safe per wake)
- Pure untested gateway helpers: `egress-probe.ts` (215, NONE — check purity), `index.ts` (shim, skip).
- Extend `perf-anti-patterns.test.ts` to detect a server-side anti-pattern (A19 /proc-walk, A18 module-cache-without-globalThis) + fix any STABLE-file hit.
- Untested reliability-critical pure helpers elsewhere in operator-core (backoff/retry/dedup/cursor/circuit math).
