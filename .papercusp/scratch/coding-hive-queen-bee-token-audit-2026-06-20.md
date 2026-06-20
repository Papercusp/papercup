# Coding-hive queen/bee token-efficiency audit (2026-06-20)

## Verdict
The queen/bee/scout design is **structurally far leaner than su/continuous sessions** — the big
efficiency levers are already built in (est. ~6–7× cheaper on the work-execution layer). BUT these
are **design-time estimates** (some from a bash-era baseline; the "99.94% cache-hit" is estimated,
not freshly measured). The token tracking (token-tracking-plan briefs) is the real proof —
**validate live, don't trust the estimates.** The user's instinct (switch su → queen/bee to cut
spend) is sound.

## Why it's structurally lean (wins already in place)
- **Role specialization:** Bee persona ~300 tok, Queen ~400 tok vs a full operator ~3,600 tok → ~75% less fixed per-spawn overhead. (blueprints/coding/prompts/{bee,queen}.md)
- **Prompt caching:** byte-stable cacheable preamble (persona + tool defs + shared constants); volatile content appends after → est. ~99.94% cache-hit → a bee's effective cost ~150–200 FRESH tokens/turn, not ~1,500. (orchestrator/src/prompt-build.ts)
- **Model tiers:** Bee=haiku (volume), Queen/Operator=sonnet (low-freq judgment). Correct. (orchestrator/src/role-models.ts)
- **Fresh-spawn-per-task:** bees don't accumulate context (no creep); Queen memory hard-capped ~800 tok. No unbounded transcripts — the opposite of the su-session 82%-cache-read driver.
- **Per-role tool surface:** bee ~20 tools (blueprint-scoped), not the full ~52 catalog; cached.

## Do-now wins (low-risk; QUEUE once su-7fa79's rename window clears — git-sync paused now)
1. **[HIGH · zero-risk] Commit Overwatch's model floor = `sonnet`.** It has **no committed default**
   in `role-models.ts` → may silently run on the expensive default (opus). One line. Overwatch is
   read-only by design, so sonnet is ample. (orchestrator/src/role-models.ts)
2. **[HIGH · verify-first] Explicit "work-available" pre-spawn gate** — skip bee spawns when the
   frontier is empty/stable. Audit says this is likely ALREADY implicit in the claim layer —
   **verify that before building**; if not gated, ~50–150K fresh tokens/24h avoidable on idle days.
   (orchestrator/src/invoke.ts + Queen decision logic)
3. **[MED · zero-risk] Dedupe the "three-role-split boundary (D-001)" doc** — duplicated across
   operator.md / queen.md / overwatch.md → move to a shared guide injected once. + trim the 23.5KB
   Overwatch persona (the "don't edit code" clause is already enforced by the capability envelope).
4. **[LOW] Queen-brief re-assembly caching; Scout cadence/model tuning** — incremental, measure first.

## Open questions the tracking will answer (don't guess — measure)
- **The 327K `coord:wake-queue` calls/24h are UNATTRIBUTED** (distinct from Queen wakes; "beacon/
  presence polling?"). **B-TOK-4 (coord-token) will reveal** whether this is cheap polling or
  expensive context-injection — directly the lens you asked for.
- The 99.94% cache-hit + 6–7× claims → validate live via the Tokens subtab (B-TOK-1).
- Haiku-bee bash-fallback (EI-286 recurrence) → monitor per-spawn.

## Bottom line
Switching su → queen/bee is the right token bet; the design is already lean. Remaining upside is
~15–35% incremental, mostly the 3 do-now wins. The tracking converts these estimates into measured
fact and cracks the coord-poll mystery.
