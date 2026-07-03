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
# (RETIRED, kept for reference — requires Hetzner access we no longer have:)
# bin/deb-hetzner-federation.sh
```

**Follow-up (bounded, not owner-gated):** codify surfaces 1–5 above into `fed_assert_*`
helpers in `bin/lib/federation-asserts.sh` and call them from `deb-hetzner-federation.sh`, so
the parity proof is a single green/red exit rather than manual PG inspection.
