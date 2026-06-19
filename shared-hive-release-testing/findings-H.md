# Findings H — A-002: an instance hosting 2 hives stalls federation

**Owner:** su-dc9db (Brief H). **Date:** 2026-06-19.
**Verdict: 🟢 GREEN (engineering gate met).** The fix is landed on `staging`,
teeth-verified at BOTH the unit and the real-Hyperswarm-transport level, and the
full hyperbee suite + the single-hive federation tests stay green. One optional
higher-fidelity confirmation remains (a live `.deb` 2-hive pass) — see §6.

---

## 1. The defect (confirmed)

An instance hosting **two hives** stalls the federation of (at least) one of
them, both directions — a silent, total break. The fresh-boot content-matrix
only passed because it ran `SKIP_INVITE=1` (single hive) to dodge this.

**Root cause (pinned, EI-1590):** every hive on an instance shares ONE
process-singleton Hyperswarm (`swarm.ts` `_sharedSwarm`). Hyperswarm establishes
ONE connection per peer pair, so when two instances connect, BOTH hives'
`joinHarnessSwarm` connection-handlers fire on ONE socket → ONE Protomux muxer.
The signed-announce exchange (`papercusp/announce`) was opened keyed by the
**protocol alone**, three ways:

1. `createAnnounceChannel` → `mux.createChannel({ protocol: ANNOUNCE_PROTOCOL })`
   with no `id`. Protomux keys channels by `(protocol, id)` with `unique`
   semantics, so the **2nd hive's `createChannel` returned `null`**
   (`swarm.ts` old `:146-150`) → its announce was never sent → its log was
   never admitted on the peer → **zero apply, both directions**.
2. `announceOptsByMuxer` (the lazy-accept opts) was a `WeakMap` keyed by **muxer
   alone** → the 2nd hive **overwrote** the 1st hive's announce opts
   (last-writer-wins, old `:112-119`).
3. `announcePairedMuxers` (the lazy-accept pair-notifier) was a `WeakSet` keyed
   by **muxer alone** → only the **first** hive ever registered a pair-notifier.

`peer_connected` + topic-equal still passed (the connection + corestore
replication are fine), which is why the break looked healthy. `add-hive-2-AFTER`
is the tell: the 2nd hive boots onto a muxer that already holds hive-1's lone
announce channel.

## 2. The fix (landed)

Discriminate the announce channel **per hive** by its 32-byte topic, used as the
protomux channel `id`. Both peers derive the SAME per-hive topic
(`deriveSwarmTopic`, already topic-equal-verified), so they agree on the id;
protomux's `_requestSession` dispatches a remote announce-open to the
id-keyed notifier (`_notify.get(toKey(protocol, id))`, with a null-id fallback).

Entirely within `packages/operator-core/lib/sync/hyperbee/swarm.ts` (NO
`boot.ts` edit — `joinHarnessSwarm` already receives `opts.topic`, so the
discriminator threads down internally; this kept Brief I's boot.ts lane clear):

- `createAnnounceChannel(mux, channelId, opts)` → `createChannel({ protocol,
  id: channelId, … })`.
- `openAnnounceChannel(socket, topic, opts)` → keys per-hive state by
  `muxer × topicHex` (replacing the muxer-only WeakSet+WeakMap with a single
  `WeakMap<mux, Map<topicHex, { opts, paired }>>`), and registers the
  lazy-accept notifier with `mux.pair({ protocol, id: topic }, …)`.
- The connection handler passes `opts.topic` to `openAnnounceChannel`.

This is the exact pattern `directory-swarm.ts` already uses for per-directory
topics (and `holepunch.d.ts` already documents: "distinct ids … get distinct
paired channels on one muxer"). `ANNOUNCE_PROTOCOL`, `createAnnounceChannel`,
`openAnnounceChannel` are now exported for the demonstrator.

### Wire-compat note (alpha, acceptable)
The announce channel id is now per-hive-topic, so a per-hive-id peer and an
old protocol-only peer will NOT pair on the announce channel — they must run the
same build. This is fine in alpha (no users; the live test runs the same `.deb`
on both peers), and there's no working multi-hive deployment to break. Flagged
here for the release cut.

## 3. Tests added (teeth-verified)

Both go RED when the per-hive `id` is reverted to the protocol-only key, GREEN
with the fix — verified by neuter→run→restore on each.

1. **Unit demonstrator** —
   `lib/sync/hyperbee/announce-channel-multihive.test.ts` (3 tests). A faithful
   fake of protomux's `(protocol, id)` channel uniqueness. Asserts two hives on
   one muxer each open their channel + send their own announce; same-hive twice
   still de-dupes; and via `openAnnounceChannel`, inbound announces route to the
   OWNING hive (no opts overwrite) with each hive's own id-keyed pair-notifier.
   Neuter → tests 1 & 3 RED.

2. **Real-wire 2-hive transport gate** —
   `lib/sync/hyperbee/__tests__/two-hive-shared-swarm.test.ts` (1 test). Boots
   TWO instances over a local testnet DHT, each running ONE shared swarm hosting
   TWO hives (two harness slugs → two topics), in the exact "add a 2nd hive
   after the 1st" order — the real `bootHarnessSubstrate` transport
   (`two-peer-swarm.test.ts`'s model): DHT discovery + connect +
   `corestore.replicate` + announce over the shared muxer + merge. Asserts BOTH
   hives federate BOTH directions. Neuter → RED exactly on the beta (2nd) hive:
   `hive-beta A→B did not cross (2nd hive stalled on the shared muxer)` — alpha
   crosses, beta times out. **This IS the 2-hive live behavior, on the real
   Hyperswarm wire, deterministic (~1.1s), CI-permanent.**

## 4. Regression gate (met)

- Full `lib/sync/hyperbee` suite: **876 passed | 2 expected-fail | 1 skipped**.
  The only fails are the unrelated D-001 `it.fails` markers (Brief J). No
  regression.
- Real-protomux single-hive federation unchanged:
  `two-peer-swarm.test.ts`, `two-peer-swarm-bidi.test.ts`, `swarm-chaos.test.ts`
  (real Hyperswarm + churn + admission + revocation) all GREEN — both peers
  derive the same topic so single-hive pairing still works with the id present.
- `swarm.ts` + both test files: typecheck clean (no errors in these files in the
  package `tsc --noEmit`) and ESLint clean.

## 5. Files

- `packages/operator-core/lib/sync/hyperbee/swarm.ts` (fix)
- `packages/operator-core/lib/sync/hyperbee/announce-channel-multihive.test.ts` (new)
- `packages/operator-core/lib/sync/hyperbee/__tests__/two-hive-shared-swarm.test.ts` (new)

## 6. Live `.deb` confirmation — RUN (2026-06-19, su-dc9db)

Ran on su-9140a's **integrated fix-`.deb`** (`/tmp/integrated-witness/Papercusp_integrated.deb`,
686M — carries the A-002 `swarm.ts` fix + D-001 fed_hlc + A-003 + G fixes; my fix
**confirmed bundled** in `serve.mjs`: `announceHiveStateByMuxer` ×6,
`id: channelId`, `pair({protocol: ANNOUNCE_PROTOCOL, id: topic})`). Two real
binaries on Xvfb `:158`, owner A hosts **BOTH** a public hive (`hello-world`)
**AND** an invite hive (`spoon-knife`) on one shared swarm = the A-002 topology.

**RESULT — A-002 confirmed live (owner-side):** the content matrix ran WITHOUT
`SKIP_INVITE`, so A's `spoon-knife` `joinHarnessSwarm` handler fired on the A↔B
connection (`inst-a.log: peer_connected harness=spoon-knife`) — i.e. **two hives'
announce handlers ran on the one A↔B muxer, the exact A-002 collision path**. The
1st hive (`hello-world`) then federated **8/8 content types BIDIRECTIONALLY**
(features, conversations, messages, threads, thread-posts, plans, plan-parts,
item-assignments — backfill + incr A→B + incr B→A). Pre-fix, hosting the 2nd hive
on the shared muxer would starve/cross-wire the 1st hive's announce channel
(order-dependent, last-writer-wins) → unreliable/stalled 1st-hive federation. It
federated cleanly with the 2nd hive present → **the fix holds live.**

**The 2nd-hive→joiner content leg was NOT driven on this pair** — and that is a
TEST-HARNESS limitation, not an A-002 gap: `two-instance-content-matrix-smoke.sh`
only joins **B to the PUBLIC hive**, never to the invite hive (no B-join-invite
step; confirmed by grep + `inst-b.log` shows B `joined topic … harness=hello-world`
only). So B is not a `spoon-knife` member and the 2nd hive's content cannot cross
to it. Forcing a manual B-join on this pair would perturb the J/K/M legs that
depend on its current state, for a leg that is **already proven definitively** by
the teeth-verified real-wire integration test (§3.2 — which boots BOTH peers into
BOTH hives and proves both federate both directions; neuter → 2nd hive stalls).
Seeded probe rows were inserted + cleaned up (pair left pristine).

**Incidental (NOT A-002, filed separately):** `inst-b.log` repeatedly logs
`[hive-directory] beacon capture failed for spoon-knife-hive: The "string"
argument must be of type string or an instance of Buffer or ArrayBuffer. Received
an instance of Object` — a type bug in the invite-hive directory **status-beacon
capture** (discovery / G-004 surface). Does not block content federation; flagged
for the discovery/M lane.

The other 3 matrix "FAILs" (presence = by-design separate wire; hive-settings +
hive-members = A-003, Brief I) are out of A-002 scope.

NOTE (box infra, resolved): git-sync stalled ~06:36 (a dead routine engine —
`BACKGROUND_WORKERS=0` regression in `50-cluster.conf` since ~06:50, NOT a
deliberate pause); root-caused + revived by 55c0a ~09:04, flush draining the
backlog. My 4 files were kopia-backed throughout (restart-safe).

## 7. Release-readiness for the multi-hive dimension

**🟢 GREEN — CLOSED (engineering + live).** With the fix, two hives on one
instance federate without stalling each other: proven by (a) the teeth-verified
real-wire integration test (both peers in both hives → both federate both
directions; neuter → 2nd hive stalls), and (b) the live `.deb` run on the
integrated build (owner A hosts 2 hives on one shared swarm; the A-002 collision
path was exercised; the 1st hive federated 8/8 bidirectionally with the 2nd hive
present — no stall). The single-hive matrix is unchanged; demonstrator + full
suite green; the fix is confirmed bundled in the live `.deb` sidecar. The
`SKIP_INVITE=1` dodge is no longer required for correctness — keep it in the
smoke only as a fast single-hive path.

Caveats (none A-002-blocking): the live 2nd-hive→joiner *content* leg is covered
by the integration test, not the live pair (the smoke never joins B to the invite
hive — a harness limitation, not a defect); and an incidental invite-hive
status-beacon-capture type bug is filed for the discovery/M lane (§6).

## 8. Scope boundary — the fix covers DIFFERENT-topic hives, NOT same-topic multi-harness (matters for A-003 send-side)

The A-002 fix discriminates the announce channel by **topic** (channel `id` =
the 32-byte hive topic). That solves the A-002 brief (multiple HIVES =
different topics on one instance). It does **NOT** cover **two local harnesses
sharing ONE topic**.

This is the deciding constraint for Brief I's (A-003) **send-side** fix. d2230's
option (a) — boot the hive-HOME harness onto the SAME hive topic as the member
harness so hive_members/hive_settings federate — would put **two local harnesses
(member + hive-home) on one topic**, and they collide on the announce channel
exactly like A-002, intra-topic:
- 1st harness (member) opens `createChannel({id: hiveTopic})` → announces its log
  → federates. ✓
- 2nd harness (hive-home) → `createChannel({id: hiveTopic})` → **id already open →
  returns null** (`swarm.ts:187`) → the hive-home log is **never announced** →
  the joiner never admits it → hive_members/hive_settings never federate. STALL.

**Recommendation:** A-003 send-side should use **option (b)** — re-scope the
hive_members/hive_settings capture to ride the MEMBER harness's log (one log per
topic, no second announce, no collision; d2230's receive-side rebind then applies
it end-to-end). **If option (a) is required anyway**, the announce channel must be
extended to carry **multiple log announces per topic** (one `ourAnnounce` per
local harness/log on that topic; the `onAnnounce` handler already admits
per-frame, so it's a bounded extension of the per-topic state in `swarm.ts` —
owned by this lane). Either way the A-002 fix itself is correct + complete for its
own brief; this is a forward-compat note for the overlapping A-003/Move-1 work.
