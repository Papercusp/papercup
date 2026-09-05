# LIVE-2 shared-fleet scenario — end-to-end checklist + cutover/GO-NO-GO criteria (prep, 2026-07-10)

**Plan:** `p2p-parity-closeout-lanes-2026-07-10` · item **P-010** (WI-3770).
**Status: PREP ONLY.** Execution is gated on **P-059 (LIVE-1) GREEN**
(`cross-machine-coord-parity-and-trust-2026-07-01`) and requires an explicit call from the
plan leader (**su-4dc3befd**, who holds the P-059 GREEN watch). Nothing in this doc
authorizes touching tower `bg-host` or the Mac VM's app lifecycle — that stays leader-ACK'd
per the closeout plan's `## Now`. This doc's only job is to have the checklist and criteria
**ready** so the moment P-059 flips green, execution can start without a design pause.

## What "LIVE-2" is

LIVE-2 is the **work-distribution acceptance drill** (offer → pull → spawn → results →
metering → revoke/reap), run as a genuine **shared-fleet, cross-machine** scenario — i.e.
the grantor/offeror on one machine and the puller/executor on a _different_ machine, over
the real hive-swarm + coord federation substrate. It is tracked as row **#17** of
`shared-pot-release-testing/RELEASE-READINESS.md` ("LIVE-2 work-distribution acceptance
drill"), spec = P-305 of `p2p-work-distribution-2026-07-02` (re-homed local per D-001 — no
Hetzner). It is distinct from LIVE-1 (P-059), which proves the underlying parity/coordination
layer (wake bridge, receipts, events, presence gossip, claim-spec federation) — LIVE-2 rides
_on top of_ that layer to prove a full work-distribution lifecycle live.

The **existing** drill (`papercusp-desktop/bin/work-distribution-drill.sh`, P-007/WI-1915) is
**single-box**: one packaged sidecar, with the in-flight foreign session seeded as a synthetic
DB row rather than a real cross-machine spawn. The "shared-fleet" delta this checklist exists
for is extending that proof to two real machines (mirroring how the LIVE-1 runbook was
redefined to `bin/vm-rig/` — tower ↔ VM, true kernel/network boundary — see
`LIVE-1-parity-rig-runbook-2026-07-02.md`).

## Hard prerequisite: P-059 GREEN

Every LIVE-2 leg below rides the same swarm + coord federation substrate LIVE-1 proves (wake
bridge, federated events, presence gossip, claim-spec federation — see
`LIVE-1-parity-rig-runbook-2026-07-02.md` §"the 5 parity surfaces"). Running LIVE-2 legs
cross-machine before that substrate is proven live would confound any failure (can't tell a
work-distribution bug from a parity-layer bug). As of 2026-07-10 09:xxZ, P-059 is **WIP**
under leader su-4dc3befd (watcher `br22sbw26`, current blocker `WI-3619` — tower outbox-drain
hang; see `WI-1729` / `WI-3619` checkpoints for live state). Do not schedule LIVE-2 execution
before the leader announces GREEN.

## Current wiring status of each leg (2026-07-10 snapshot — RE-VERIFY at execution time)

| Leg                                         | Wiring status (single-box)                                                                                                                                                                                                                    | Cross-machine proof status                                                                                                                  | Tracker                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| GRANT (Delegate preset)                     | 🟢 LIVE, drill-proven (LEG G)                                                                                                                                                                                                                 | rides presence-gossip/claim-spec fed (P-059 #4/#5)                                                                                          | —                                                                  |
| ALLOTMENT (M11 zero-allotment + set/remove) | 🟢 LIVE, drill-proven (LEG M11/A)                                                                                                                                                                                                             | per-machine by design (M19)                                                                                                                 | —                                                                  |
| OFFER-PUBLISH                               | 🟢 WIRED 2026-07-04 (mig 490 + offer-store.ts + D-005 seat-offer hook)                                                                                                                                                                        | cross-node proof = matrix scenario `seat_offer` (order 56)                                                                                  | WI-1935                                                            |
| PULL (standing-puller activation)           | 🟡 gated: `X11 PULLER_ACTIVATION_LANDED` flag was unflipped by design pending the claim-path soak, as of the last drill run — **re-verify current flag/soak state before relying on this row**, this pass hit MCP timeouts confirming it live | not yet proven                                                                                                                              | WI-1936                                                            |
| SPAWN (offer-executor caller)               | 🟢 **DONE 2026-07-10** — ephemeral `harness_registry` rows (option B) + deny-all `ROLE_ENVELOPES['foreign-session']` capability envelope landed + green (WI-1937 `passed`)                                                                    | **NOT YET** — the puller-boundary _integration seam_ (`standing-puller.evaluatePull` → `executeClaimedOffer`) was split out as its own item | WI-1937 (executor, done) / **WI-3629 (integration seam, BLOCKED)** |
| RESULTS (D-018)                             | rides SPAWN                                                                                                                                                                                                                                   | blocked with SPAWN's integration seam                                                                                                       | —                                                                  |
| METERING (durable ledger)                   | 🟢 substrate landed+passed 2026-07-03 (mig 483, `p2p_metering_spend`/`p2p_metering_contribution`, LOCAL-ONLY by design — never federates)                                                                                                     | N/A (local-only) — but **no production writer yet**; rows only start flowing once the puller/executor activation (WI-3629) lands            | WI-1938                                                            |
| NUDGE (push-nudge)                          | 🔴 unwired, deferred to this rig (P-305)                                                                                                                                                                                                      | not proven                                                                                                                                  | P-303                                                              |
| FED-REAP (cross-machine revoke→reap)        | 🔴 unwired (peer-grants projection-apply hook missing); LOCAL reap path proven (LEG R)                                                                                                                                                        | not proven                                                                                                                                  | reaper deferred #3                                                 |
| Fleet-directory PUBLISH                     | 🟢 WIRED (WI-2006)                                                                                                                                                                                                                            | cross-node proof = matrix scenario `fleet-directory.sh`                                                                                     | WI-2006                                                            |

**The single blocking chain for the SPAWN/RESULTS/METERING-writer legs** is:
`WI-3546` (multi-device same-identity LIVE witness, todo, held by su-9ca33b25 on
`p2p-rest-lanes-2026-07-09` P-009) → unblocks `WI-3629` (puller-boundary seam, blocked,
requires a **real-seam integration test**, not a mocked executor, per the leader's explicit
ruling msg `mre7x47s`) → which is what finally makes PULL→SPAWN→METERING a live, wired chain.
Separately, `WI-3590` (host-availability live-headroom wiring) is **still open** — production
`hostAvailability` is deliberately fail-closed to 0 on both axes, so even after WI-3629 lands,
claim admission stays refused-safe until WI-3590 also lands (or an explicit accepted-risk note
is issued). `WI-3544` (work-distribution wiring activation umbrella, blocked, su-9ca33b25) is
the tracking item for this whole chain — check it directly for the latest state before
executing.

## End-to-end execution checklist (run in order, once P-059 is GREEN)

1. **Confirm P-059 GREEN** — leader (su-4dc3befd) has announced the watch exited GREEN
   (`wm>127` sustained, per `## Now`); `PRESENCE_GOSSIP` writer cutover done on BOTH
   machines (LIVE-1 runbook step 4/5).
2. **Confirm `WI-3546`** (multi-device same-identity LIVE witness) is `passed` — this is the
   activation-chain's own gating live-verification.
3. **Confirm `WI-3629`** (puller-boundary seam) landed **with its required real-seam
   integration test** — do not activate on a stub/mocked-executor test per the leader's
   finding #4 (the WI-3591 near-miss precedent).
4. **Re-verify `WI-1936`**'s puller-activation flag state and the claim-path soak evidence
   at execution time (this doc could not re-confirm it live this pass — MCP tool timeouts;
   treat as unknown, not assumed-flipped, until checked).
5. **Confirm `WI-3590`** (host-availability live-headroom) landed, OR obtain an explicit
   leader-ratified accepted-risk note if proceeding with claim admission fail-closed-to-0
   (in which case SPAWN legs will legitimately no-op — do not mistake that for a drill bug).
6. **Extend the drill to a real 2-machine topology**: sidecar A on tower, sidecar B on the
   VM rig (mirror `bin/vm-rig/deploy.sh` + `probe-fwd.sh`/`probe-rev.sh` from the LIVE-1
   runbook for the rig bring-up pattern), same DHT bootstrap, real swarm connect — replace
   the current single-box synthetic `p2p_foreign_workspaces` seed row (LEG FW) with a REAL
   claim → spawn on the OTHER machine. This is the one piece of new script work this
   checklist implies; it does not exist yet and should not be written before step 1–5 are
   green (no point drilling a chain that's still legitimately gated).
7. **Run the full leg set cross-machine**: GRANT → OFFER-PUBLISH → PULL (real, on machine B)
   → SPAWN (real, executor on machine B) → RESULTS → METERING (real writer) → REVOKE (from
   machine A) → **FED-REAP** (assert the reaper fail-closes the FOREIGN session running on
   machine B, not just a local row — this is the leg the single-box drill structurally
   cannot prove, since LEG R only ever reaps a same-host row).
8. **Adversarial/chaos legs** (mirror LIVE-1's H1-H3 posture): a stale/duplicate offer claim
   raced across both machines; a revoke on A while the executor session is live on B (assert
   fail-closed reap, not a race where B's session survives); a below-grant-tier pull attempt
   from a third, non-granted fleet (assert loud refusal + receipt, not silent drop).
9. **Zero unexplained SKIPs.** Every leg in the table above must be a live PASS, or carry an
   explicit, currently-valid, leader/owner-ratified reason to still SKIP (e.g. NUDGE if P-303
   remains deliberately deferred). A stale SKIP reason (one whose blocking WI has since landed)
   is a drill bug, not a pass.

## Multi-account leg — aviynw ↔ papercupai (owner-directed 2026-06-29, WI-3965)

> ⚠ **PROVENANCE CORRECTED 2026-08-01** — see plan decision
> `p2p-public-release-remaining-lanes-2026-07-16#D-020` and workspace fact
> `wi-3965-owner-quote-is-fabricated-real-turn-is-2026-06-29`.
>
> This section previously cited `[owner:Avi 2026-07-10, verbatim]`: _"i approve all i unblock
> all the gates. You should have access to both the aviynw account and the papercupai account
> you can do the communication between them so that we have a multi account test"_, recorded as
> fact `owner-unblocks-all-gates-multi-account-test-2026-07-10`. **That quote is not an owner
> turn.** Three exhaustive transcript searches (`hasMore:false`) return only agent-authored
> carry surfaces; its earliest occurrence anywhere is a `/compact` summary (session `f6d39fa7`
> turn 44, 2026-07-10 18:11 local). The cited fact key is dead (TTL-pruned, 0 versions).
> **Nothing may be revived from it, and it unblocks no gate.**

The **real** owner turn is session `24b5e4b7` turn 100, **2026-06-29 19:58:43-04**, interactive:

> _"hardening P-008" - you should already have acess to both the aviynw account and the
> papercupai account, cant you use those 2?_ (sic)

That genuinely authorizes **using both GitHub accounts for a cross-account test** — MA-0..MA-5
below proceed on that basis. It does **not** carry any blanket gate approval; a gate that needs
owner sign-off still needs it. Note the accounts are **GitHub identities** (`gh auth token
--user papercupai` / `--user aviynw`), _not_ the Claude subscription pool — `accounts:list`
having no `papercupai` is the wrong surface, not a blocker. This adds a **cross-ACCOUNT** leg to
the drill, distinct from step 2's WI-3546 (which proves multi-device **same**-identity): here
the two rig sides announce **different `github_user_id`s** (aviynw vs papercupai), so every
federation surface crosses an **owner boundary** — the Phase-9 / D-013 multi-owner trust
surfaces get their first live, two-account exercise.

Run AFTER the same-identity legs pass (steps 1–7), so an identity-boundary failure is
attributable to the account boundary and not to a still-broken substrate:

- **MA-0 (setup)**: verify which machine holds which credential (`[swarm] joined topic …
announcing as github_user_id=…` in each side's log); re-auth one side to the second account
  if both currently announce the same id. Record the two ids in the run log.
- **MA-1 (connect)**: swarm connect with distinct announced identities — assert BOTH sides log
  the peer with the _other_ account's id (not a same-id dedupe or a silent identity coercion).
- **MA-2 (coord)**: `coord:send { scope:'hive' }` in each direction across the account
  boundary; assert delivery + `origin='remote'` row on the receiving side, AND that the
  envelope's verified author id is the sender's account (no id spoofing/blending).
- **MA-3 (events)**: federated `events:emit`/`events:await` round-trip in both directions.
- **MA-4 (work distribution)**: OFFER published by account A, PULL + SPAWN by account B —
  the foreign session must run under the WI-1937 **deny-all** `ROLE_ENVELOPES['foreign-session']`
  envelope; assert the metering ledger attributes spend/contribution to the correct account.
- **MA-5 (negative)**: a pull attempt against a grant NOT extended to that account → loud
  refusal + receipt (not silent drop, not success). This is the leg that proves the account
  boundary is real, not decorative.

**Sign-off boundary:** the verified 2026-06-29 owner turn authorizes using the aviynw and
papercupai GitHub identities for this cross-account test. It does **not** authorize a broader
capability envelope, and it is not the fresh owner sign-off required to widen beyond WI-1937's
deny-all baseline. MA-4 therefore remains deny-all; any wider envelope stays NO-GO until it is
independently authorized and logged. The retracted 2026-07-10 quote and its dead fact key are
not authority for this or any other gate.

## Cutover / GO-NO-GO criteria

**GO** requires ALL of:

- P-059 (LIVE-1) GREEN, both machines, `PRESENCE_GOSSIP` writer cutover complete.
- WI-3546 witness `passed`.
- WI-3629 landed WITH a real-seam (non-mocked) integration test.
- WI-1936 puller-activation flag flipped with soak evidence attached (not just "unflipped by
  design" carried forward stale).
- WI-3590 landed, or an explicit leader-ratified accepted-risk note for fail-closed-0 admission.
- The 2-machine drill (step 6 above) exists, runs, and is green: PASS on every wired leg,
  zero FAIL, zero unexplained SKIP.
- Adversarial legs (step 8) all pass — especially cross-machine FED-REAP, the one property
  the single-box drill cannot exercise.
- Multi-account legs MA-1..MA-5 all pass (owner-directed 2026-06-29, WI-3965) — especially
  MA-5 (non-granted-account refusal), the multi-owner analogue of FED-REAP.

**NO-GO** triggers on any of:

- Any FAIL on a leg the ledger above marks wired/passed.
- A SKIP without a current, leader-ratified reason.
- Evidence that a broader capability grant than the shipped deny-all `ROLE_ENVELOPES`
  baseline (WI-1937) is in play without its own fresh owner sign-off — the P-105 foreign-work
  sandbox trust model was owner-authority-gated; WI-1937 resolved the deny-all baseline only.
  If a follow-up "capability grants beyond deny-all" item (referenced in WI-1937's checkpoint
  as still-to-file) has since landed and is in scope for this drill, it needs its own
  independent sign-off — do not assume WI-1937's ratification covers it.
- Cross-machine FED-REAP failing to fail-closed (a live foreign session surviving its
  grantor's revoke is a security hole, not a soft miss).

**Rollback lever:** every leg is independently flippable — PULL stops the instant the
puller-activation flag flips off; a grant `revoke` immediately fail-closes + reaps (proven
locally by LEG R; cross-machine FED-REAP is exactly what step 7/9 must additionally prove).
Document the exact flip-off order (flag → grant revoke → confirm reap) in the execution
runbook before the first live cross-machine run, so a bad drill result has a scripted,
fast undo.

## Ownership at execution time

This is prep only. When the GO checklist above is fully green, the plan leader (or an agent
the leader explicitly delegates) executes — per the closeout plan's `## Now`, no tower
`bg-host` or Mac VM app-lifecycle action without leader ACK. This document does not authorize
execution by itself; it exists so execution can start immediately once the leader calls GREEN.
