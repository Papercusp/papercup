# LIVE-1 rig runbook (P-059, cross-machine-coord-parity-and-trust-2026-07-01)

Feature-done GATE: prove the parity layer LIVE between two real machines —
in-process green ≠ live green. Machine #1 = this tower
(`main-server-Precision-7865-Tower`). Machine #2 = `Avis-iMac_local-aviweiss`
(confirmed live on the federated plane 2026-07-02, hive `papercusp`,
device `lWfY6T6R…ax0A=`). Backup peers: `hzdebOAQICp-b-pcusp`, `hzdebXszHMy-b-pcusp`.

PRECONDITIONS (in order):
1. Cross-review matrix clean of blockers (B→C, C→B, D→A; dispatched 09:43Z).
2. Green-checkpoint verdict on the post-lane tip → `release:deploy op:trigger`
   → confirm the iMac actually picks up the release (parity reader must be
   running on BOTH machines before the writer flip).
3. WI-1547 (stale plans:get reads) at least root-caused — if it is a fed-read
   path bug it may distort drill observations.

DRILLS — each has an observable READ-BACK ON THIS MACHINE (no blind sends):

D1 presence gossip (P-004/P-005): watch `coord:presence` fed rows for the iMac
   across ~5 min — heartbeat freshness advances; session-grain rows appear.
   PASS: lastActive/startedAt advance without local restarts. SELF-SERVE.

D2 receipts (P-008): `coord:send` to a fed:1567022@Avis-iMac target →
   receiving machine appends a receipt row that federates back.
   PASS: receipt row for the msg_id visible here with the iMac's stamp.
   SELF-SERVE (needs only the remote HOST, not an agent session).

D3 federated events (P-009): `events:emit {scope:'hive', event:'live1-d3-<ts>'}`
   → peer re-fires into ITS await store. Observable: the fed-event coord row +
   (full loop) an awaiter on the iMac side gets woken.
   Half SELF-SERVE (row federates); FULL loop needs an awaiter on the iMac —
   see OWNER GATE below.

D4 wake bridge (P-002): wake a parked session ON the iMac from here
   (`coord:wake` / inbox-wake key). PASS: its presence flips parked→live and
   a reply lands. OWNER GATE: needs at least one live/parked su session on
   the iMac. Ask the owner to start one (`psu` on the iMac) if none.

D5 claim-spec fed (P-016): read the federated claim-spec table for a spec
   authored on the iMac side (or author one here, verify it lands in the
   iMac's projection via its echoed rows). PASS: spec row present with HLC
   stamp from the other machine (mig 439 stamping).

D6 writer flip (the gate's tail): after D1–D5 pass AND the release with the
   reader is confirmed running on both machines, flip the PRESENCE_GOSSIP
   writer flag. PASS: session roster/resolver stays coherent for 30 min after
   the flip (no dupe/ghost sessions), then mark P-059 done.

DRIVER WIRING INVARIANTS (from D→A review cautions, su-1c2e7, 2026-07-02):
W1: the trust gate is optional by construction — the live driver MUST make it
    mandatory: collectMemberHeads (integrator.ts:189) →
    gateMemberHeadsForIntegration (integration-requests.ts:218) →
    integrateMemberHeads(gated.integrate) (integrator.ts:114). Never feed
    collect's output straight to integrate; today NO production caller wires
    the gate, so the quarantine-twin property holds only vacuously.
W2: null crefs rule = REFUSE for release-class refs — when resolveCanonicalRule
    returns no rule for a release ref, promotion must fail closed, never
    default-allow.

FAILURE PROTOCOL: any drill fail → file work item with the drill id, the
msg_id/event key used, and both machines' timestamps; do NOT flip D6.

Leader: su-3700bc41 (this session). Any free member may execute D1–D3/D5 and
report; D4 and D6 stay with the leader.
