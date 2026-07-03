# SELF-BRIEF — solo shared-hive-git takeover (su-16e4c274)

> **STALE SNAPSHOT of a live system.** Before acting on any fleet/claim/liveness
> statement, re-run `coord:orient` and reconcile. MCP flaky → fallback:
> `node scripts/mcp-call.mjs <tool> '<json>' --client su-16e4c274-8451-41b6-9480-bf758a7bf628 --harness papercusp`
> from the canonical tree.

## Identity + mode
- **su-id:** su-16e4c274-8451-41b6-9480-bf758a7bf628 · LEADS fleet **p2p-hive-git** · harness papercusp
- **AUTO MODE ON** (owner-granted, standing, whole session).
- **ROUTE CHANGED 2026-07-03 → FLEET-PARALLEL** (owner reversed the earlier solo/no-fleet
  directive, interactive session: "can you parallelize?" → "spawn a small fleet",
  "use opus xhigh agents"). I LEAD fleet p2p-hive-git; bees run **opus:xhigh**.
  - **Bee `s-1783051060233`** → Phase 0 remainder: P-002 (settings Tauri live-verify +
    render test; m24 P-104-gated) + P-005 (rollout tiers/flag GITHUB_BRIDGE pattern, FS-D5).
  - **Bee `s-1783051087196`** → P-059 LIVE-1 cross-machine drill (unblocks p2p P-003).
  - **su-ac95e67e** (owner-spawned, NOT my fleet) → per-hive-git-and-release-gate close-out.
  - **I KEEP (solo, serial on boot.ts):** P-108 finish → P-101, then Phase 2/3 waves as
    P-101 unblocks them. Wave-2 bees spawn once P-101 lands.
  - Released my (stale) claims on P-002/P-005/P-059 so bees claim freely.
- Prior driver: su-3700bc41 (dead) led fleets p2p-dist + git-plan; all 4 p2p-dist
  lanes dead (`recorded`). Takeover note sent to su-3700bc41's inbox.
- Owner: aviynw2@gmail.com. Loop: `loop:arm { intervalSec:60 }` when idle-risk.

## The three plans (all harness papercusp)
1. **p2p-work-distribution-2026-07-02** — THE BULK. 29 items; done: P-001, P-004,
   P-006, P-110. wip (MINE): P-002, P-005, P-109; P-108 reclaim pending (stale claim
   su-c88ac610 expired 22:17 EDT — re-flip wip). todo: P-003 (gated on LIVE-1),
   P-101..P-107, P-201..P-207, P-301..P-306. **ITEMS ARE THE SPEC** (D-016) — read
   item text in full; decisions D-017/D-018 = ratified designs (binding build notes).
   Designs: docs/plans/DESIGN-P-006-federation-scope-2026-07-02.md,
   DESIGN-P-108-results-channel-2026-07-02.md,
   DESIGN-p2p-P109-foreign-worktree-git-plumbing-2026-07-02.md.
2. **cross-machine-coord-parity-and-trust-2026-07-01** — only **P-059** (wip, mine):
   LIVE-1 drill D2–D6 per plan ##Now. Runbook: docs/plans/LIVE-1-rig-runbook-2026-07-02.md.
   VM = QEMU iMac `ssh aviweiss@172.31.44.2` (NEVER Avis-iMac.local); VM coord via
   sidecar node + /tmp/mcp-call.mjs, port from VM ~/.papercusp/endpoint-ipc.json
   (changes per app restart), --client su-live1-imac-probe --workspace
   papercusp-workspace. VM PG: tunnel per embedded-pg.json, harness_app/harness_app_pwd.
   ⚠ su-a1a71fca is LIVE debugging the Mac app on the same VM — coordinate.
   Completing P-059 unblocks p2p P-003. Final leg: flip PRESENCE_GOSSIP writer flag +
   30-min soak → P-059 done → plan complete.
3. **per-hive-git-and-release-gate-2026-06-29** — all 19 items done; ##Now stale.
   To close: canary-verify per-hive gate on oddsmith-hive live, flip
   PER_HIVE_RELEASE_GATE default ON (libs/flags/src/types.ts:261 + remove
   types.ts:1268 dark entry + KNOWN_DARK_FLAGS shrink), update ##Now, plan complete.

## In-flight build state (verified green 2026-07-02 22:12 EDT)
- Baseline: 106 unit (scope-disclosure 17, announce 26, scope-repo 18,
  results-receipt 17, p2p settings 16, grant-store 12) + 25 integration
  (foreign-merge-admission 16, foreign-mirror-quarantine 7, scope-repo 2) ALL GREEN.
- **P-108 remaining:** boot/connection wiring — open admitted scoped cores, serve-side
  roster gate, re-announce on roster change (D-017 n1: LIVE connections re-announce);
  needs roster seam (P-101 directory / P-001 grants store). Landed: scope-repo.ts,
  results-receipt.ts, announce.ts scoped_logs field, hyperbee/scope-disclosure.ts.
- **P-109 remaining:** leg i guard policy (apps/operator/scripts/hooks/cc/
  pretooluse-locks-acquire.sh = source of truth; host DENY under foreign root,
  foreign session allow ONLY own registered root, fail-closed via
  p2p_foreign_workspaces registry); leg ii foreign-git-sync routine (separate
  routine `system:foreign-git-sync`, origin author+committer stamping, 4 trailers,
  fail-closed on attestation, DISJOINT-scope regression test); leg iii publish
  wiring (mirror → per-scope repo per FS-D3/RC-D1(b), canonical merges import via
  refs/foreign/<scope>/ tracking refs, sigref originClaim bump CONFINED to
  scope-repo sigrefs). Landed: mig 467 p2p_foreign_workspaces, lib/p2p/
  foreign-workspaces.ts, foreign-clone.ts, hive-git/foreign-mirror-quarantine.ts.
- **P-002 remaining:** Tauri live-verify, page render test, m24 live view (P-104-gated
  — may defer m24 with note). FLAGS.P2P default-ON landed.
- **P-005:** tier flag GITHUB_BRIDGE-pattern default-ON; record FS-D5 (5.4 per-scope
  crypto = HARD GATE for tier 2 + X1 loopback boundary) in item text.

## Discipline reminders
- tsc: `npx tsc --noEmit -p .` directly; ~333-error pre-existing baseline in
  operator-core — grep YOUR files only.
- No git add/commit/push (git-sync owns it). Canonical staging tree only.
- Migrations ≥469 (467/468 taken), via db:migrate runner; pull-schema after.
- Sibling live agents: su-f5d2888e (federation-release-hardening, touches
  projections/tests), su-173cbb09 (su-loop-capability-parity), su-a1a71fca (VM Mac app).
- Work-item ledger: plan-item claims held via plans:set-status wip (auto-claim).

## PROGRESS LOG (update each unit)
- 2026-07-02 ~22:50 EDT: **P-109 DONE** (all 4 legs; see plan item note for the
  full manifest). New files: lib/p2p/foreign-git-sync.ts+test, foreign-guard.ts+test,
  routines/foreign-git-sync-action.ts, endpoint-route/routes/su-locks/foreign-guard.ts,
  hive-git/foreign-publish.ts+integration.test; edited: foreign-workspaces.ts (baseSha,
  listLiveForeignRoots, getForeignWorkspaceByOffer, setForeignWorkspaceBaseSha),
  foreign-clone.ts (records base_sha), foreign-mirror-quarantine.ts (rangeAnchors),
  sigrefs.ts (v2 originClaim + buildScopeSigrefs + accept confinement),
  pretooluse-locks-acquire.sh (foreign guard block), register-system-actions.ts,
  routes/index.ts. Mig 470 APPLIED (psql + schema_migrations row w/ sha256) +
  pull-schema ran. ⚠ NOTE: a peer created a COLLIDING 470-scout-routed-ideas-origin.sql
  (filename-keyed runner → harmless, but flag if it bites).
- 2026-07-03 ~03:35Z: P-108 build step 1 LANDED (UNTESTED): lib/sync/hyperbee/scope-cores.ts
  — ScopeCoreRegistry (§5.1 own scoped logs via ownScopeLogName; §5.3 serve gate
  serveScopeOnConnection w/ cache-bypassing IsScopeMember re-check + fail-closed refusals;
  X6 epoch fence in admitRemoteScopedCore; revokePeerFromScope; late-admit mesh attach).
  NEXT: unit tests for it (fake store/muxer), then scope-roster.ts, swarm.ts conn-ctx,
  boot.ts wiring — per § P-108 GROUNDED SERVE-GATE DESIGN above. tsc NOT yet run on it.
- Peer su-ac95e67e (owner-spawned) took the per-hive-git-and-release-gate close-out lane
  (my old task #2) — it is THEIRS now; I keep all p2p + P-059.
- P-108 claimed wip (mine). ALL tests green at last check; tsc clean for my files
  (pre-existing baseline errors in routes/index.ts ALL_ROUTES + ~333 others are NOT mine).

## ⚠ SIGNALS — RESOLVED
- git-sync FAULTING on shared-hive-test + oddsmith: **TRIAGED + RESOLVED (WI-1721,
  2026-07-03 ~03:30Z)**. Root cause: repeated papercup-staging-api restarts
  (22:20/22:27/22:30 EDT) killed in-flight DBOS git-sync fires → reaper
  cancel/requeue → last_error persisted 2 watchdog sweeps → errorStall alarm
  (known WI-1415 class). Both lanes verified healthy (status 'nothing',
  last_errors [], synced ~03:15Z). shared-hive-test broadcast RECOVERED;
  oddsmith alert flag self-clears next sweep (verify RECOVERED broadcast on a
  later wake — if oddsmith still shows watchdog_alerted:true after ~03:45Z,
  investigate why the sweep skipped it). No code defect.

## P-108 GROUNDED SERVE-GATE DESIGN (2026-07-03 ~03:50Z — verified against node_modules, build NEXT)
Corestore 7.9.2 facts (verified in source):
- `store.replicate(socket)` serves EVERY open/stored core to ANY connection via a lazy
  `ondiscoverykey` → `_attachMaybe` path; NO per-core ACL. `detachFrom` is re-attachable by
  a hostile re-request → in-store detach is FAIL-OPEN. So 5.3 CANNOT live inside the main store.
- protomux `pair()` is a Map SET keyed (protocol,id): a SECOND corestore's `replicate()` on the
  same stream CLOBBERS the first's hypercore/alpha ondiscoverykey → never replicate() two stores
  on one socket.
- THE MECHANISM (fail-closed, public APIs only): scoped cores live in ONE separate Corestore
  (`<substrate>/scoped`, own primary key — fine, keys are announce-disclosed) that is NEVER
  `replicate()`d. Serving = EXPLICIT per-core×connection attach: `session.replicate(muxer)`
  (Protomux instance → `_attachToMuxer` → `core.replicator.attachTo(mux)`, registers NO
  ondiscoverykey); revoke = `session.replicator.detachFrom(mux)` (getter at hypercore
  index.js:458). With no lazy path, an unattached/detached scoped core is UNSERVABLE = 5.3.
- Attach set per member connection: own scope log + ALL admitted remote cores of that scope
  (mesh replication within roster). New remote admitted later → attach to all existing
  member conns of that scope. Track per-muxer attach state in a Map, cleanup on stream close.
- 5.1 own scoped logs: `scopedStore.get({ name: 'peer-log:scope:'+formatScopeId(s) })`
  (openOwnLog pattern, peer-log.ts:200).
- 5.2 directed follow-up announce: extend swarm.ts onmessage → pass conn ctx `{ send, muxer }`
  as OPTIONAL 2nd arg to onAnnounce (backward-compat). boot.ts onAnnounce after admitPeer:
  (a) admitScopedAnnounce(frame.scoped_logs, selfUid, isScopeMember) → open remotes in scoped
  store + attach on this muxer + recordBootEvent+telemetry counter per refusal; (b) directed
  follow-up: discloseScopedLogsForPeer(own, peerUid, roster) → content-compare vs lastDisclosed
  per connection (LOOP DAMPING — only send when changed) → conn.send(fresh signed announce w/
  scoped_logs). First announce stays identity-blind (no scoped_logs).
- D-017 n1: boot handle gains `redisclose()` → computeRedisclosure(liveConns, own, roster) →
  send per changed peer + DETACH cores for `removed` entries immediately.
- ROSTER SEAM (until P-101): new lib/p2p/scope-roster.ts over grant-store, DIRECT PG reads (C6):
  member(fleet:<O>/<slug>, U) = (U === O) OR active grant {grantor:U, granteeKind:'fleet',
  granteeRef:'<O>/<slug>' — VERIFY exact granteeRef format vs gh- prefix ('gh-777/widgets' in
  P-109 fixtures!), capability 'work-offer'}. listParticipatingScopes(selfUid) = distinct active
  fleet granteeRefs where owner==self OR (grantor==self AND work-offer). scope_epoch on our
  disclosures = OUR grantor epoch (p2p_grantor_epochs; X6 high-water per grantor); 5.4 true
  scope-epoch is tier-2 (FS-D5).
- BUILD ORDER: (1) lib/sync/hyperbee/scope-cores.ts registry+serve-gate + unit tests (fake
  muxer/cores); (2) lib/p2p/scope-roster.ts + tests; (3) swarm.ts conn-ctx (+ tests);
  (4) boot.ts wiring + redisclose + boot test. Counters: recordBootEvent + emitTelemetry
  (M15 unauthenticated→counters); receipts via lib/p2p/receipts.ts emitP2pReceipt for
  authenticated serve refusals.

## Next actions (in order)
1. **P-108 boot/connection wiring** — THE WIRING MAP (surveyed 2026-07-02 ~23:00):
   - Disclosure layer is PURE + landed: hyperbee/scope-disclosure.ts
     (packScopedLog/parseScopedLog, discloseScopedLogsForPeer, admitScopedAnnounce,
     computeRedisclosure — all unit-tested). announce.ts already carries + validates
     the sig-covered `scoped_logs?: string[]` field.
   - Connection host = lib/sync/hyperbee/boot.ts (~3.2k lines): `announceBody` built
     ~line 2752 (static body; buildOurAnnounce factory re-stamps ts/sig per
     connection), inbound processing = `onAnnounce` ~line 2278 (verifyAnnounceDetailed
     → admit decision). Swarm pairing = lib/sync/hyperbee/swarm.ts (joinHarnessSwarm;
     onPeerConnected callback exists).
   - KEY INSIGHT: the FIRST announce is identity-blind (same body to every peer), so
     per-peer scoped disclosure must ride a FOLLOW-UP directed announce AFTER the
     peer's announce is admitted (we then know their github_user_id + connection).
     Track lastDisclosed per live connection (LiveConnectionDisclosure).
   - WIRE POINTS: (1) post-admission in onAnnounce/peer-pair path: send follow-up
     announce w/ scoped_logs = discloseScopedLogsForPeer(own, peerId, isScopeMember);
     (2) receive: admitScopedAnnounce(frame.scoped_logs, selfId, isScopeMember) →
     open/replicate admitted scoped cores into the store + a COUNTER per refusal;
     (3) serve gate (FS-D6/§5.3): before serving a scoped core on a connection,
     cache-BYPASSING membership re-check; on revocation STOP serving at once;
     (4) roster mutation hook → computeRedisclosure(liveConns, own, isScopeMember)
     → immediate re-announce per changed peer (D-017 n1);
     (5) roster seam: isScopeMember over P-001 grant-store (lib/p2p/grant-store.ts)
     keyed by numeric gh id — scope fleet:<uid>/<slug> membership = live grant whose
     grantee is that fleet-slug (verify semantics against grant-store exports) —
     REPLACE with P-101 directory roster when built.
   - "own" scoped logs: where do WE declare per-scope log cores? Likely need a small
     registry of (scope → own log core key + epoch) — check corestore usage in boot.ts
     for how own log cores are created (ownLog.keyHex pattern) and mint per-scope
     cores via the same store.
2. Task 2: per-hive canary verify + PER_HIVE_RELEASE_GATE flip + plan close.
3. P-059 LIVE-1 drill (check su-a1a71fca on the VM first).
4. P-002 remainder (Tauri live-verify, render test, m24 note), P-005 flag/tiers.
5. P-101..P-107 (P-101 fleet directory next — it feeds P-108's roster + P-103/P-104).
6. Phase 2 (P-201..P-207), Phase 3 (P-301..304, P-306 sim harness BEFORE P-305 LIVE-2).
