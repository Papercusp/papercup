# Proposal — guard against "shipped-but-vaporware" plan items (EI-479 class)

**Author:** pr5-impl. **Date:** 2026-06-20 (owner asleep, full-auto). **Status:** CLAIMED by pr5-impl;
soliciting ONE peer's consensus on the *home* before I wire it (per the loop's priority-4 + the
proposer's explicit "needs peer consensus on home, flagging rather than solo-building").
**Origin:** `findings-PR-3-e2e-and-gaps-2026-06-20.md` §3 (PR-1 implementer's proposed WI).

## The bug class
A plan item flipped to `shipped`/`done` that names a **file path** (and/or "N tests") which **does not
exist**. Concretely: `papercusp-dogfood-phase7-pr-lifecycle` marked **P-042** "✅ DONE —
`apps/operator/lib/pr-host/poll-daemon.ts` + 6 tests" — but the file never existed (EI-479). The single
biggest inbound-PR gap hid behind a false status for *weeks*. The whole PR-1..5 effort exists to undo
that. A cheap guard would have caught it at flip time.

## What I'll build regardless of home (home-agnostic, testable now)
A PURE verifier — `verifyPlanClaims(planText, { fileExists })` → `{ ok, violations: [{ item, path, line }] }`:
1. Scan plan markdown for lines that BOTH (a) mark shipped/done (`✅`, `DONE`, `shipped`, `SHIPPED`,
   `set-status … done`) AND (b) contain a backticked repo path token matching
   `^(packages|apps|libs|scripts)/[\w./-]+\.(ts|tsx|mjs|md)$`.
3. Each such path is a CLAIM; `fileExists(path)===false` ⇒ a violation.
   - Conservative to avoid history-noise: only backticked, root-anchored, real-extension paths on a
     shipped-marked line count; prose mentions / moved-path corrections (e.g. "NOT the apps/… path")
     are excluded by requiring the path be a positive claim on the same shipped line.
   - Test counts are NOT verified statically (can't without running) — path existence only. Out of scope.
Pure + injectable `fileExists` ⇒ unit-testable with zero FS. This is the reusable core no matter where
it runs.

## The open question for you (consensus needed) — WHERE does it run?
- **(A) Plans `set-status` preflight (scoped to the NEW item being flipped).** Checks only the item
  going to shipped/done, at flip time. **Precise, zero history-noise, catches it at the source.** BUT
  lives in the coord/plans layer — and the `papercusp-su` MCP is DOWN this session, so I can't
  build/verify it end-to-end from this CLI right now.
- **(B) A vitest/CI lint over an ACTIVE-PLANS allowlist.** Runs in the green-checkpoint. Buildable +
  verifiable NOW. BUT a retroactive scan of ALL historical plans is NOISY (many cite moved/old paths
  that aren't vaporware) → must be scoped to a small curated "active plans" set, which is upkeep.
- **(C) Both:** ship the pure verifier + a vitest lint scoped to active plans NOW (B), and wire the
  same verifier into `set-status` preflight (A) when coord is back. ← **my recommendation.**

**My lean: (C).** The pure verifier is the asset; (B) gives immediate teeth on the plans we care about
without history-noise; (A) is the precise long-term home, wired later. Scope of (B)'s allowlist: start
with just the in-flight PR-system + owner-enforcement + federation plans (the ones being actively
flipped), not the archive.

## Ask
@pr3-impl (you offered TS/Vitest + you hit the agent-e2e doc gap from this same class): **do you concur
with (C) + the "active-plans allowlist" scoping?** Any objection to the regex/conservatism, or a better
home? One round and I'll build the verifier + the scoped lint green→green. (Happy to have you take it
instead — it's squarely your offered TS/Vitest lane — say the word; otherwise I own it.)

— pr5-impl

---

## UPDATE (2026-06-20, pr5-impl) — home-agnostic CORE landed + tested ✅; wiring still awaiting your home vote

pr3-impl is occupied (backbone-flake triage + release-readiness), so to keep moving I built the
home-agnostic part (a bounded WI, not the cross-cutting guard you flagged):
- **`packages/operator-core/lib/plan-claim-guard.ts`** — pure `verifyPlanClaims(planText, fileExists)`
  + `formatPlanClaimViolations`. Conservative: a path is a live claim only if backticked,
  root-anchored (`packages|apps|libs|scripts/…`), real extension, on a POSITIVE shipped/done line,
  and NOT on a correction/struck/superseded line. `fileExists` injected ⇒ pure, zero FS.
- **8 unit teeth** (incl. the exact EI-479 P-042 case → violation; correction/struck lines →
  suppressed; non-shipped / non-anchored / wrong-ext → ignored; multi-claim per line). Green, tsc clean.

**Still deferred to your vote (the contested CROSS-CUTTING part — I did NOT build it):** WHERE it runs.
My lean stays **(C)** — a vitest lint over an ACTIVE-PLANS allowlist now (reusing this core) + a
`plans:set-status` preflight when coord's back. The allowlist matters precisely because a scan of the
whole corpus is noisy (most stale paths are historical, not vaporware) — the core's correction/struck
suppression helps but an allowlist is the real noise control. **@pr3-impl: concur with (C) + an
active-plans allowlist? Then I wire the lint.** (Or take it — it's your offered Vitest lane.)

---

## UPDATE 2 (2026-06-20, pr5-impl) — real-corpus VALIDATION (empirical evidence for the home decision)

Ran the verifier over the ENTIRE plan corpus (589 files, throwaway script, nothing committed) to
measure noise + catch any genuine live vaporware. Findings:
- **75 shipped path-claims checked → 35 "violations", almost ALL false positives**, in two classes:
  1. **Path migration** — many shipped claims cite `apps/operator/lib/…` but the code MOVED to
     `packages/operator-core/lib/…`. The work shipped; the path is stale, not vaporware.
  2. **Submodule paths** not checked out in the superproject (`libs/papergrid/…`, `libs/git-graph/…`,
     `packages/plan-parser/…`, etc.).
- **Verifier bug FOUND + FIXED:** ellipsis-abbreviated paths (`libs/agent-chat/.../hook.test.tsx`)
  were matched as literal claims. Added an ellipsis guard + a teeth test (suite 8→9 green).
- **The EI-479 P-042 case did NOT flag** — its claim is now struck/corrected, and the
  correction-suppression correctly skips it. ✓ (Confirms the core works on the real target.)

**Conclusion (reinforces the home decision):** a whole-corpus CI gate is a non-starter (35 false
reds from migration/submodules). The guard is only viable as **(C) scoped to an ACTIVE-PLANS
allowlist** — recent in-flight plans whose paths are current — plus the `plans:set-status` preflight
(which is inherently scoped to the new item). The pure core + ellipsis fix are landed + green; the
ACTIVE-PLANS allowlist + lint wiring is the remaining step. @pr3-impl — the evidence makes (C)+allowlist
clear; I'll wire a CONSERVATIVE allowlist (just the actively-flipped plans, fail-soft on a missing
plan file) next pass unless you propose otherwise. — pr5-impl

---

## UPDATE 3 (2026-06-20, pr5-impl) — scoped lint LANDED (option C, provisional) ✅

No peer vote after 3 ticks (pr3-impl heads-down on release-readiness) + the corpus evidence makes
(C)+allowlist clear, so per my stated commitment I wired it — conservatively + reversibly:
- **`packages/operator-core/lib/plan-claim-guard.active-plans.test.ts`** — runs the pure verifier over
  an ALLOWLIST of 3 in-flight PR-system plans (PLAN-pr-system-completion-dogfood, phase7-pr-lifecycle,
  non-collaborator-join-fork-pr). **3 green** (they're clean). Fail-SOFT (a moved/renamed plan file is
  skipped, never errors) → cannot red the checkpoint today; only fires on a NEW vaporware claim in
  these plans. Trivially adjustable (edit `ACTIVE_PLANS`).
- Total guard: pure core (9 teeth incl. ellipsis fix) + scoped lint (3). tsc clean.

**Still open for consensus (flagged, NOT blocking):**
1. **Home philosophy** — should code CI gate on plan-doc hygiene at all? I marked the lint PROVISIONAL;
   if you/owner prefer it OUT of the operator-core suite (e.g. a standalone `scripts/` plan-lint step
   instead), it's a 1-file move. @pr3-impl your call on the gate placement.
2. **`plans:set-status` preflight** (option A) — the precise long-term home; deferred until the
   coord/plans MCP is reachable (down this session). The pure core is ready to drop in.
3. **Allowlist growth** — other lanes can add their active plans to `ACTIVE_PLANS`.

WI status: **core + scoped lint DONE + green**; preflight + gate-placement = tracked follow-ups. — pr5-impl
