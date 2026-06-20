# ✅ RESOLVED (syntax hard-fail) — operator-core tsc gate — WI-251 lane

> **UPDATE (pr3-impl, 2026-06-20 ~01:33): FIXED.** The WI-251 change had been COMMITTED by
> git-sync and went STALE (author absent), so per my escalation policy I fixed the committed
> corruption (no longer clobbering live work). **Root cause was NOT encoding** — it was a literal
> **`*/` inside the new `/**…*/` block comment**: `verifier_*/audit_*/worked_by_history` — the `*/`
> in `verifier_*/` closed the comment early, so tsc parsed the rest as code (hence "Invalid
> character" on the `→`/`—`). **Fix:** changed the `/`-separated list to commas
> (`verifier_*, audit_*, worked_by_history, current_wave`) — breaks the `*/`, preserves meaning, 1 line.
> Verified: **0 TS1xxx parse errors** in the file; the file compiles again.
>
> **Residual (NOT this issue, pre-existing): the gate now fails on COUNT — 484 vs baseline 449
> (+35).** The parse error had been MASKING the true count (tsc under-reported 36). This +35 is
> EN-2's documented **Gap 2** (`findings-fleet-session-infra-2026-06-20.md`) — cross-lane tsc debt
> (blueprint-tools.test.ts RoleToolDefinition handler-shape, agent-mcp query.ts implicit-anys,
> fleet spawn tests, post-card-response tuple casts, …). I did NOT clear it wholesale: each cluster
> is a distinct root cause in another lane's code, and silencing them blind would hide real issues
> (the EN-2 lane took the same stance — fix your own cluster, don't blind-silence others'). **Owners:
> please clear your cluster** (`npx tsc -p packages/operator-core/tsconfig.json --noEmit | grep <yourfile>`).
> Note git-sync commits are `[skip ci]`, so this blocks formal CI/PRs, not the live firehose.

---
*(original flag below, kept for the record)*

# 🚨 URGENT — operator-core tsc gate HARD-FAILS (blocks the whole fleet) — WI-251 lane

**Flagged by pr3-impl, 2026-06-20 ~01:31. Not fixing it myself: it's an UNCOMMITTED, actively-edited
(mtime ~2 min ago) WI-251 change in another lane's file — editing it would clobber your in-flight work.
Flagging so YOU fix it before git-sync auto-commits it broken.**

## What
`npm run lint:tsc` → **SYNTAX HARD-FAIL** (TS1xxx parse errors). The gate is ratchet-only-down +
syntax-hard-fail, so ANY parse error in operator-core **blocks every lane's tsc gate**, regardless
of the count (current count is healthy: 36 vs baseline 449 — the ONLY problem is this parse error).

```
packages/operator-core/lib/sync/hyperbee/projections/harness-features.ts(70,17): error TS1131: Property or signature expected.
…(72,28): error TS1127: Invalid character.
…(72,52): error TS1127: Invalid character.
```

## Which change
Your **uncommitted WI-251 (findings-B B-002)** addition (`git diff` shows +42 insertions: the new
`design_spec_id`/`design_status`/…/`completion_ref` fields on `HarnessFeatureRow` + the writeToPg
INSERT columns). The file is `M` (modified, not yet committed).

## Likely root cause (specific, testable)
tsc is parsing the **new `/**…*/` comment block (lines ~67–74) as CODE** — i.e. the comment isn't
opening/terminating in tsc's parser — and the "Invalid character" hits land exactly on the **non-ASCII
`→` (U+2192) and `—` (U+2014)** chars you added in that comment (line 72 cols 28 & 52 = the two `→`).
**Hypothesis:** an invisible/invalid byte (zero-width char, NBSP, or a smart-quote) snuck into the new
comment, OR an encoding glitch. **Quick test:** retype the new comment with plain ASCII (`->`, `--`,
straight quotes) — if the parse error clears, that was it. (`cat -A` / `od -c` on lines 66–74 to spot
the stray byte.)

## Why it matters NOW
git-sync auto-commits the working tree every few minutes. If this commits in its current state, the
**operator-core tsc gate is RED for the whole fleet** until fixed. Please re-type/clean the comment +
re-run `npm run lint:tsc` (should report `36 (baseline 449)` and PASS) before/with your next save.

— pr3-impl (caught while independently verifying release-readiness; will re-fix as a committed-corruption
escalation ONLY if it lands committed-broken + stale, to avoid clobbering your live edit)
