---
title: Cupboard abuse-surface review (pre-public-launch)
slug: cupboard-abuse-surface-review-2026-06-02
status: active
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# Cupboard abuse-surface review (pre-public-launch)

## Now

**State:** Review complete. Cupboard's moderation surface is **built and deployed** (report → operator-takedown, rate limits, dedup, private-repo rejection, indexer 404-unlist). This memo records the residual abuse vectors and a concrete gate before opening Cupboard **beyond dogfood**. Nothing here blocks dogfood use.

**Next:** before any public (non-papercupai) launch, work the "Pre-public-launch checklist" below. For now, items 1 (channel-2 attribution) + 2 (publisher signal, shipped) are the active hardening.

## Background

Cupboard is a public, papercupai-branded marketplace. The intentional posture (see [[cupboard-provisional-listing-trust-2026-06-02]] D-001/D-002) is: **provisional listings are open + discoverable; trust is reactive (moderation + maintainer-claim displacement), not a preventive publish-time permission gate.** That posture is sound for dogfood. This review asks: *what breaks if the doors open wider*, and what's the minimum to harden first.

Scope: the Cupboard Worker (`apps/operator-public/`) publish/list/report/admin surface + its client proxies. Out of scope: the swarm advisory layer (that's the trust-model Phase-2 plan, item 5).

## What's already built (the working moderation surface)

- **Report intake** — `POST /reports`, GitHub-bearer auth, 10/hr/user, reporter-IP SHA-256+pepper hash for dedup, audit row. (`reports.ts`, `ratelimit.ts`)
- **Operator moderation** — `GET /admin/reports` (filter pending/resolved), `POST /admin/reports/:id/resolve` (dismiss or unlist, idempotency-guarded `WHERE status='pending'`), `POST /admin/harnesses/:id/unlist` (proactive takedown). Gated by the `CUPBOARD_OPERATOR_GITHUB_IDS` allowlist. (`admin.ts`, `auth.ts`)
- **Publish guards** — GitHub-bearer auth, 5/hr/user publish cap (D1), private-repo rejection + repo-id spoof guard, dedup by `github_repository_id`. (`harnesses.ts`)
- **List guard** — 60/IP/min (KV). (`ratelimit.ts`)
- **Indexer auto-unlist** — a listed repo that 404s on GitHub is auto-unlisted `by_indexer:gh_404`. (`indexer.ts`)
- **Audit** — every publish/claim/unlist/report/resolve writes an `audit` row (kind + detail + ts).
- **Publisher trust signal (item 2, shipped 2026-06-02)** — listings now record the publisher's repo permission; the card flags "not a collaborator".

## Residual abuse vectors (severity-tagged)

1. **[MED] Repo squatting by non-owners.** Anyone can publish an `unclaimed` listing for any *public* repo they don't own. Contained by: publisher-permission signal (item 2), maintainer claim/supersede displacement, report→takedown. **Not** contained for repos whose real maintainers never join Papercusp — those squats persist until reported. Channel-2 attribution (item 1) makes the squatter *bannable beyond a throwaway account*.
2. **[MED] Account-rotation rate-limit evasion.** The 5/hr publish cap is per `github_user_id`; fresh GitHub accounts reset it. Channel-2 device-identity (item 1) + a device-pubkey ban-list raise the cost. No global publish ceiling exists.
3. **[LOW-MED] Free-text report reason — no taxonomy.** `reason` is free prose; no structured category (spam / impersonation / malware / inappropriate / DMCA). Hurts triage, analytics, and any future auto-handling. A small enum + optional details field is the fix.
4. **[LOW-MED] No takedown SLA / operator alerting.** Reports land in a pending queue an operator must poll; no notification on new report, no auto-hide of a heavily-reported listing pending review. At dogfood volume this is fine; at scale it's a latency hole.
5. **[LOW] Reporter abuse (mass false-reporting).** 10/hr/user report cap; resolution is operator-gated (a report alone never auto-unlists — good). But no reporter-reputation / false-report tracking to throttle a harasser.
6. **[LOW] No content scanning.** `title`/`description` (≤200/≤280) are unscanned free text — no malware-link / profanity / phishing check. Report-driven only.
7. **[LOW] Near-duplicate / typosquat listings.** Dedup is exact by `github_repository_id` (one listing per repo). A typosquat repo (`reactt/react`) is a *different* repo id → a separate, allowed listing. No fuzzy dedup. Low priority for v1.
8. **[INFO] Single shared operator identity.** `CUPBOARD_OPERATOR_GITHUB_IDS=papercupai` only. Fine now; the audit log already records `by_user_id`, so multi-operator is a config change, not a code change.

## Recommendations

- **Keep the reactive posture** (confirmed in the provisional-listing memo). Do not add a preventive maintainer gate at publish — it kills inventory and duplicates the `claim` check.
- **Land items 1 + 2 as the identity hardening.** Item 2 shipped; item 1 (channel-2 attribution + device-pubkey ban-list) is the highest-leverage next step against squatting + rotation.
- **Add a report-reason taxonomy** (enum + optional details) — small, and it's a pre-public-launch must (it gates triage + any automation).
- **Defer** fuzzy dedup, content scanning, reporter-reputation — report-driven moderation covers v1; revisit on real abuse signal, don't pre-build.

## Pre-public-launch checklist (gate before opening beyond dogfood)

- [ ] Item 1 (channel-2 publisher attribution + device-pubkey ban-list) shipped.
- [ ] Report-reason taxonomy (structured categories) shipped.
- [ ] Takedown SLA defined + new-report operator notification wired.
- [ ] Auto-hide threshold for heavily-reported listings (hide-pending-review, not auto-delete).
- [ ] Global publish ceiling / abuse circuit-breaker considered.
- [ ] Multi-operator allowlist + a documented escalation/appeal path.
- [ ] A "this is provisional / report this listing" affordance visible on every browse card + detail view.

## Follow-ups (non-blocking, tracked here)

- Report-reason taxonomy (enum + details) — small Worker + schema + UI change.
- Operator notification on new report (the moderation surface exists; add a push).
- Reporter-reputation / false-report throttle — only if abuse signal appears.

## Decisions

(Recorded below via plans:add-decision.)

### D-001 — Reactive moderation posture confirmed; no preventive publish gate
Date: 2026-06-02
Cupboard abuse handling stays reactive — report → operator takedown, plus maintainer claim/supersede displacement and the publisher-permission signal — rather than a preventive maintainer/contributor gate at publish. A preventive gate would starve discovery inventory and duplicate the authority check that already lives at `claim`. Consistent with cupboard-provisional-listing-trust-2026-06-02 D-001/D-002. The identity hardening against squatting + account-rotation is item 1 (channel-2 device attribution + a device-pubkey ban-list), not a publish-time permission check.

### D-002 — Report-reason taxonomy + operator notification are pre-public-launch musts; other anti-abuse deferred
Date: 2026-06-02
Two gaps are gating for any public (non-dogfood) launch: (1) a structured report-reason taxonomy (enum + optional details) replacing today's free-text `reason`, because it gates triage + any automation; and (2) a new-report operator notification + a defined takedown SLA, since reports currently sit in a poll-only pending queue. Deferred until a real abuse signal appears (do NOT pre-build): fuzzy/typosquat dedup, title/description content scanning, and reporter-reputation/false-report throttling. At dogfood volume the existing report→takedown loop is sufficient; the checklist in this plan is the gate to revisit before widening access.
