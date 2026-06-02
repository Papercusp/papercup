---
title: Cupboard provisional-listing trust: discoverability vs squatting
slug: cupboard-provisional-listing-trust-2026-06-02
status: active
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# Cupboard provisional-listing trust: discoverability vs squatting

## Now

**State:** Decision recorded. Provisional (`unclaimed`) harnesses ARE discoverable in Cupboard, by design; the browse card now badges them (CupboardClient change, 2026-06-02). Trust posture = authenticated publish + visible provisional badge + reactive moderation + maintainer-claim displacement — NOT a preventive permission gate.

**Next:** optional hardening (channel-2 publisher attribution; a publisher-permission signal on the card) if/when Cupboard opens beyond dogfood. None blocking today.

## Background

Cupboard (the central, papercupai-hosted marketplace; `apps/operator-public/`, live at `cupboard.papercusp.com`) is the only *browsable* discovery surface for shared harnesses. The Hyperswarm topic is `sha256("…:gh:<repo_id>")`, derivable only if you already know the repo — so peer discovery cannot make a harness "findable" to strangers. Discovery therefore *requires* the central listing.

A binding carries two **independent** axes (`apps/operator/lib/harness/binding-types.ts`):

- **Privacy** — `shared-public` = "listed in Cupboard" vs `shared-private` = visible only to binding-holders.
- **Claim** — `unclaimed` (provisional) → `claimed` (GitHub maintain/admin verified) → `stale` → `superseded`.

Nothing couples them: a `shared-public` + `unclaimed` harness — discoverable but unverified-owner — is a first-class state. Choosing `shared-public` at share time auto-publishes to Cupboard immediately (`ShareWizard` best-effort `publishToCupboard`), while still `unclaimed`. So provisional listings are discoverable *today*; this memo makes that an explicit, tracked decision rather than an implicit one, and records the residual risk.

## The tension

Anyone with a GitHub OAuth token can publish an `unclaimed` listing for **any public repo** — `POST /harnesses` does **no** maintain/admin check (that gate lives only on `claim`). So a non-maintainer can stand up a provisional Cupboard listing for a repo they do not own (squatting / impersonation on a branded marketplace).

The crucial distinction (carried from `papercusp-trust-model-2026-05-31`):

- **Authenticity — who published it.** The Cupboard listing IS authenticated: publish requires a GitHub bearer token validated against `GET /user` (`apps/operator-public/src/auth.ts`), and listings dedup per `github_repository_id`. This is *not* the unsigned-swarm-row problem — the publisher's GitHub identity is real. (Per-op signing / "Phase 2" concerns the *swarm advisory rows*, a different surface — not the Cupboard copy.)
- **Authority — whether the publisher actually owns the repo.** NOT checked at publish; deferred to `claim` (maintain/admin) and to GitHub itself for merging.

So a provisional listing is **authentic but unauthorized**: a verifiable GitHub user making an unverified ownership claim.

## What's already built (anti-abuse, all deployed)

- **GitHub-bearer auth** at publish/claim/report — no anonymous writes (`auth.ts`).
- **Rate limits** — 5 publishes/user/hour (D1 `publish_rate_limit`), 60 list/IP/min (KV), 10 reports/user/hour (`ratelimit.ts`).
- **Private-repo rejection** + repo-id spoof guard at publish (`routes/harnesses.ts`).
- **Dedup** by `github_repository_id` — one listing per repo; a second publish returns the existing row.
- **Report → operator moderation / takedown** — `POST /reports`, `GET /admin/reports`, `POST /admin/harnesses/:id/unlist`, gated by the `CUPBOARD_OPERATOR_GITHUB_IDS` allowlist; `unlisted_at`/`unlisted_reason` hide a listing. (Corrects an earlier verbal claim that this was "not built" — it is built, tested, and deployed.)
- **Maintainer displacement** — a real maintainer can `claim` (maintain/admin) or `supersede` (admin), converting/replacing the provisional listing with an authoritative one.

## Residual risk (accepted, with mitigations)

1. **Squatting on repos whose maintainers aren't Papercusp users.** Displacement only self-corrects if the real maintainer shows up to claim. For absentee-maintainer repos, a squatter's provisional listing persists until reported. Mitigation today: report/takedown + rate limits — reactive, not preventive.
2. **Provisional ≠ visually obvious — FIXED 2026-06-02.** Browse cards previously badged only `claimed`; `unclaimed` rendered unlabeled — backwards, since the unverified one is the one to flag. Now wired to the canonical `ClaimStatusBadge` so every card shows its claim state (`apps/operator/app/cupboard/CupboardClient.tsx`; regression test `app/cupboard/__tests__/CupboardClient.test.tsx`).
3. **Attribution is rate-limit-bound, not identity-bound beyond GitHub OAuth.** A determined abuser can rotate accounts within the 5/hr cap. A channel-2 device↔login binding would make listings attributable/bannable beyond a raw token; not wired for Cupboard publish yet.

## Recommendation

Keep provisional listings discoverable. The growth case is real: a maintain/admin-only catalog is too thin and gates inventory on who happens to own repos. Hold the posture — **authenticated publish + conspicuous provisional badge + reactive moderation + maintainer-claim displacement.** Do **not** add a preventive contributor/maintainer gate at publish for the dogfood phase: it would kill discovery inventory and duplicate the authority check that already lives at `claim`. Revisit if/when Cupboard opens to the public; the follow-ups below are the levers.

## Follow-ups (non-blocking)

- Channel-2 publisher attribution on Cupboard listings (attributable/bannable identity beyond an OAuth token).
- Optional publisher-permission signal on the card (e.g. "published by a contributor" vs "by a non-collaborator") so browsers can weight trust without a hard gate.
- Abuse-surface review before any public (non-dogfood) Cupboard launch: takedown SLA, report-reason taxonomy, automated dedup of near-identical squat listings.
- (Separate surface) Trust-model Phase 2 per-op signing for swarm advisory rows — tracked in `papercusp-trust-model-2026-05-31`, not here.

## Decisions

(Recorded below via plans:add-decision.)

### D-001 — Provisional (unclaimed) harnesses are discoverable in Cupboard
Date: 2026-06-02
Growth requires a browsable central catalog. The Hyperswarm topic is `sha256("…:gh:<repo_id>")` — derivable only if you already know the repo — so peer discovery cannot surface a harness to strangers. We therefore allow `shared-public` + `unclaimed` (provisional) listings to appear in Cupboard, not just `claimed` ones. The listing is authenticated at publish (GitHub bearer validated against `GET /user`) so the publisher identity is real; repo *authority* remains deferred to `claim` (maintain/admin). Gating discovery on maintain/admin would starve the catalog and gate inventory on who happens to own repos.

### D-002 — Trust posture is reactive moderation + maintainer displacement, not a preventive publish-time gate
Date: 2026-06-02
For the dogfood phase we deliberately do NOT add a contributor/maintainer permission check at `POST /harnesses`. Squatting/impersonation is contained by: GitHub-bearer auth, per-user/IP rate limits (5 publishes/user/hr), private-repo rejection, per-repo dedup, the report → operator-takedown flow (`/reports` + `/admin/...` gated by `CUPBOARD_OPERATOR_GITHUB_IDS`), and maintainer `claim`/`supersede` displacement. A preventive gate would kill inventory and duplicate the authority check that already exists at `claim`. Accepted residual risk: squatting on repos whose real maintainers are not Papercusp users persists until reported (displacement only self-corrects if the maintainer shows up). Revisit before any public (non-dogfood) launch.

### D-003 — Provisional listings must be visibly badged in browse
Date: 2026-06-02
The Cupboard browse card previously badged only `claimed`, leaving `unclaimed` — the unverified, anyone-can-create state — unlabeled, which is backwards from a trust standpoint (the unverified one is the one to flag). Fixed 2026-06-02 by wiring the canonical `ClaimStatusBadge` into `apps/operator/app/cupboard/CupboardClient.tsx` (the inline `claimed`-only badge was removed; the component's own doc already claimed the card used it). Now every card shows its claim state, including the provisional pill + explanatory tooltip. Regression test: `apps/operator/app/cupboard/__tests__/CupboardClient.test.tsx`.
