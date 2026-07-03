# DESIGN — Results channel for foreign work (P-108): option (a) vs (b)

**Plan:** `p2p-work-distribution-2026-07-02` · **Item:** P-108 (C9/X3) · **Author:** su-c88ac (lane C) · **Date:** 2026-07-02
**Status:** PROPOSAL — awaiting leader ratification (RC-D1..RC-D4). No build until ratified.
**Companion:** `DESIGN-P-006-federation-scope-2026-07-02.md` (the primitive option (b) consumes).

---

## 1. The problem (X3, restated precisely)

Foreign work must deliver a git-shaped result back to the offer's origin. The P2P git
plane replicates **per-device namespaces** (`refs/namespaces/<hex>/…`) authenticated by
device **sigrefs**. The originally-prescribed `refs/foreign/<fleet>/…` top-level family
lives **outside every device namespace**: sigrefs don't cover it, peers don't fetch it —
as written, the deliverable path **does not federate at all**. Two repairs exist; the
plan requires choosing explicitly.

## 2. The options

### (a) Nest foreign refs inside the EXECUTOR's device namespace
`refs/namespaces/<executor-hex>/refs/foreign/<fleet>/…`

- ✅ Existing replication carries it today; zero new replication machinery.
- ❌ **Namespace replication is hive-wide** → every hive member receives every fleet's
  foreign work **content**. That violates M14 directly — and leaks *work products*, which
  is strictly worse than the presence metadata M14 was written about. It also re-opens
  the H16 flood on the git plane (one busy fleet's artifacts bloat every member's repo,
  and federated objects effectively never die — X4's own storage argument).
- ❌ Sigref semantics must gain the executor-not-author distinction (C8) **inside the
  hive-wide trust plane** — a semantic change to the most security-central shared surface,
  carried by everyone whether or not they run fleets.
- ❌ Poisons the P-110 admission boundary: foreign-marked refs are only distinguishable
  by path convention inside an otherwise-trusted namespace; every member's canonical
  merge path must now parse namespace-internal path shapes to know what is foreign.

### (b) Per-fleet ref visibility via the P-006 primitive
Foreign results live in the **per-scope bare repo** (`FS-D3`,
`<hive-git-root>/<hive>/scopes/fleet:<owner>/<slug>/repo.git`), fetched only by scope
members over the existing per-fetch sub-streams, serve-gated by roster.

- ✅ M14/H16 hold **by construction**: non-members never fetch, never store; the flood is
  bounded to the roster. No content leak to bystanders.
- ✅ C8's executor-not-author sigref extension is confined to scope repos — the hive-wide
  sigref plane is untouched.
- ✅ The foreign/canonical boundary is **structural** (a different repo), which makes
  P-110's admission check trivially anchorable: anything entering canonical from a scope
  repo IS foreign-marked, by provenance not by path parsing.
- ✅ Scope repos are independently GC-able/deletable on fleet archive (H10); rejected or
  expired foreign work never permanently bloats the hive repo (X4's federated-objects-
  survive concern).
- ❌ Real work — but the work is P-006's, already designed and priced (§9 there), and it
  is the SAME primitive P-101 offers and P-206 ads need anyway. Choosing (a) to avoid it
  buys nothing: the bee-plane consumers still need P-006, so (a) saves ~none of the
  primitive's cost while taking all of its leak.

## 3. Recommendation

**Option (b).** (a)'s only virtue is "ships on today's replication," and its price is a
hive-wide content leak that contradicts the plan's own binding rules (M14) plus a
security-semantics change to the shared sigref plane. Given P-006 must be built for the
bee-plane consumers regardless, (b) is both the correct and the *cheaper-at-the-margin*
choice. If the leader wants an interim demo before P-006's git half lands, the honest
stopgap is "results stay on the executor host + origin fetches by direct offer-scoped
handoff" (P-109's mirror lane can drive a LIVE-2 partial leg) — NOT (a); (a) is a one-way
door on content distribution that revocation cannot claw back.

## 4. Invariants that hold under EITHER option (build once, alongside)

- **RC-1 Completion receipt** references `{scope_id, ref, commit_oid, execution_epoch
  (H9), offer_id (M21)}` — the receipt is the pointer; **coord NEVER carries artifacts**.
- **RC-2 Admission at push** into the results channel: size/blob-cap + secret-scan,
  borrowing the github-egress large-blob-skip + secret-scan pattern (X4). Over-cap →
  refused loudly + P-004 receipt naming the cap.
- **RC-3** Results are signed by the EXECUTOR device with the origin claim attached (C8);
  a result whose execution epoch trails the offer's current epoch is rejected (H9 fencing).
- **RC-4** P-110's canonical-merge admission consumes the channel's foreign provenance
  marker; under (b) that marker is the scope-repo provenance itself.

## 5. Decisions proposed for ratification

- **RC-D1** — Results channel = **option (b)**: per-scope repo per FS-D3; (a) rejected
  (M14/H16 content leak, hive-wide sigref semantics change, weak P-110 anchor).
- **RC-D2** — RC-1..RC-4 are the channel's invariants regardless of transport; they gate
  the P-108 build's acceptance tests.
- **RC-D3** — Build order: P-108 build starts after FS-D1..D6 ratify; the RC-2 admission
  + RC-1 receipt shapes can be built against a local scope repo BEFORE the replication
  half lands (they are repo-local mechanics), so P-108 need not serialize fully behind
  P-006's federation wiring.
- **RC-D4** — LIVE-2 gains the leg: origin publishes offer → executor pushes result to
  scope repo → non-member host proven to hold zero result bytes → origin merges via
  P-110 admission → github-bridge egress attributes correctly.
