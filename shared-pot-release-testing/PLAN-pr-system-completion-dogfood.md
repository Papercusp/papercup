# PLAN — PR-System Completion + Internal fork→PR Dogfood

**Slug:** `pr-system-completion-dogfood-2026-06-19`
**Author:** su-9140a (lead). **Status:** draft for owner approval (owner answered the 3 design Qs 2026-06-19).
**Why:** the OUTBOUND fork→PR is autonomous + solid, but the INBOUND side (review→merge→track)
is barely wired — and `papercusp-dogfood-phase7-pr-lifecycle` **falsely marks the key piece
(P-042 poll daemon) "shipped"** (it was never built; `completion-ref-writer.ts` admits it, EI-479).
So today a fork→PR is reviewed/merged only when a **human clicks a button** in the operator UI,
the **WI↔PR link table has no producer**, agents share **one host identity**, and the team has
**never dogfooded the fork→PR member path** — the path external users hit is the least exercised.
This plan completes the inbound side AND stands papercup up as its own forked member to dogfood it.

## Owner decisions (answered) — the design spine
- **(a) Review: owner-configurable, BOTH human + agent.** The agent-reviewer reads a PR and emits
  a **report (summary + recommendation: approve / request-changes / reject + rationale + risk)**.
  The owner sets, per-pot: **manual** (human reads the report → approves) or **auto** (the agent's
  recommendation auto-flows into approve+merge). Builds on the EXISTING `pr_reviewer_settings`
  (`auto_review`/`auto_merge` already exist) + `decideAutoReview`/`tryAutoApprove`/`tryAutoMerge`.
- **(b) WI↔PR tracking: BUILD the producer.** `harness_feature_prs` exists but has no writer; wire it
  so the pot tracks `WI/feature → PR-url → state → merged`. Load-bearing: without it the report GUI
  can't link a PR to its WI, auto-merge can't stamp completion reliably, and the planes drift.
- **(c) Identity: PER-OPERATOR (human), made explicit.** Agents contribute AS the authenticated
  human operator (the `gh` user) — NOT per-agent (impractical + lets a spammer multiply rate buckets)
  and NOT a generic host token (no accountability). One human = one identity = one rate bucket (correct
  anti-spam granularity). Agent-authored PRs carry a `Co-authored-by: papercusp-cup` trailer for
  transparency; the *account* stays the human. Multi-user pot → each human's agents = that human.

## What's built vs missing (the inbound gap map)
| Piece | State |
|---|---|
| `decideAutoReview` / `tryAutoApprove` / `tryAutoMerge` (Octokit, checks-green gate) | ✅ built + unit-tested |
| `pr_reviewer_settings` (`auto_review`/`auto_merge`/`merge_method`, default off) | ✅ built |
| **Poll daemon (notice PR → trigger review)** — P-042 | ❌ NEVER built (falsely "shipped"; EI-479) |
| **Agent-reviewer + report** (summary/recommendation) | ❌ not built |
| **Report GUI + manual/auto per-pot toggle** | ◐ PrsTab/PrRow exist (human button only); no report, no toggle |
| **WI↔PR producer** (`harness_feature_prs` writer) | ❌ table exists, no producer (vaporware) |
| **Per-operator identity explicit + agent trailer** | ◐ single host token; not explicit, no trailer |
| **Confirm-gate consistency** (autonomous open has none; `platform:contribute` is human-root) | ◐ inconsistent |
| **Fork cleanup** after merge/close | ❌ none — stale accumulation |
| **Contributor revocation** (`revoked_pubkeys`) | ❌ silent no-op (designed, unimpl) |

## Architecture
```
 new/updated PR on a shared harness
        │
   [PR-1] POLL DAEMON  ── writes ──▶ harness_feature_prs (WI→PR→state)   [PR-4 producer]
        │  triggers
        ▼
   [PR-2] AGENT-REVIEWER ──▶ review report {summary, recommendation, rationale, risk}
        │                              │ stored
        │  recommendation              ▼
        ▼                       [PR-3] REPORT GUI (owner, claimed-gated)
   decideAutoReview(settings) ◀── owner per-pot mode: MANUAL ─▶ human reads report + Approve
        │  (auto mode)                                  AUTO  ─▶ recommendation auto-applies
        ▼
   tryAutoApprove + tryAutoMerge (checks-green + trusted-author + owner-policy)  [EXISTS]
        │ on merge
        ▼
   stampCompletionRefOnMerge → feature status='shipped' + harness_feature_prs.merged
   identity = the authenticated HUMAN operator (gh token) + agent trailer  [PR-4]
```

## Dependencies / connections
- **Owner-enforcement layer** (`PLAN-owner-enforcement-layer.md`): the per-pot review policy
  (required-checks, who-can-contribute, auto-merge on/off) IS the EN-4 **P-CONTRIB** lever; the
  per-operator rate-limit keys on `github_user_id` = EN-2 **P-RATE**; contributor revocation = EN-3.
  These two plans share the authority gate (claimed owner) + the enforcement seam.
- **Brief AH** (code-plane testing) tests this end-to-end; **the internal dogfood (PR-5) is the live
  validation**. The A-003 (a′) / re-key work is independent (content plane).

## Phases → briefs (parallelizable)
- **PR-1 — Poll daemon + reviewer trigger** (the missing spine): notice new/updated PRs on shared
  harnesses, trigger PR-2, evaluate `decideAutoReview`, drive auto-approve/merge in auto mode. Build
  the real `pr-host/poll-daemon.ts` (un-vaporware P-042) + fix the falsely-shipped plan record.
- **PR-2 — Agent-reviewer + report**: the Mug/Cup review task that reads the PR diff + its WI
  context → emits the structured report (summary, recommendation, rationale, risk). Stored; the
  recommendation feeds the gate.
- **PR-3 — Report GUI + manual/auto modes**: extend PrsTab/PrRow to render the agent report + a
  manual-Approve action + a per-pot **auto-mode toggle** (gated on claimed-owner authority).
- **PR-4 — WI↔PR producer + per-operator identity**: wire `harness_feature_prs` (WI→PR→state at
  open; updates at review/merge); make identity explicitly the operator + add the agent trailer;
  reconcile the confirm-gate (autonomous open passes the owner policy).
- **PR-5 — Internal fork→PR dogfood**: stand papercup up as its own forked self-pot (platform mode /
  `papercusp-platform`), route REAL contribution through fork→PR (a Cup → fork → PR → agent-review →
  owner-mode → merge to canonical), validate the full loop; implement fork cleanup + the
  `revoked_pubkeys` no-op fix surfaced en route.

## Decisions for the owner (in this plan)
- **D-1:** default review mode for a NEW public pot — manual or auto? (Recommend **manual-by-default**;
  owner opts into auto once they trust the reviewer.)
- **D-2:** is checks-green a HARD gate even in manual mode (can a human override red checks)? (Recommend
  hard gate; owner-admin can override with an audit reason.)
- **D-3:** fork retention — delete-on-merge, or keep (the contributor's fork)? (Recommend keep + a GC
  for abandoned forks; deleting another account's fork is intrusive.)

## Test posture
Teeth-verified; the S0 properties: (a) no auto-merge without checks-green + trusted-author + owner-mode=auto;
(b) the agent never self-approves; (c) per-operator identity is correct + attributable; (d) the dogfood
loop actually round-trips (Cup code → canonical main via PR). Brief AH + PR-5's live loop are the witnesses.
