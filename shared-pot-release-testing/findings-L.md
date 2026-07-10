# Findings — Brief L: pot-from-repo + invite-join honesty (G-001/G-002) on a fix-`.deb`

Owner: su-ed300 (Claude). Lane: build a `.deb` carrying the lane-G honesty fixes and
**live re-verify G-001 + G-002 GREEN** on the real binary (the prior live pass only
confirmed the *bugs* on the pre-fix shipped binary). Live; coordinated with su-9140a
(holds the :154 live federation harness) + Brief M (su-d53bf, reuses this fix-`.deb`).

> STATUS: **DONE — all scenarios live-GREEN on the fix-`.deb`.** Fixes landed +
> teeth-verified in code; fix-`.deb` built (isolated `CARGO_TARGET_DIR`), validated to
> carry both fixes + luxon; live re-verify GREEN on the real binary (Xvfb :160/:161,
> 2 real peers). This is the GREEN the pre-fix live pass could not produce.

---

## What was deploy-gated, and what this lane adds

The lane-G honesty fixes were **in-tree but never on a runnable binary**:

- **G-001** (`reachablePeers` topic-blind): a publish counted swarm peers across **every**
  joined directory topic, so an INVITE publish (announce goes only to the secret's topic)
  reported the GLOBAL-topic peer count — "announced to N peers" when 0 received it.
  *Fix (landed):* `reachablePeersForHive(hiveId)` resolves the owned pot's announce
  topic and counts `openChannelCount(thatTopic)` — `pot-directory.ts:235`,
  `pot-publish.ts:125`.
- **G-002** (invite-join fake-success): `POST /api/discovery/join-invite` returned
  `{ok:true, joined:true}` after merely **subscribing** to the invite topic — a
  withdrawn / wrong / offline-owner invite (a well-formed dead secret) was reported as a
  successful join that never materializes. The lane-G fix made the **UI copy** honest but
  left the **route** lying.

The prior lane-G live pass (findings-G) confirmed BOTH **as real bugs on the shipped
05:33 binary** but could not produce a GREEN — the binary predated the fixes. Brief L
closes that: a binary built WITH the fixes + a live re-verify.

---

## Route-level G-002 fix LANDED this lane (the real cure, not just copy)

The lane-G copy fix made the *rendered string* honest, but the **route** still returned
`joined:true` for a dead secret — and the live harness tests the **route**. So a real
GREEN needed route-level honesty. Landed (in-scope: discovery/join is Brief L's area; no
other lane owns `join-invite.ts` / `pot-directory-boot.ts`):

- **`pot-directory-boot.ts`** — new `confirmInviteAnnounce(secret, {timeoutMs,pollMs})`
  on the directory wiring: after joining the invite topic, **bounded-wait** for the invite
  pot to ACTUALLY announce on it. Reuses the *already-landed* per-topic reach mechanism
  (`openChannelCount(topicHex)`, the G-001 infra) as the "is anyone home" gate + the
  discovered set as the "it materialized" confirmation. No gossip-internals change, no
  cross-lane risk.
- **`join-invite.ts`** — replaces the unconditional `{ok:true, joined:true}` with the
  honest result: `joined`/`found` reflect whether a pot really appeared; `subscribed`
  is the honest fallback ("on the topic, nothing announcing there yet"); carries a clear
  message for the dead-invite case. Both UI consumers (`CreateHarnessPicker`,
  `CupboardClient`) read only `ok`, so the contract change is safe.

**Tests (Vitest, teeth-verified):** `join-invite.test.ts` — added (a) joined ONLY when
the pot actually announces, (b) a dead secret is HONEST (subscribed, NOT joined). Teeth:
reverting the route to the old unconditional `joined:true` turns BOTH G-002 tests RED;
restored → 12/12 green. Related suites green (pot-publish 9, pot-directory-boot 9).
Type-clean (no new tsc errors in the touched files).

---

## Fix-`.deb` build

- Method: `bin/build-desktop-sidecar.sh` (keeps the `copy_pkg_closure luxon` A-001 fix)
  + `tauri build` with **isolated `CARGO_TARGET_DIR=/home/marsh-office/.cargo-target-L`**
  (dodges the warm-cargo-lock contention other lanes share; no `npm run dev` kills).
- **Sidecar bundle verified to carry BOTH fixes** before the cargo leg:
  `confirmInviteAnnounce` ×2, `reachablePeersForHive` ×2 in `sidecar/serve.mjs`.
- **`.deb` path (canonical current-staging artifact): `/home/marsh-office/.cargo-target-L/release/bundle/deb/Papercusp_0.0.2_amd64.deb`**.
  - First build (08:07): luxon=50 (A-001), reachablePeersForHive=2 (G-001), confirmInviteAnnounce=2 (G-002).
  - **Rebuilt (08:42) from current staging at Brief I's request** — same path, now ALSO carries
    A-003 (`joinerHiveHomeSlug`=4, Brief I's hive_members/settings→joiner + revocation fix):
    luxon=50, reachablePeersForHive=4, confirmInviteAnnounce=2, joinerHiveHomeSlug=4. The
    live lanes (I/K/M/N) can re-witness their fixes against this. (Does NOT include D-001/J or
    A-002 — su-9140a's later integrated build is the full A-002+A-003+D-001 pass.)
  - Build hygiene: built in an isolated `CARGO_TARGET_DIR`; I killed the wedged `tauri build`
    rpm-bundle pids afterward (the `.deb` is the deliverable; the rpm leg was holding the shared
    cargo-lock and is unused).

---

## Live re-verify matrix (real binary, fix-`.deb`, 2 real peers, Xvfb :160/:161) — ✅ ALL GREEN

A = papercupai (owner), B = aviynw (joiner), local testnet DHT, halt-safe (never :0).

| Scenario | Method | Result |
|---|---|---|
| **From-repo flow** | `two-instance-pot-from-repo-smoke.sh` (`HIVE_SMOKE_MODE=deb`, :161): create-from-repo → discover → join-offer → join | ✅ **GREEN** — 12/12 PASS: create(`hello-world-pot`)→announced→degraded-Cupboard-tolerant→discovered→member-links→**join-offer from directory** (member_repos repo-id match)→join→clone→**bidirectional + continuous** federation (A→B, B→A, A→B#2) |
| **G-001 invite reach=0** | `set-pot` public (reach=1, B on global) → flip to invite w/ fresh secret B never had | ✅ **GREEN** — PUBLIC→`reachablePeers=1` (B genuinely on global topic), INVITE→`reachablePeers=0`. Pre-fix reported `1` (the global-topic peer the invite announce never reached). The deceptive-publish lie is dead on the real binary. |
| **G-002 dead-secret join** | `join-invite` w/ well-formed dead secret (no pot announcing) | ✅ **GREEN** — `{ok:true, joined:false, found:false, subscribed:true, peersOnTopic:0, message:"Subscribed … no pot is announcing on it yet … will not appear if withdrawn or wrong"}`. Pre-fix returned `{ok:true, joined:true}` (fake success). The route is now honest. |
| **G-003 withdrawn drops** | A `set-pot private` (unlist) → poll B's `GET /discovery/pots` | ✅ **GREEN** — B dropped `hello-world-pot` ~3s after A withdrew (unlist tombstone crosses; data-plane of the discover-refresh). The UI poll/Refresh affordance is the lane-G/Brief-M surface fix. |

Corroborating: the from-repo CREATE response itself shows honest G-001 at the moment of
publish — `publish.announced:true, reachablePeers:0` (no peer had discovered/joined yet),
exactly the "registered but nobody heard it yet" honesty the fix restores.

---

## Tests (committed, teeth-verified — the durable regression guard)

- `packages/operator-core/lib/endpoint-route/routes/discovery/join-invite.test.ts` — G-002:
  (a) joined ONLY when the pot actually announces, (b) a dead secret is HONEST (subscribed,
  NOT joined). **Teeth:** revert the route to the old unconditional `joined:true` → both
  G-002 tests RED → restore → 12/12 green.
- `packages/operator-core/lib/hive-directory-boot.test.ts` — 4 NEW tests of the REAL
  `confirmInviteAnnounce` (not a route mock): found:false on a dead secret, found:true when
  a new invite pot is ingested mid-wait, does-NOT-confirm-off-a-public-announce, and
  snapshot-excludes-a-pre-existing-invite (the conservative re-join case). **Teeth:** an
  invite→public neuter flips exactly the two visibility-sensitive tests RED → restored →
  13/13 green. This is the deterministic guard for the positive path the live pass exercised
  only in the negative (dead-secret) direction.
- G-001 already had landed lane-G tests (`pot-publish.test.ts`, `directory-swarm.test.ts`,
  `ShareHiveDialog.test.tsx`); re-confirmed green (pot-publish 9, pot-directory-boot 13).

The live curls are an OPS re-verification (the established findings-G / findings-LIVE-RETEST
pattern), not a new committed `.sh` test driver — the committed regression guard is the
Vitest layer above. Scripts: `/tmp/L-live-all.sh`, `/tmp/L-reverify-g001-g002.sh`,
`/tmp/L-build-fix-deb.sh`.

---

## Verdict: 🟢 **GREEN**

The from-repo share/join flow federates bidirectionally + continuously live, and **G-001 +
G-002 are live-GREEN on a `.deb` built with the fixes** — the brief's done-criteria, met.
G-003 (data plane) GREEN as a bonus. No S0/S1 left in this dimension.

**Residual / hand-offs (not blockers):**
- The G-002 `confirmInviteAnnounce` positive-confirm keys on a NEW invite pot appearing in
  the discovered set (precise for the dominant flows). A re-join where the pot was already
  discovered would read `found:false` (false-negative, conservative-honest) — acceptable;
  documented for a future tighten if wanted. `peersOnTopic` is surfaced for transparency.
- The desktop GUI *render* of the now-honest copy is Brief M's lane (the fix-`.deb` path is
  handed off above); the honesty *logic* is covered by the Vitest component/route tests.
