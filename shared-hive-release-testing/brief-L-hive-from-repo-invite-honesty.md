# Brief L — Hive-from-repo + invite-join honesty (G-001/G-002) on a fix-`.deb`

**Priority: S1/S2 lane.** Live. Coordinate via the `shared-hive-live-instances`
lock. Requires building a `.deb` WITH the lane-G fixes (the prior live pass only
confirmed the BUGS on the pre-fix `.deb`).

## Objective
Exercise the **current from-repo share/join flow** and the **invite-secret join**
path on the real binary, and **re-verify G-001 + G-002 GREEN** on a `.deb` built
with the lane-G fixes.

## Why it matters for release
The content-matrix proves the *public-hive* path. Two honesty bugs were confirmed
**live on the shipped binary** but never re-verified fixed:
- **G-001** (`reachablePeers` topic-blind): a public publish reports
  `reachablePeers=1`; flipping the SAME hive to invite (fresh secret the peer never
  had → true reach 0) STILL reports `1` — it counts the global-topic peer the invite
  announce never reached. "Announced to N peers" when 0 got it.
- **G-002** (invite-join fake-success): `POST /api/discovery/join-invite` with a
  well-formed-but-dead secret returns `{ok:true, joined:true}`, but the hive never
  appears — success reported for a join that never materializes.
Both fixes are **in-tree but deploy-gated** (`reachablePeersForHive` threads the
announce topic; honest invite-join copy). They need a fix-`.deb` + a live re-verify.

## Scope / scenarios
1. **Build a fix-`.deb`:** rebuild the sidecar (`build-desktop-sidecar.sh`, keep the
   `copy_pkg_closure luxon` A-001 fix) + `tauri build` with an **isolated
   `CARGO_TARGET_DIR`** to dodge the cargo-lock contention that wedged earlier
   builds. Confirm luxon bundled (`dpkg-deb`).
2. **From-repo flow (live):** run `two-instance-hive-from-repo-smoke.sh`
   (`HIVE_SMOKE_MODE=deb`) — `POST /api/harness/hives/from-repo` →
   `GET /api/discovery/hives` → `POST /api/discovery/join-hive`. Assert topic-equal
   + content crosses (the retired flow was `/api/harness/<slug>/share/finalize`).
3. **G-001 re-verify:** on the fix-`.deb`, an INVITE publish to a peer that never
   had the secret reports `reachablePeers=0` (was `1`).
4. **G-002 re-verify:** `join-invite` with a dead secret no longer claims
   `joined:true` (honest bounded-confirmation / failure copy).
5. **G-003 (discover panel):** withdrawn hives drop out of discover within the poll.

## Method
- Build with isolated `CARGO_TARGET_DIR` (e.g. `/home/marsh-office/.cargo-target-L`)
  or stop contending `npm run dev` shells first (do NOT name-pattern kill). Live via
  the smoke harness + each peer's embedded PG / sidecar API. Headless `:1xx`.

## Deliverables
- `findings-L.md`: the from-repo live matrix, G-001/G-002 re-verify on the fix-`.deb`
  (the GREEN that the pre-fix live pass could not produce), invite-flow result.
- The fix-`.deb` path recorded for the M/desktop lane to reuse.

## Done / verdict
GREEN only when from-repo share/join federates live, and G-001 + G-002 are
live-GREEN on a `.deb` built with the fixes.
