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
W3: every bootstrapFromPeer call MUST pass selfDevicePubkey (the machine's own
    device key) — bootstrapFromPeer opts (bootstrap.ts:127, refusal at :156).
    Why: without it a squatting peer can pre-plant refs under the joiner's OWN
    namespace on a truly-fresh joiner, masquerading as the device's work/
    sigrefs before its first publish (WI-1559). The param is optional only for
    API compat; the guard is inert unless the driver passes it.
W4: a bridge/receiver accept-gate using allowedDevices MUST also set
    maxGrantedEpoch = the last verified G-0 grant (adoptHandoffToken(...)
    .nextEpoch / lease epoch) — AcceptStagingAdvanceOpts
    (staging-advance.ts:208, reject at :233). Why: the member-SET gate passes
    ANY admitted key, so an insider could self-sign epoch:1e9 and poison the
    (epoch,seq) watermark unrecoverably; the cap rejects it 'ungranted-epoch',
    bounding insider damage to within-epoch seq burn, which the next epoch
    grant recovers ((e+1,0) > (e,1e9)) (WI-1560). expectedDevice-pinned
    configs may omit it.

FAILURE PROTOCOL: any drill fail → file work item with the drill id, the
msg_id/event key used, and both machines' timestamps; do NOT flip D6.

Leader: su-3700bc41 (this session). Any free member may execute D1–D3/D5 and
report; D4 and D6 stay with the leader.

DRILL LOG (2026-07-02):
- D1 PASS (10:30Z): 4 readings 10:06→10:30Z, iMac row held the ACTIVE bucket
  throughout (staleness classifier would demote a non-refreshing row) —
  presence gossip is live tower←iMac. Fed rows carry no heartbeat field;
  bucket retention is the freshness observable.
- D2 BLOCKED (owner gate): `fed:…` machine rows are NOT addressable coord:send
  recipients (unknown_recipient). Receipts need an addressable SESSION on the
  iMac — same owner gate as D4: owner starts `psu` on the iMac.
- D3 HALF-LOOP PASS 10:0xZ: events:emit scope:hive federated:true for key
  live1-d3-probe-su3700b. GOTCHA: a harness-'*' client gets
  federation_error:ambiguous_hive_scope — ALWAYS pin `--harness papercusp`
  (mcp-call flag) on drill calls. Full loop (peer re-fire) needs an iMac awaiter.
- Review gate: both Lane C HIGH fixes RE-VERIFIED PASS 10:03Z (su-89b88).
  Release gate: fresh verdict run in flight, su-1c2e7 watching → deploy.
- D5 RUN 11:05Z (su-3700b, self-serve leg): authored probe spec
  beeId=live1-d5-probe-su3700b via scheduler:set_claim_spec (revision 1).
  Capture PASS: outbox id 5929755, table bee_claim_specs, harness_slug
  papercusp. Mig-439 stamp PASS: fed_hlc 001782989946429:00000 non-null.
  Drain leg **FAIL → WI-1564 (major)**: row stranded under workspace_id
  'default' — the tool handler omits workspaceId, the store falls back to
  DEFAULT_COORD_WORKSPACE, and outbox-drain only serves the booted
  (papercusp-workspace, papercusp) handle (5,234 drained rows there; ALL
  137 (default, papercusp) rows undrained, incl. coord_threads/
  coord_conversations from TODAY and 124 contributor_usage_events — a
  writer-side workspace-threading bug CLASS, not just claim-specs).
  Cross-machine claim-spec steering never federates via this tool as-is.
  Per failure protocol: D6 stays closed until fixed + D5 re-drilled.
  Fix dispatched to Lane A (su-89b88).
- WI-1564 FIXED (su-89b88, shared workspace resolver in both scheduler
  handlers, 18/18 regression) and DEPLOYED 13:10Z (release 2ba09c57, operator
  restarted). Same window: leader fixed the OTHER gate-red (send.test.ts
  mocks lacking stagedTargets after EI-5957 — 10/29 red on tip since 10:38Z;
  minimal mock fix 98817077f, deconflicted with su-a9faf). Gate GREEN 13:20Z,
  base 94b17b25 -> 98817077.
- D5 RE-DRILL 13:22Z — DRAIN LEG PASS: rev-2 probe spec landed under
  (papercusp-workspace, papercusp), outbox id 5929915 drained_at 13:22:13Z
  (on the peer-log, federating). Rev-1 row remains stranded under 'default'
  (backfill decision = WI-1564 follow-ups WI-1571/72/73). D5 REMOTE read-back
  (spec row HERE with the iMac's HLC stamp, i.e. iMac-authored) still needs
  an iMac session — folded into the same owner gate as D2/D4.
- OWNER GATE DISSOLVED ~14:00Z (user: "this isn't owner gated. you can do
  this."): Avis-iMac is a macOS QEMU VM ON THE TOWER (bridge macbr0) —
  `ssh aviweiss@172.31.44.2` (key auth works; Avis-iMac.local mDNS = stale
  unreachable 169.254.x — never use it). Saved to mem0 + memory file
  avis-imac-is-local-qemu-vm.
- iMac APP UPDATED by leader ~13:50Z: rsynced serve.mjs (13:28Z tower build,
  HAS PRESENCE_GOSSIP reader + stagedTargets + WI-1564 fix) +
  sidecar-preload.js + db-sql (through 443) + scripts + harness + prompts
  from tower papercusp-desktop/src-tauri/sidecar/ into
  '/Applications/Papercusp Server.app/Contents/Resources/sidecar/'.
  Backups: ~aviweiss/sidecar-serve.mjs.bak-20260702. App quit via osascript +
  `open -a "Papercusp Server"`; new host pid 23265 (port 17630); served
  flags now include papercusp-presence-gossip:false ⇒ NEW build confirmed
  running, writer still off (correct until D6). READER NOW ON BOTH MACHINES.
- iMac psu SESSION LAUNCHED ~14:22Z: `screen -dmS psu-live1 zsh -c "export
  PATH=$HOME/.papercusp/bin:$PATH; psu --no-picker --agent=claude
  --workspace=default --role=su"` (gotchas: VM has ONLY workspace 'default';
  claude not on PATH in non-login shells → ENOENT without the export; psu
  with no flags blocks on an interactive role picker that screen-hardcopy
  can't see). claude agent pid 26545 running. AWAITING: session-grain
  Avis-iMac row federating into tower coord:presence → then D2 (send+receipt),
  D4 (wake parked→live), D3 full-loop, D5 remote read-back, THEN D6.
