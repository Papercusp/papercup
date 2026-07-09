# Brief A — Live multi-peer end-to-end federation (findings)

Owner: su-76203 (Claude). Lane: live-instance federation on the REAL packaged
binary. Held the `shared-pot-live-instances` lock.

## Dimension verdict: **RED for release**

The headline feature genuinely works on the real packaged binary — but three
findings block a confident public release:

- **A-001 (S0):** the shipped `.deb` does not boot at all (luxon not bundled). **Fixed** in this lane (build + staging bundle); the shipped artifact must be rebuilt + re-gated.
- **A-002 (S1):** an instance hosting **2 pots** stalls federation entirely (both directions). Cleanly isolated.
- **A-003 (S1):** `hive_members` / `hive_settings` do **not** federate to a joiner — `hive_members` carries the revocation blocklist, so this compounds the C-001 / Brief-E revocation gap.

What IS proven GREEN on the real binary (single-pot instance): create→publish→
discover→**join via the current flow**→topic-equality→**8/11 content types federate**
(features/conversations/messages/threads/thread-posts/plans/plan-parts/item-assignments),
**bidirectional**, with **late-joiner backfill** of pre-join content and **negative
isolation** (a non-member sees nothing).

---

## A-001 — The shipped `.deb` does not boot: `createRequire('luxon')` not shipped (S0)

Tracked: **EI-1589**. Fixed in `build-desktop-sidecar.sh` (+ staging bundle patched). Teeth-verified.

The release artifact `Papercusp_0.0.2_amd64.deb` crashes at boot before embedded-PG/
operator come up:

```
[serve] fatal: Error: Cannot find module 'luxon'
  at packages/operator-core/lib/harness/routines/schedule-next.ts (serve.mjs:457971)
  code: 'MODULE_NOT_FOUND'
[papercusp-desktop] FATAL: serve.mjs exited (status 1) before becoming ready   →  EMBEDDED_PG_FAILED
```

**Root cause (the createRequire bundling gotcha):** `schedule-next.ts:41` loads luxon
via `createRequire(import.meta.url)('luxon')` (deliberate — a static import trips
TS7016). esbuild only follows static imports, so luxon is neither inlined nor on the
externalize-and-copy list → **0** luxon files ship (`.deb` ships `rrule`=125 files,
`luxon`=0). This is the EXACT bug `rrule` already fixed (`build-desktop-sidecar.sh:322-333`);
the parallel `copy_pkg_closure luxon` was never added when luxon landed (commit
`5472dec3c`, 2026-06-17, `[skip ci]`). The ~28.6k green tests miss it: dev/test runs
under tsx with hoisted node_modules; nothing exercises the packaged bundle's module graph.

**Fix:** `copy_pkg_closure luxon` after the rrule copy + luxon copied into the staging
`src-tauri/sidecar/node_modules`. **Teeth-verified:** without luxon → boot crash
`EMBEDDED_PG_FAILED`; with luxon → the from-repo smoke passes end-to-end in **both**
`sidecar` and `deb` (real-binary) modes. The staging `serve.mjs` is byte-identical
(sha `21bd428cf02f3605`) to the `.deb`'s. **Release lane must rebuild + re-gate the shipped `.deb`.**

---

## Federation proof (REAL packaged binary, current share/join flow)

Current flow = `POST /api/harness/pots/from-repo` (create+publish) → `GET
/api/discovery/pots` (discover) → **`POST /api/discovery/join-pot`** (the real join
that materializes the remote_hive view + re-keys the joiner onto the owner's
pot-pubkey topic). Proven in **deb mode (real `papercusp-desktop` binary under
Xvfb+vglrun)** from a luxon-repacked `.deb`:

| leg | result |
|---|---|
| create-from-repo (public pot) | PASS |
| publish.announced (signed announce, testnet) | PASS |
| degraded-cupboard (live Cupboard never touched) | PASS |
| B discovered pot in directory | PASS |
| join-offer (paste dedup → existing pot) | PASS |
| join-pot (view materialized + re-key) | PASS |
| federate A→B / B→A / continuous (feature) | PASS / PASS / PASS |
| **topic-equal** — A & B on the SAME derive-swarm-topic hex | **PASS** |
| **negative isolation** — non-member sees ZERO pot content | **PASS** |

This exercises the **real joiner-resolves-its-own-topic path** (the topic-split bug's
home) that the 2-peer integration rigs bypass. A separate INVITE pot also created
+ announced (visibility=invite); its member-link topic carrier was not cleanly
extracted from the API response — verify in `inst-a.log` (minor, see Gaps).

---

## Per-content-type matrix (single-pot, real binary)

Method: write `origin='local'` on src → capture trigger enqueues to `substrate_outbox`
→ peer-log → dst projection re-applies `origin='remote'` within a bounded poll. Run on
the live A(owner papercupai) / B(joiner aviynw) pair. Backfill = seeded on A **before**
B joined; incremental = written post-join.

| type | backfill (pre-join) | incr A→B | incr B→A |
|---|---|---|---|
| features | ✅ | ✅ | ✅ |
| conversations | ✅ | ✅ | ✅ |
| plans (harness_plans) | ✅ | ✅ | ✅ |
| messages (coord_event_log) | — | ✅ | (mechanism = conversations) |
| threads | — | ✅ | (mechanism = conversations) |
| thread-posts | — | ✅ | (mechanism = conversations) |
| plan-parts | — | ✅ | — |
| item-assignments | — | ✅ | — |
| presence | ⚠ N/A | ⚠ N/A | ⚠ N/A |
| **pot-settings** | **✗** | **✗** | **✗** |
| **pot-members** | **✗** | **✗** | **✗** |

- **8/11 content types federate** cleanly (features, conversations, messages, threads,
  thread-posts, plans, plan-parts, item-assignments). features/conversations/plans
  additionally verified **bidirectional + backfill**; the rest verified A→B (same
  capture+projection mechanism — coord-family share one path, plan-family another).
- **presence (⚠ N/A):** `shared_presence` is NOT captured to `substrate_outbox`
  (outbox=0). It federates via the dedicated **presence-announce wire**
  (`wire-presence.ts`), a separate path the raw-INSERT/outbox probe can't exercise.
  NOT a confirmed failure — a test-method limitation; presence federation needs a
  wire-level test (left open, see Gaps).
- **pot-settings / pot-members (✗ → A-003):** see below.

---

## A-002 — Hosting a 2nd pot stalls federation entirely (S1)

**Cleanly isolated.** Two runs that differ from the passing single-pot run **only**
in pot count totally stalled federation in **both** directions — A captured + drained
every op (`substrate_outbox.drained=t`), A↔B were `[swarm] peer_connected` on the
correct (topic-equal) topic, yet the peer applied **nothing** (confirmed with a 180s
probe and a final post-run check: zero remote rows of any kind):

| run | peers | pots | federation |
|---|---|---|---|
| from-repo smoke (sidecar) | 2 distinct | 1 | ✅ PASS |
| from-repo smoke (deb / real binary) | 2 distinct | 1 | ✅ PASS |
| content-matrix single-pot (deb) | 2 distinct | 1 | ✅ PASS (8/11 types) |
| content-matrix v2 (deb) | 2 distinct | **2** | ✗ TOTAL STALL |
| content-matrix v1 (deb) | 3 (C dup-id) | **2** | ✗ TOTAL STALL |

The v2-vs-single comparison is decisive: identical except **1 vs 2 pots** (both
2-peer, distinct identities, same seed sequence) → 2 pots = total stall. Creating a
second pot on an instance (a second from-repo create / a second pot-pubkey topic)
appears to break the first pot's peer-log apply path.

**Root cause narrowed (code-level; layer pinned, exact channel-clobber pending a
download-event repro deferred past the active fleet-halt — recorded on EI-1590):**
- ❌ NOT the Model-B/D-021 projection-registry collision — `boot.ts:519` wires a
  per-harness `scopedApply` (`buildHarnessProjectionApply`) into `mergeNow`, and in
  the repro the joiner had only ONE harness, so a global tableTag collision can't be
  its failure.
- ❌ NOT a shared corestore — `corestore.ts` is strictly per-harness (`${workspaceRoot}::${slug}`).
- ✅ LIKELY the **shared Hyperswarm + per-harness `store.replicate(socket)` over one
  Protomux muxer**: `swarm.ts` has a process SINGLETON `_sharedSwarm`; every harness
  joins its topic on that one swarm and calls `opts.store.replicate(socket)` (line 329)
  with its own per-harness corestore, and `Protomux.from` reuses the socket muxer
  (swarm.ts:176) — the exact EI-681 hazard. Booting the 2nd pot's replication on the
  shared muxer is the most likely surface that disrupts the 1st pot's replication
  channel (symptom fits: owner drains to its log + `peer_connected`, but the log core
  stops replicating to the peer → peer applies nothing).
**LIVE REFINEMENT (halt-safe curl+psql repro — overturns the steady-state-muxer guess):**
Adding a 2nd pot to an ALREADY-established, federating pair does NOT stall it
(baseline A→B 4s; created a 2nd pot on A; a subsequent hello-world write still
crossed in 6s). So the trigger is **timing relative to the join, not steady-state
2-pot presence**: the stall occurs only when the owner **already hosts the 2nd pot
at the moment the peer JOINS** the 1st pot (v2: create hive1+hive2 → B joins → stall;
live: create hive1 → B joins → create hive2 → works). The bug is therefore in the
**join-time federation setup with 2+ pots on the owner** (admission / which-log-core-
to-serve resolution on the joining side), NOT a steady-state replication-channel
teardown. Remaining to fully close: a fresh-pair before-join confirmation (A creates
2 pots → B joins → expect stall) — needs a GUI launch, deferred past the fleet-halt.
Recorded on EI-1590. High-value before release — a real deployment routinely hosts
multiple pots, and joiners arrive against owners that already do.

---

## A-003 — `hive_members` / `hive_settings` do not federate to a joiner (S1)

On the joiner B: capture **fires on the owner** (A `substrate_outbox`: hive_settings=3,
hive_members=1; rows present origin=local on A), B **has the pot-home harness
`hello-world-pot` registered** (from join's view materialization) — yet B applies
**zero** `hive_settings` / `hive_members` rows. The joiner does not run a projection-
apply for the pot-home-scoped ops (these demux by the pot-home slug, not the member
slug). Per the projection source comments these tables are **"MULTI-SWARM ONLY"**
(designed to replicate across a Pot's own Swarms, not necessarily to a foreign
joiner) — so this may be partly by-design, but it has a real consequence:

**`hive_members` carries `revoked_pubkeys` (the admission/revocation blocklist).** If
it does not federate to a joiner, a revocation written by the owner may never reach the
joiner's admission union — **compounding C-001 / Brief E** (revocation is already
read-plane-incomplete; here the revocation *record itself* doesn't reach the peer in a
single-box join topology). Needs a product decision alongside C-001: must "remove
member" propagate to joined peers? If yes, hive_members federation to joiners is required.

---

## Reusable live-test runbook

Both scripts source `papercusp-desktop/bin/lib/federation-asserts.sh`:

1. **Headline (create→publish→join→feature federation), real binary:**
   ```
   cd papercusp-desktop
   HIVE_SMOKE_MODE=deb bin/two-instance-pot-from-repo-smoke.sh /tmp/Papercusp_0.0.2_luxonfix_amd64.deb
   #   (sidecar mode also works; the on-disk shipped .deb needs the A-001 luxon fix first —
   #    /tmp/Papercusp_0.0.2_luxonfix_amd64.deb is a luxon-repacked bootable build.)
   ```
2. **Full content matrix + backfill + negative + topic-equal (NEW, this lane):**
   ```
   cd papercusp-desktop
   SKIP_INVITE=1 bin/two-instance-content-matrix-smoke.sh /tmp/Papercusp_0.0.2_luxonfix_amd64.deb
   #   2-peer SEQUENCED (A writes BEFORE B joins → true backfill). Real binary under Xvfb.
   #   ⚠ SKIP_INVITE=1 is REQUIRED until A-002 is fixed — a 2nd pot stalls federation.
   #   MATRIX_TYPES="features conversations ..." narrows the type set. Leaves the pair UP.
   ```
Verify via each instance's embedded PG: `psql
postgresql://harness_admin:harness_admin_pwd@localhost:<pg>/papercusp`, check the
`origin` column (`local`=wrote here, `remote`=federated in). Ports in
`~/.papercusp-lane-a-fed/instances.env`; teardown `~/.papercusp-lane-a-fed/stop.sh`.

---

## Gaps left open

- **A-002 root cause** — why a 2nd pot stalls the 1st's federation is not pinned
  (needs a code-level dive into the 2nd-pot substrate boot / swarm re-join path).
- **A-003 product decision** — must hive_members/settings federate to a joiner
  (revocation)? Tied to the C-001/E decision.
- **presence federation** — not testable via the raw-INSERT/outbox method (separate
  announce wire); needs a wire-level live test.
- **3-distinct-identity trio** — this box has only 2 gh identities, so a true 3-peer
  (3 distinct identities) late-joiner test could not run. A 3rd peer reusing the
  owner's identity corrupted admission (separate from A-002); backfill was instead
  proven via the 2-peer write-before-join sequence (valid for the late-joiner property).
- **invite member-link topic** — confirm the invite pot's member link carries the
  pot topic (inconclusive from the API response shape; check inst-a.log).
- **plan-parts** — crossed live; note it is `PLAN_PART_FEDERATION`-flag-gated (a fresh
  plan_slug crosses via the whole-blob bootstrap path regardless).
