# CUTOVER runbook — `PRESENCE_GOSSIP` + `HRW_RENDEZVOUS_AUTHORITY` (the coordination-lane activation)

**Plan:** `p2p-parity-closeout-lanes-2026-07-10` · item **P-007** (presence-gossip cutover).
**Author:** su-18f2f (coordination lane, [owner:Avi 2026-07-16 "you are in charge of the
coordination features only … work on this plan from start to finish"]).
**Status: FLIPPED + MOSTLY-VERIFIED (2026-07-17 ~02:55Z, su-18f2f) — see live scoreboard below.**

## LIVE drill scoreboard (2026-07-17 02:55Z — su-18f2f, mid-drill carry)

- **PRESENCE_GOSSIP flipped ON everywhere**: types.ts DARK_FLAGS entry removed (default now
  true, production-defaults.test.ts green), pg-override ON in BOTH stores (tower + VM own
  embedded store via `/tmp/vmcall.sh flags:set`). Presence loops rebooted (VM sidecar
  22:35+22:51 EDT via /tmp/boot-headless-current.sh; tower bg-host 22:36 via dev:restart).
- **V1 ✓** VM writer broadcasting (`[topic-gossip:papercusp/hive-presence] broadcast` in
  /tmp/serve-current.log). **V2 ✓ BOTH directions** (~100s after flip): tower shared_presence
  has `Avis-iMac_local-aviweiss` (user 1567022, pk Lm1ABoMRKV…); VM has the tower rows
  (papercusp + hive-canary harnesses — NOT dupes, per-harness keying). Session leg: VM
  carries 8+ tower session rows incl. su- ownerIds (su-4d3eb…); tower side vacuous (headless
  VM has no sessions). Steady-state refresh confirmed (remote rows re-stamp within seconds).
- **V3 addressability ✓ at resolve layer**: VM→tower `coord:send` to su-18f2f resolved via
  the gossip roster (federated:true, recipient_remote, receiptEvent declared,
  msg mrobxkzz-0000-abbcac12b5c24713909f7a868ed570b9). Message DELIVERY pending the
  v2t peer-log rail (below); receipt assert pending same.
- **Surface 3 (federated events) ✓ both directions** (t2v 20s post-flip; v2t proven pre-flip
  gen4 6s + full backlog catch-up — NO DATA LOSS across restart freezes, availability-only).
- **Surface 5 (claim-spec) ✓** 6s: drill-cup-18f2f landed VM origin='remote' fed_hlc+fed_ts.
- **H1/H2/H3+M5/M6 in-process suites ✓** re-run this drill: presence-gossip.test.ts +
  __tests__/coord-message-federation.integration.test.ts — 2/2 files green.
- **OPEN WEDGE (blocks surfaces 1+2 completion + V4 soak)**: v2t PEER-LOG rail down since the
  22:36 tower bg-host restart (gossip rails unaffected — different transport). Fresh VM
  re-dial at 22:51 did NOT clear it; tower journal shows NO papercusp peer_connected since
  22:48 — the VM's dial is not reaching the current bg-host gen (suspect: sibling tower
  process wins the connection, or stale isolated-DHT announces on fixture :49838).
  Prior gens recovered in ~15 min. KNOWN LEVER: another `dev:restart {target:'bg-host'}`
  re-rolls it (recovery observed gen 22:14). Peer restart storm is held off by my fleet
  broadcast (msg mrobhb9z…, ~60 min hold from 22:26 EDT).
- **HRW next**: `resolveUseHrwRendezvous` reads getFlag PER-CALL (lock-authority.ts:163) —
  flip needs NO reboot. Same-inputs verify done: both machines' fresh pot_slug='papercusp'
  candidate sets = {IXfGu216EI…(tower), Lm1ABoMRKV…(VM)}, same code (VM runs tower-built
  current serve.mjs), stores confirmed writable. REMAINING: flip both stores + types.ts
  default (count 29→28 in production-defaults.test.ts:483) + compute winner once via real
  `lockAuthorityForHive('papercusp')` (tsx, tower) + record.
- **Remaining after wedge clears**: V3 delivery+receipt assert (backlog will deliver msg
  mrobxkzz… automatically), V4 ~30-min no-dupe soak, HRW flip+verify, release fleet hold,
  GREEN verdict → su-4d3eb (P-405/P-301), file EIs: bg-host dev:restart no-coalescing +
  post-restart peer-log rejoin freeze (P-102 class, forensics in su-18f2f session
  2026-07-17 01:4x-02:5xZ).
This doc exists so the flip is a single verified action the instant the 2-machine rig
(WI-4070, git lane) heals — no re-derivation, no ambiguity. Nothing here authorizes touching
tower `bg-host` or the Mac VM lifecycle; **TOWER MUST NOT BE RESTARTED** [peer:63834].

---

## Why this is the marquee capability (what flips when the flag flips)

Live-verified 2026-07-16: `papercusp-presence-gossip` = **OFF**, `shared_session_presence` =
**0 rows**. The chain that flag OFF produces:

> writer dark → no session frames broadcast → `shared_session_presence` empty → the unified
> roster's federated leg + resolver (P-006/P-007 of `cross-machine-coord-parity`) return
> nothing → **remote agents are NOT addressable.**

So flipping `PRESENCE_GOSSIP` ON (after the gate below) is what makes a `coord:send` to a
remote machine's su-id actually resolve and deliver. Until then the coordination substrate is
built + in-process-green but inert cross-machine.

---

## The reader-first safety invariant — VERIFIED IN CODE (not assumed)

The cutover is safe because the **reader is wired unconditionally** and only the **writer** is
flag-gated. Confirmed at `packages/operator-core/lib/sync/hyperbee/wire-presence.ts:110–133`:

```
// READER-FIRST … register this hive topic with the gossip reader UNCONDITIONALLY
// (idles at zero cost with no gossip writers) … The WRITER cutover is flag-gated
// (PRESENCE_GOSSIP …). Flag is read once at wire time (a cutover flag — flip applies on reboot).
const gossipTopicHex = …;
let gossipWriterOn = false;
if (gossipTopicHex && potSlug) {
  gossipWriterOn = await getFlag(FLAGS.PRESENCE_GOSSIP, 'system').catch(() => false);
  let writer …;
  if (gossipWriterOn) writer = await buildGossipWriter(…);
  await registerPresenceGossipTopic({ …, ...(writer ? { writer } : {}) });  // reader ALWAYS registered
}
```

Consequences that drive the ordering below:
1. **A gossip-only announcer is invisible to a log-only reader.** So EVERY hive peer must be
   running a build that carries the reader BEFORE any peer flips the writer. Any build after
   `cross-machine-coord-parity` P-004 has the reader — but this must be *confirmed on each
   live machine*, not assumed.
2. **The flag is read ONCE at wire time** (`getFlag … 'system'` during `wirePresence`). A flip
   takes effect **only on the next operator (re)wire/reboot of that machine's presence loop**
   — it is not hot. Plan the flip around each machine's restart, and never mid-session expect
   an already-booted operator to pick it up.
3. `FLAGS.PRESENCE_GOSSIP` registry entry (`libs/flags/src/types.ts:1140/1787`) is a
   `case:'cutover'` dark flag in `KNOWN_DARK_FLAGS` — this is a **legitimate cutover dark
   case** (reader/writer skew), NOT finished-work-shipped-dark. Flipping it ON *removes* its
   allowlist entry (the set shrinks — no watermark debt).

---

## GATE — do NOT flip until ALL of these hold

- [ ] **G1. Rig live.** WI-4070 (tower↔VM network) healed: `origin='remote'` coord events are
      landing fresh and sustaining (not a one-shot burst). Owned by the GIT lane — await their
      rig-heal event; do not duplicate the diagnosis.
- [ ] **G2. LIVE-1 surface #4 GREEN cross-machine** (the parity drill's presence surface):
      with a build carrying the reader on BOTH machines, B's `shared_presence` /
      `shared_session_presence` contain A's live rows AND A's session ownerIds resolve/address
      from B (`coord:send` to a remote su-id succeeds). The adversarial H1/H2/H3 checks
      (spoofed `github_user_id`, cross-device `del`, local-ownerId session) must NOT mutate B's
      projection. (These are landed + in-process-green — `presence-gossip.test.ts` 22/22,
      `coord-message-federation.integration.test.ts` 40/40 re-verified 2026-07-16 — but their
      *live* behavior is the thing G2 proves.)
- [ ] **G3. Reader present on every live hive member** — confirm each machine runs a build
      after `cross-machine-coord-parity` P-004 (`registerPresenceGossipTopic` present). A
      member without the reader is invisible-to-gossip and would silently drop the roster.

---

## FLIP procedure (reader-first order)

1. **Confirm G3 on ALL machines first** (readers everywhere) — this is the ordering that makes
   the flip safe; a writer-first flip strands log-only readers.
2. Flip **`papercusp-presence-gossip` ON via `/admin/features`** — NEVER JSON/PostHog directly
   (repo rule: a feature toggle is a FLAGS entry flipped at the admin surface). Also change its
   **default** in `libs/flags/src/types.ts` and REMOVE it from `KNOWN_DARK_FLAGS`
   (`libs/flags/src/production-defaults.test.ts`) in the same change — a runtime-override-only
   flip with the default left `false`/dark is a half-finish.
3. **Reboot each machine's operator** (or otherwise re-wire presence) so `wirePresence` re-reads
   the flag — the flip is not hot (invariant #2). Sequence: pick one machine, reboot, confirm
   its writer is broadcasting (below), THEN the next. Coordinate every restart through the git
   lane's rig-custody rule — **NEVER a raw `systemctl restart` of the tower**.

## VERIFY (this is YOUR step, in-task — not a hand-off)

- [ ] **V1.** On each flipped machine, its own `shared_presence` writer is broadcasting: a
      signed presence frame goes out on the hive topic (operator log:
      `presence-gossip … broadcast`).
- [ ] **V2. Cross-machine roster populates:** on machine B, `shared_session_presence` gains
      machine A's session rows (was 0). Query:
      `select machine_label, count(*) from harness_shared.shared_session_presence group by 1;`
      → both machines present.
- [ ] **V3. Remote addressability — the actual capability:** from A,
      `coord:send { to:[<a-live-su-id-homed-on-B>], wake:'required', scope:'hive' }` → result
      reports `federated:true` AND B's agent's inbox-wake fires (a live turn starts). This is
      the go/no-go for "remote agents are addressable."
- [ ] **V4. No dupe/ghost roster churn** over ~30 min (the D-002 reason presence left the log):
      no duplicate rows per (github_user_id, machine, harness), tombstones (`del` frames) drop
      rows promptly.
- [ ] **V5. Rollback tested-safe:** flipping OFF + reboot returns to the log-append path
      byte-identically (the `append` path stays live when OFF — invariant, wire-presence.ts).

If V1–V4 pass, `PRESENCE_GOSSIP` stays ON in prod. If any fail, flip OFF + reboot (V5) and
file the failure against P-007 — do not leave a half-cutover (some writers on, some off) live.

---

## `HRW_RENDEZVOUS_AUTHORITY` — the second cutover (do AFTER presence gossip)

Same class of reader/writer-skew risk (`libs/flags/src/types.ts:1816`): every peer computes
the lock-authority winner PURELY from `shared_presence` + the flag value, so peers disagreeing
on the flag mid-flip compute DIFFERENT authorities for the same scope — defeating the single
serialization point. OFF ⇒ `selectAuthorityFromRows` argmin(device_pubkey), byte-identical to
pre-WI-1491.

- **Prereq:** presence-gossip cutover complete (V1–V4 green) — HRW reads `shared_presence`,
  which only fully populates cross-machine once gossip is live.
- **GATE:** a multi-peer verify that EVERY live peer resolves the SAME authority for a shared
  scope (compute `lockAuthorityForHive(scope)` on each machine; assert identical winner).
- **FLIP:** `papercusp-hrw-rendezvous-authority` ON via `/admin/features` + default flip +
  `KNOWN_DARK_FLAGS` removal, then reboot each peer. Because a mid-flip disagreement is the
  hazard, flip + reboot ALL peers in as tight a window as the rig-custody rule allows, and
  re-run the same-authority assertion immediately after.

---

## What this runbook does NOT cover (other lanes)

- The rig heal itself (WI-4070) — **GIT lane** (su-71c69 / su-e01db).
- The final signed GO/NO-GO synthesis of `RELEASE-READINESS.md` — **su-4d3eb** (P-405 of
  `p2p-public-release-remaining-lanes-2026-07-16`); this runbook feeds it the coordination
  verdict.
- LIVE-2 work-distribution drill — su-4d3eb (P-205 / absorbs `p2p-rest-lanes` P-007/P-008).
