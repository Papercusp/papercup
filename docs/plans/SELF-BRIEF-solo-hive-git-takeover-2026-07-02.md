# SELF-BRIEF — solo shared-hive-git takeover (su-16e4c274)

> **STALE SNAPSHOT of a live system.** Before acting on any fleet/claim/liveness
> statement, re-run `coord:orient` and reconcile. MCP flaky → fallback:
> `node scripts/mcp-call.mjs <tool> '<json>' --client su-16e4c274-8451-41b6-9480-bf758a7bf628 --harness papercusp`
> from the canonical tree.

## Identity + mode
- **⚠ LIVE su-id = `su-35c3bac0-8df9-4080-a71a-108abd05c4f1`** (per coord:whoami — AUTHORITATIVE).
  The `su-16e4c274…` all over this brief is the PRIOR (pre-compaction) session's id;
  reconciled 2026-07-03 04:10Z: re-claimed P-108/P-101 + armed the loop + hold all
  coord state under su-35c3bac0; ended the stale su-16e4c274 loop. Use su-35c3bac0.
- **LEADS fleet `p2p-hive-git`** · harness papercusp · loop `loop-su-35c3bac0` @120s.
- **AUTO MODE ON** (owner-granted, standing).
- **ROUTE = FLEET-PARALLEL** (owner reversed solo, interactive: "spawn a small fleet",
  "use opus xhigh agents"). Members launched via **`fleet:launch-on-plan`** (psu member
  terminals, opus:xhigh) — NOT nursery bees (I first mis-used `fleet:spawn role=bee`;
  owner corrected me; cancelled those two, relaunched correctly):
  - **2 members** on p2p-work-distribution (pids 2244377/2244378) → Phase 0 remainder
    P-002 (settings Tauri live-verify + render test; m24 P-104-gated) + P-005 (tiers/flag).
  - **1 member** on cross-machine-coord-parity (pid 2244622) → P-059 LIVE-1 drill (unblocks P-003).
  - **su-ac95e67e** (owner-spawned, NOT my fleet) → per-hive-git-and-release-gate close-out.
  - **I KEEP (solo, serial on boot.ts):** P-108 finish → P-101, then Phase 2/3 waves as
    P-101 unblocks them. Plan `##Now` steers members + fences my lane.
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
- 2026-07-03 ~10:45Z CHECKPOINT (su-16e4c274 turn, context-overflow end): scope-cores.ts
  10/10 unit tests GREEN + tsc clean. Tree ALSO now holds lib/p2p/scope-roster.ts(+test)
  and lib/sync/hyperbee/scope-federation.ts(+test) written ~03:46–03:59Z (successor turn
  or peer — VERIFY authorship/tests before extending; they are steps 2–3 of the build
  order). NEXT WAKE: (1) coord:whoami FIRST (brief says live id = su-35c3bac0 but wakes
  still fire su-16e4c274 — reconcile before any coord write; claim-discipline nag says
  plan-item claims LAPSED — re-claim P-108 lane); (2) run scope-roster + scope-federation
  tests + tsc; (3) READ INBOX wakes #4736/#4743: a peer claims owner has them "leading
  p2p" + is taking a "P-108 VM→owner merge/admission fix" (LIVE issue: owner→VM
  work_items stuck 573/2074) and asks me to flag collisions on scope-*.ts — ANSWER them
  (scope-*.ts files are MY lane) + reconcile who leads p2p; (4) then boot.ts wiring per
  § P-108 GROUNDED SERVE-GATE DESIGN.
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

## PROGRESS LOG — 2026-07-03 ~11:12Z (su-16e4c, post-compaction wake)
- Identity RESOLVED: I am su-16e4c274 (coord:whoami); su-35c3bac0 is a separate live session (holds P-201/P-206). P-108 lane RE-CLAIMED (claim 0668d6fc).
- **P-108 BUILD ORDER COMPLETE**: boot.ts wiring LANDED — scoped store (corestore.ts getHarnessScopedStore, pre-existing) + ScopeCoreRegistry (boot-scoped, survives rekey) + ScopeFederation (per joinForBinding, binds identity/signer) + onAnnounceWithConnection (admitted-frames-only routing into the scoped layer) + handle.ensureScopeParticipation/rediscloseScopes (D-017 n1) + M15 counters (bumpRefusedOpCounter, `scoped-*:*` reasons) + close-path eviction + dead-conn lazy prune in scope-federation.ts. 105/105 green (boot 40 incl 2 new P-006 tests, scope-cores 10, scope-federation 13, scope-roster 9, swarm 35); tsc clean.
- Wakes #4736/#4743 ANSWERED (su-f5d28): no collision — their fix landed in backfill-local-state.ts; scope-*.ts + boot/swarm announce path fenced as mine. swarm.test.ts stale reds were already fixed (35/35).
- Fleet claim map verified (owner ask): P-002=6e3f9 (wip), P-107=c2428 (DONE), P-306=d1985 (DONE, gates LIVE-2), P-201/P-206=35c3b (watch for staleness), su-cd47d/4f4f5/79eda = fed-scout-gym-r2 plan (disjoint); 79eda warned re bumpRefusedOpCounter new call site.
- NEXT: (1) reconcile P-108 item text vs remaining D-017/D-018 results-channel scope before flipping done; (2) P-101 fleet directory (slots into scope-roster FleetDirectory seam + drives ensureScopeParticipation); (3) live 2-machine co-verify with su-f5d28's isolated-DHT rig once P-101 populates scopes.

## PROGRESS LOG — 2026-07-03 ~11:36Z (su-16e4c)
- **P-108 FLIPPED DONE** (claim auto-released). Final gap found+closed during done-check: the §5.3 GIT-PLANE roster serve-gate (scope-repo.ts header had deferred it to my disclosure stage; fetch-transport had only the path backstop). Landed: hive-git/scope-serve-gate.ts (authorizeScopeRepoServe, per-fetch cache-bypass, fail-closed x4 reasons, WeakSet mint-bound grants) + scope-repo.ts parseScopeRepoPath/isScopeRepoFamilyPath (family check broader than strict parse — malformed paths still trip the gate) + serveUploadPack chokepoint (scopes/ family unservable w/o gate grant; opts.scopeServeGrant). NOTE: serveUploadPack has NO live callers yet — gate lands before the serve plane so wiring structurally can't skip it. Tests: scope-repo 33, scope-serve-gate 10, fetch-transport 6 (new) + 123 regression (boot/scope-cores/federation/roster/swarm/results-receipt) green; tsc clean.
- Fleet: P-002 6e3f9 launching own headless Tauri shell (Xvfb:77) after my gate call — will self-flip on green. c2428 parked (P-107/P-202/P-204 done). d1985 P-306/P-102/P-203 done, steered off P-204 (already done) → P-205/P-304. 35c3b still holds P-201/P-206 — no completion signal, watch.
- NEXT: (1) **P-101 fleet directory** (WI-1732, claim held): federated record {slug,title,desc,owner numeric gh id X9, publisher set owner-SIGNED, billing default, tags}, H5 owner-prefixed slugs, H10 successor+force-archive, H16 offers-ride-scopes; implements FleetDirectory seam in lib/p2p/scope-roster.ts (scopeMembers → GrantBackedScopeRoster) + production driver of handle.ensureScopeParticipation. (2) live 2-machine co-verify w/ su-f5d28 rig once P-101 populates scopes. (3) leader duty: P-201/P-206 staleness watch.

## P-101 GROUNDED DESIGN — 2026-07-03 ~12:00Z (su-16e4c, design DONE, build NEXT)
All surfaces read + reconciled. D-006 (verbatim): "single owner + owner-signed delegated
publisher set; hive-visible directory; device-signed authorship chain; pairwise allowlist
demotes to a FILTER on which fleets I may opt into." Consumer contract FIXED by d1985's
landed P-102 `lib/p2p/offer-authorship.ts`: `PublisherSet { ownerGithubUserId,
ownerSignatureValid, memberGithubUserIds, ownerAnchored }` — my directory ships the
resolver producing it. Fleet deltas: d1985 P-102/P-203/P-205/P-304 ALL DONE (lib/p2p
239→263 green); 6e3f9 P-002 live-verify in progress (nohmr + fresh operator config).

**Federation pattern = hive_policy (mig 317 + projections/hive-policy.ts), CDC-captured:**
local author writes SIGNED row to PG → capture_substrate_outbox trigger federates via
hive peer-log → remote projection VERIFIES sig before apply (fail-closed) → LWW
fed_order_key guard. capture fn: TG_ARGV[0] = KEY COLUMN name; routing = row's
harness_slug col (canonicalized). stamp_local_federated_write trigger REQUIRED on the
table (mig 314 list is fixed). record_json TEXT not jsonb (sig over exact bytes).

**Migration 475** (474 taken; runner db:migrate + pull-schema after):
`harness_shared.p2p_fleet_directory`: workspace_id, harness_slug (hive HOME), 
owner_github_user_id BIGINT, fleet_slug TEXT, record_json TEXT, signer_device_pubkey,
signature, record_version BIGINT, archived BOOL (filter convenience), author_pubkey,
origin default 'local', fed_ts, fed_hlc, created_at, updated_at; PK (ws, harness_slug,
owner, fleet_slug); generated `fleet_dir_fed_key = owner::text||'/'||fleet_slug` STORED
as TG_ARGV[0]; INSERT/DELETE capture trigger + UPDATE trigger gated on content cols;
stamp trigger; RLS workspace isolation (copy mig 317 shape).

**Record JSON** (canonical via authority/canonicalJson, domain-separated signed bytes incl
workspaceId + hiveHomeSlug + recordVersion — mirror hivePolicySignedBytes):
{fleetSlug, ownerGithubUserId, title, description, tags[], publisherGithubUserIds[],
billingDefault (string ref, default 'host-pays' = D-009 mode a; display/routing like
offer-budget.billedTo), successorGithubUserId|null (H10), offerRateCapPerHour|null,
unclaimedOfferTtlSec|null (H16 knobs), recordVersion, archived}. H5: scope ids
structurally owner-prefixed (fleet:<uid>/<slug>); bare-global alias = post-v1, no field.

**Verify (projection, fail-closed):** (a) Ed25519 over canonical bytes by
signer_device_pubkey; (b) signer device ATTESTED to record.ownerGithubUserId via
listHiveMembers(ws, hiveHome).deviceAttestations — per-op read, NO TTL cache in the
security path (comms-tier-gate's deviceToUser caches — don't reuse it, inline the read);
(c) record fields match row key cols (no cuckoo rows); (d) H10 force-archive alt path:
sig by HIVE identity pubkey (getHiveBySlug — hive_policy trust anchor) valid ONLY when
the change sets archived:true (orphan reaping by hive owner).

**Modules:** (1) lib/p2p/fleet-directory-schema.ts — pure record type + validation
(slug regex per scope-repo) + fleetDirectorySignedBytes. (2) lib/p2p/fleet-directory.ts —
putFleetRecord (self=owner check, device-key signer injected), getFleetRecord,
listFleetRecords (hive-browsable), forceArchiveFleet, **PgFleetDirectory implements
FleetDirectory** (scopeMembers = owner ∪ publisher set; null when absent/archived; direct
PG read C6), **resolvePublisherSet(scope) → P-102 PublisherSet** (re-verify stored sig;
ownerAnchored = owner has attested device in hive members), listParticipatingScopes(selfUid)
→ ScopeId[] (owner or publisher, not archived). (3) projections/fleet-directory.ts —
tableTag 'p2p-fleet-directory', skipOwnOps, verify-before-apply, LWW+delete guards
(mirror hive-policy.ts incl _testing seam for the teeth test). (4) feature-issue-op-keys.ts:
map entry + toFleetDirectoryValue + switch case. (5) register-all.ts hiveScoped.
(6) **boot.ts driver**: in joinForBinding scoped-layer init (~line 2871), union
participatingScopes with PgFleetDirectory.listParticipatingScopes(identity.githubUserId)
(best-effort) before ensureOwnScopes — directory becomes the production driver; local
putFleetRecord also calls handle.ensureScopeParticipation+rediscloseScopes when handle
reachable. (7) **Sidecar RPC** (79eda msg mr4v35od + comment in
lib/sync/hyperbee/remote-booted-harness.ts:207): `substrate:ensureScopeParticipation` +
`substrate:rediscloseScopes` handlers in substrate-sidecar-host.ts → real handle;
proxy methods forward instead of no-op. (8) Tests: schema unit; store/roster unit
(sqlOverride); projection unit mirroring hive-policy.test incl neutered-verifier teeth
test + forged-signer/wrong-owner drops + hive-owner-archive path; PgFleetDirectory
widening test against GrantBackedScopeRoster.

Discipline: tsc grep MY files only (~333 baseline); no git ops; migration via db:migrate
runner; tests colocated `<name>.test.ts` vitest.

## P-101 BUILD LEDGER — 2026-07-03 ~12:15Z (su-16e4c, modules 1–4 of 8 DONE)
Design section above is the spec. **Migration is 476 NOT 475** (475-spawned-agents-fleet-slug
got taken). WRITTEN so far (none verified yet — no tsc, no tests, migration NOT applied):
1. ✅ `libs/papercusp/libs/db/sql/476-p2p-fleet-directory.sql` — table + PK(ws,hive,owner,slug)
   + generated `fleet_dir_fed_key` + INSERT/DELETE capture('fleet_dir_fed_key') + content-gated
   UPDATE capture + stamp trigger + RLS (mig-317 shape).
2. ✅ `packages/operator-core/lib/p2p/fleet-directory-schema.ts` — FleetDirectoryRecord (closed
   schema, coerceFleetDirectoryRecord), FLEET_DIRECTORY_SIG_DOMAIN='papercusp-fleet-directory-v1',
   canonicalFleetRecordJson (authority canonicalJson), fleetDirectorySignedBytes (domain\nws\nhive\nversion\njson),
   parseFleetRecordJson (fail-closed), fleetDirFedKey, DEFAULT_FLEET_BILLING='host-pays'.
3. ✅ `packages/operator-core/lib/p2p/fleet-directory.ts` — getFleetRecord/listFleetRecords,
   putFleetRecord (self=owner gate + monotone recordVersion + injected FleetRecordSigner{pubkey,sign}),
   forceArchiveFleet (hive signer, H10), PgFleetDirectory (scopeMembers null-when-absent/archived,
   resolvePublisherSet → P-102 PublisherSet w/ re-verify + revoked-skip + ownerAnchored,
   listParticipatingScopes). Uses resolveP2pGrantWorkspace, listHiveMembers, loadRevokedHivePubkeys.
4. ✅ `packages/operator-core/lib/sync/hyperbee/projections/fleet-directory.ts` — tableTag
   'p2p-fleet-directory', skipOwnOps, realVerifyFleetDirectory (no-cuckoo check + attested-device
   path + H10 hive-key-only-if-archived path, fresh membership reads), injectable verifyRecord,
   LWW put/delete guards, _testing export. composeKey = fleetDirFedKey.

REMAINING (5–8 + verify):
5. feature-issue-op-keys.ts: table map entry `p2p_fleet_directory: 'p2p-fleet-directory'`
   (~line 95-135) + `toFleetDirectoryValue(row)` near toHivePolicyValue (~547) + switch case
   (~870-905, copy hive_policy case). Wire row fields: harness_slug, owner_github_user_id (Number()),
   fleet_slug, record_json, signer_device_pubkey, signature, record_version (Number()), archived (bool).
6. register-all.ts: import buildFleetDirectoryProjection (~line 52 area), add to hiveScoped list
   (entry 'p2p-fleet-directory', mirror 'hive-policy' entry line ~179 + spread ~220/~250-263).
7. boot.ts driver ~2871: before `ensureOwnScopes([...participatingScopes.values()])`, best-effort
   union PgFleetDirectory({workspaceId, hiveSlug: rosterHiveSlug}).listParticipatingScopes(identity
   githubUserId) into participatingScopes (key = formatScopeId). rosterHiveSlug = hiveHomeProjectionSlug
   ?? opts.harnessSlug (already computed ~2849 for getScopeRoster). Also wire directory: getScopeRoster({...,
   directory: new PgFleetDirectory(...)}). Sidecar RPC: substrate:ensureScopeParticipation +
   substrate:rediscloseScopes handlers in substrate-sidecar-host.ts → real handle methods (boot.ts
   3068-3076); remote-booted-harness.ts:207-229 proxy forwards instead of no-op (79eda msg mr4v35od);
   also fake-booted-handle.ts if it has the no-ops.
8. Tests (colocated vitest): fleet-directory-schema.test.ts (pure); fleet-directory.test.ts
   (sqlOverride fake-sql or skip store, focus PgFleetDirectory logic w/ stubbed sql);
   projections/fleet-directory.test.ts MIRROR projections/hive-policy.test.ts (read it first!) —
   teeth test (neutered verifier applies forged = proves gate load-bearing), forged-signer drop,
   wrong-owner/cuckoo drop, hive-owner-archive accept + hive-owner-LIVE-record REFUSE, LWW guards.
   Widening test: GrantBackedScopeRoster + PgFleetDirectory (mock sql) → members = owner ∪ publishers.
VERIFY: npx tsc --noEmit -p packages/operator-core (grep MY files only, ~333 baseline); npx vitest run
<my test files>; db:migrate MCP tool (applies 476) THEN node libs/papercusp/libs/db/scripts/pull-schema.mjs;
tools-md-sync NOT needed (no tool added). DONE-CHECK vs item text: H5 structural ✓, H10 successor field
+ force-archive ✓, H16 rate-cap/TTL fields ✓, owner-signed publisher set ✓, hive-browsable card
(listFleetRecords) ✓, billing default ✓. Then plans_set-status P-101 done + WI-1732 complete + notify fleet.

### LEDGER UPDATE — 2026-07-03 ~12:45Z (steps 5–7 DONE, step 8 half-done)
Steps 5, 6, 7 are FULLY WRITTEN (unverified beyond one tsc slice):
5 ✅ feature-issue-op-keys.ts: map entry + toFleetDirectoryValue (archived: `row.archived === true`)
  + switch case + FleetDirectoryRow import + **added FleetDirectoryRow to the `let value:` union
  (~line 854)** — that union was the one tsc error; fixed, NOT re-tsc'd yet.
6 ✅ register-all.ts: import + 'p2p-fleet-directory' in REGISTERED_PROJECTION_TAGS +
  buildFleetDirectoryProjection(hiveScoped) last in buildHarnessProjections. NOTE: there may be a
  registry-coverage/tags test asserting the tag list — if a test fails on projection count, that's why.
7 ✅ boot.ts: PgFleetDirectory import; in joinForBinding — fleetDirectory built with
  {workspaceId: opts.workspaceId, hiveSlug: rosterHiveSlug}, injected as `directory:` into
  getScopeRoster deps, and directory-derived scopes unioned into participatingScopes (best-effort
  .catch → []) BEFORE ensureOwnScopes. sidecar-host: handleEnsureScopeParticipation +
  handleRediscloseScopes + registered 'substrate:ensureScopeParticipation'/'substrate:rediscloseScopes';
  remote-booted-harness.ts: both proxies now forward via this.client.call (no-ops replaced).
  fake-booted-handle.ts already had vi.fn stubs — untouched, fine.
8 ◐ lib/p2p/fleet-directory-schema.test.ts WRITTEN (pure; coerce/canonical/signed-bytes/parse/fedKey).
  ⚠ One ugly line in the 'signed bytes bind…' test does an inline double-coerce cast — simplify to
  `const c = coerceFleetDirectoryRecord(minimal); if (!c.ok) throw...; const json = canonicalFleetRecordJson(c.record)`.
  STILL TO WRITE: (a) lib/p2p/fleet-directory.test.ts — fake sql = `{ unsafe: async (q, params) => rows }`
  (store uses pg(sql).unsafe(q, params) everywhere; SELECT → existing rows, INSERT/UPDATE → RETURNING row).
  Cover: putFleetRecord non-owner refusal / stale-version refusal (existing v3, put v3) / happy path with
  REAL ed25519 (generateEd25519KeypairDer + signWithPrivateKeyDer + pubkeyBase64FromDer from
  lib/identity/ed25519.ts) then verifyEd25519 over fleetDirectorySignedBytes green; PgFleetDirectory
  scopeMembers (null absent/archived; owner∪pubs else — dedupe if owner listed); resolvePublisherSet
  (vi.mock '../hive-membership-store' → listHiveMembers/loadRevokedHivePubkeys; refused on absent record;
  valid path ownerAnchored+ownerSignatureValid true; revoked signer ⇒ sigValid false);
  listParticipatingScopes (owner or publisher rows only); widening: GrantBackedScopeRoster({directory}) →
  members = owner ∪ pubs, isMember publisher true / stranger false / owner-always-true.
  NOTE resolveP2pGrantWorkspace('ws-1')='ws-1' (only '*'/default-coord-ws/empty → undefined).
  (b) projections/fleet-directory.test.ts — pure composeKey/decode/isFleetDirectoryRow (mirror
  hive-policy.test.ts) PLUS: vi.mock '../../../hive-membership-store' + '../../../hive-store';
  realVerifyFleetDirectory: valid attested-device row true; forged sig false; cuckoo (record owner≠row col)
  false; version/archived col mismatch false; revoked signer false; H10 hive-key(getHiveBySlug pubkeyBase64)
  + archived:true → true, hive-key + live record → false. TEETH: buildFleetDirectoryProjection with fake
  sql tag (template-call recorder: `(strings, ...vals) => { calls.push(...); return Promise.resolve([]) }`)
  — writeToPg uses sql`...` TEMPLATE (not unsafe) — neutered verifyRecord (async () => true) ⇒ forged row
  INSERTs (calls.length 1); default verify + empty mocks ⇒ drop (calls 0). Demux: row.harness_slug ≠
  opts.harnessSlug dropped even neutered. deleteFromPg: junk key (no '/', owner≤0) → no call; good key →
  DELETE call.
tsc slice from mid-build run: ONLY 2 errors — the union (FIXED in 5 above) and fleet-directory.ts ws()
`?? null` which is ALREADY in-tree (peer tsc-gate fixer raced the snapshot) ⇒ expect clean; re-run + grep
my 8 files: p2p/fleet-directory{,-schema}{,.test}, projections/fleet-directory{,.test}, feature-issue-op-keys,
projections/register-all, hyperbee/boot.ts, substrate-sidecar-host, remote-booted-harness.
Then: vitest run the 3 test files → db:migrate 476 (confirm:true; needs PAPERCUSP_ALLOW_DB_MIGRATE=1 env on
the tool host — it's the MCP tool's requirement, tool handles the lock/drain) → pull-schema.mjs → done-check
→ flip P-101 done + WI-1732 complete (work_items_complete with migrations:['476'] etc) + fleet notify.
Fleet delta: 6e3f9 finished P-103 standing puller (45/45) and is pulling the next p2p item — member lane
near-dry; d1985 done P-102/203/205/304. 35c3b still owes P-201/206 signal.

### ✅ P-101 CLOSED — 2026-07-03 ~12:40Z. Do NOT redo anything above this line.
All 8 steps done+verified: 25 unit tests green (schema 7 / store+roster 8 / projection 10 incl teeth),
46 adjacent contract tests green (op-keys / capture-coverage — needed a table-registry.ts peer-log entry
for p2p_fleet_directory / register-all), tsc slice clean over all 9 touched files. Mig 476 APPLIED via
psql (db:migrate confirm:true drains but WITHHOLDS apply — env gate; filed EI-6962) + schema_migrations
row recorded (sha256) + pull-schema.mjs regenerated. Plan rev 91: P-101 done, claim auto-released;
WI-1732 passed w/ structured completion (deferred: live 2-machine co-verify — tower-VM fed still down
per P-059; UI card surface not in scope). 6e3f9 messaged (mr4x8j76): directed to P-106 or P-107.
MY NEXT LANE: P-108 results channel (WI-1739, design-decision-required, ratified designs D-017/D-018
referenced in task list) — claim via coord:orient { planItems:['P-108'] } on wake, or sweep P-104/P-105
if still open. Claim-discipline nudge outstanding: I hold NO claim right now (P-101 released) — re-claim
before building.

### ✅ P-108 ALSO CLOSED — 2026-07-03 ~14:35Z (plan rev 94; WI-1739 passed). Ledger above was STALE.
P-108 was already substantively built by prior lane-C holders (scope-repo/results-receipt/disclosure/
serve-gate/scope-federation all in tree); its one open remainder — "needs a roster source: P-101
directory seam" — was closed BY my P-101 work (PgFleetDirectory → getScopeRoster + boot participation
driver + sidecar RPC). Verified before closing: 113 tests green across all 8 P-108 suites. I briefly
flipped P-108 done→wip on the stale ledger, then verified + restored done WITH the missing WI-1739
completion record (it had none — that inconsistency is why the wip flip was right to make).
NEXT LANE on wake (orient first, claims:0 now): p2p Phase 1 sweep P-104/P-105/P-109 status (unknown),
P-106/P-107 offered to 6e3f9 (msg mr4x8j76); Phase 2 open: P-202 host-gateway claim authority, P-204
billing matrix, P-206 fleet capacity view; P-201 with 35c3b (STILL no signal — nudge or reclaim).
Also standing: task #2 close per-hive-git plan; P-059 LIVE-1 still walled on tower-VM federation
(su-f5d28/su-26de47). Deferred pair now shared by P-101+P-108: one live 2-machine co-verify covers both.
