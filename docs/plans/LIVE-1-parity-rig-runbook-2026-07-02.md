# LIVE-1 runbook — 2-machine live proof of the cross-machine coordination parity layer

**Plan:** `cross-machine-coord-parity-and-trust-2026-07-01` · item **P-059 (LIVE-1)** — the
feature-done GATE. The program's cardinal rule: *in-process green ≠ live green* (the A→B
owner-admit race passed every in-process test and failed live). Everything shipped this plan
is in-process + fake-swarm green; NOTHING is proven live cross-machine until this runbook
passes.

> **REDEFINED TO LOCAL RIGS (2026-07-03).** Hetzner access is GONE (owner directive; D-001 of
> `shared-hive-p2p-release-readiness-2026-07-03`) — the old "paid cloud VMs, owner triggers"
> gate is obsolete. This runbook's proofs now run on the LOCAL rig set, no spend and no owner
> trigger needed: `bin/local-matrix.sh` (containerized 2-node, the same BYO-frames seam that
> produced min-bar run m1783013203) or `bin/vm-rig/` (tower↔VM, true kernel/network boundary).
> The `PRESENCE_GOSSIP` prod-flag cutover REMAINS an owner call.

## Rig chassis (already scaffolded)

- `papercusp-desktop/bin/lib/deb-hetzner-rig.sh` — the reusable provision/install/join/assert
  machinery (N frames: owner + N members), real Hetzner VMs, public DHT, packaged `.deb` sidecar
  (`serve.mjs` + bundled embedded-pg + swarm), headless (no Tauri GUI).
- `papercusp-desktop/bin/lib/federation-asserts.sh` — the shared assert core (`fed_assert_*`).
- Scenarios: `deb-hetzner-federation.sh` (2-frame base: owner `papercupai` + joiner `aviynw`),
  `deb-hetzner-multimember.sh` (3-frame), `deb-hetzner-coord-controlplane.sh`,
  `deb-hetzner-reconnect.sh`, `deb-hetzner-revocation.sh`, `deb-hetzner-matrix.sh`, …

## What LIVE-1 must prove (the 5 parity surfaces added this plan)

Run the 2-frame federation scenario (owner A + joiner B, same shared hive), then assert each
surface below on the RECEIVING machine's PG / coord tools. Where an assertion is not yet a
`fed_assert_*` helper, it is specified here as the exact check (codifying them into
`federation-asserts.sh` is a bounded follow-up — see WI note at the end).

1. **Wake bridge (P-002 / P-003)** — from A, `coord:send { to:[<B-agent>], wake:'required',
   scope:'hive' }`. Assert on B: the agent's inbox-wake fired (a live turn started), and the
   per-author federated-wake budget (`PAPERCUSP_FED_WAKE_MAX_PER_HOUR`) caps a flood — a burst
   of N>budget wakes wakes ≤ budget, the rest deliver without a re-invoke.
2. **Delivery receipts (P-008 + M5a/M5b)** — the same directed `receipt:true` wake. Assert on
   A: exactly ONE `coord:receipt:<msg_id>` fed-event row arrives with `delivered:true, woken:1`
   (M5a: only the machine that actually woke someone emits it — no N-1 false `delivered:true`).
   A below-tier/rate-exceeded flood emits ≤ the per-author budget of quarantine receipts (M5b).
3. **Federated events (P-009)** — from A, `events:emit { key:'git:staging-advanced',
   scope:'hive' }` while B holds `events:await { event:'git:staging-advanced' }`. Assert B's
   await fires exactly once; a re-applied row never re-fires (exactly-once + budget-capped).
4. **Presence gossip (P-004/P-005 + H1/H2/H3)** — with `PRESENCE_GOSSIP` ON on BOTH machines:
   assert B's `shared_presence` / `shared_session_presence` contains A's live rows and A's
   session ownerIds resolve/address from B (`coord:send` to a remote su-id succeeds). Adversarial
   (H1/H2/H3): a frame whose `github_user_id` ≠ the signer's attestation, or a `del` for another
   device's row, or a session claiming a local ownerId, must NOT mutate B's projection.
5. **Claim-spec federation (P-016 + M6/M7/L9)** — from A (a steer-tier queen),
   `scheduler:set_claim_spec { beeId, spec, scope:'hive' }`. Assert B's `bee_claim_specs` has the
   spec (get_next reads it) with `fed_hlc/fed_ts` stamped (M7). A **below-steer** author's spec
   must NOT apply on B (M6). Re-home the spec to a different hive scope → the old-scope row is
   tombstoned on B (L9).

## The `PRESENCE_GOSSIP` cutover (reader-first)

The reader is wired UNCONDITIONALLY (idles at zero cost with no writers); the WRITER is
flag-DARK. So: (1) confirm BOTH machines run a build with the reader (any build after this
plan). (2) Flip `PRESENCE_GOSSIP` ON via `/admin/features` (never JSON/PostHog). (3) Re-run
surface #4. Only after #4 is green cross-machine is `PRESENCE_GOSSIP` safe to leave ON in prod
— until then remote agents are NOT addressable (the session roster + resolver return nothing).

## Multi-owner note

Do NOT enable any **multi-owner** hive (a hive with members of DIFFERENT github users) until
LIVE-1 is green. The Tier-B security blockers (H1/H2/H3/M6) are landed + in-process-green, but
their live behavior is unproven until surface #4/#5's adversarial checks pass on real hardware.
The **same-owner** dogfood hive (`comms.defaultTier:'steer'`) is unaffected and does not gate on
this.

## Run

```bash
cd papercusp-desktop
# LOCAL, no creds, no spend (D-001): containerized 2-node frames + testnet DHT,
# then the full scenario matrix through the BYO-frames seam:
bin/local-matrix.sh                      # full 8-scenario matrix (needs a built .deb)
bin/local-matrix.sh --only=coord_controlplane   # just the coord boundary scenario
# tower↔VM rig (true kernel/network boundary — the P-059 drill):
bin/vm-rig/deploy.sh && bin/vm-rig/probe-fwd.sh && bin/vm-rig/probe-rev.sh
# surfaces 1-5 as one green/red exit (see the follow-up below):
bin/vm-rig/parity.sh
# (RETIRED, kept for reference — requires Hetzner access we no longer have:)
# bin/deb-hetzner-federation.sh
```

**Follow-up — DONE 2026-08-02 (WI-7000).** ~~codify surfaces 1–5 above into `fed_assert_*`
helpers in `bin/lib/federation-asserts.sh` and call them from `deb-hetzner-federation.sh`~~,
so the parity proof is a single green/red exit rather than manual PG inspection.

The helpers landed in July; **the caller named here never did** — `deb-hetzner-federation.sh`
is the RETIRED Hetzner scenario, so all five asserts were unreachable dead code for a month
while surfaces 1/2/4/5 stayed "unproven cross-machine, manual PG inspection". The driver is
now **`bin/vm-rig/parity.sh`**, pointed at the rig that does exist (tower ↔ Mac VM); the
asserts themselves were not modified. `npm run lint:assert-integrity` (R6) fails the build
if any assert helper goes unreachable again.

First real cross-machine run (1785661381, tower `main-server-Precision-7865-Tower` ↔
`Avis-iMac.local`): **green=3 red=2**.

- 🟢 `fedevents` (P-009), `claimspec` (P-016+M7), `presence` (P-004/P-005) — **proven
  cross-machine**, first time; these three were "manual PG inspection" until now.
- 🔴 `wakebridge` (P-002/P-003), `receipts` (P-008+M5a) — **NOT a federation fault.** The
  message provably crosses (a tower `coord:send` msg_id lands in the Mac's `coord_event_log`
  with `origin='remote'`). `fed_assert_wake_bridge` reads `fired_at` on the always-armed
  `coord:inbox-wake:<agent>` row, and that observable stopped being produced when the watch
  became always-armed-at-session-start (D-005): 1 firing in 24h across 28,590 tower rows; 2
  ever on the Mac, both on the day the asserts were written. `receipts` is downstream of it.
  Tracked as **WI-7012** — re-point the assert at what the wake executor actually writes per
  delivery, or hand it to P-001. Do not read either red as "cross-machine wake is broken".

  **RESOLVED 2026-08-02 (WI-7012): it was (a), a stale observable — not a wake-executor gap.**
  `event_awaits.once` is the cardinality flag, and `fireAwaitsForKey` fires a STANDING
  (`once=false`) row with a plain SELECT — "match without consuming" (store.ts:541-548) — while
  only the `once=true` branch UPDATEs `fired_at`. The always-armed `coord:inbox-wake:<agent>` row
  is standing, so `fired_at` is **never written for that row class**. Measured: `once=false` ->
  28,569 rows, **0 ever fired**; `once=true` -> 58 rows, 55 fired. The earlier "1 firing in 24h"
  mixed the two populations - that one firing was a one-shot.

  `fed_assert_wake_bridge` now reads **`harness_shared.event_wake_deliveries`** (one row per
  recipient per fire), asserting `status='delivered'` so it cannot pass on a wake that queued and
  died; a failure prints the statuses actually observed instead of a bare 0. Verified satisfiable
  BEFORE being relied on: delivered=33,684 (74 in the last hour), dropped=62 (none since
  2026-07-10), dead=17 (none since 2026-07-19). Negative controls return 0 (bogus agent; future
  `since`).

  WARNING - deliberately NOT workspace-scoped. `subscriber_id` is a globally-unique agent id, so
  `(subscriber_id, event_key)` already pins one identity. Scoping to
  `workspace_id='papercusp-workspace'` - which `dev:pg_query`'s tenant advisory suggests - returns
  **0**: every row is `workspace_id='default'` and there is exactly one distinct workspace. Adding
  that filter would silently re-create the very always-0 bug this fixes.

  **Legs 2+3 still cannot be RUN, for a different reason now:** there is no live session homed on
  the Mac to address. The Mac receives tower gossip fine (its `shared_presence` /
  `shared_session_presence` carry fresh tower rows, ~10s old) but publishes **nothing of its own**,
  so the tower's roster holds no Mac row and target discovery fails before the bridge is ever
  exercised. Note `fed_assert_presence_gossip` asserts only the **tower->Mac** direction, so its
  green never covered this. Tracked separately.
