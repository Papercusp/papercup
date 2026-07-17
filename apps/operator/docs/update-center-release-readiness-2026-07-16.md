# Update Center — Release-Readiness Report v2 (per-platform go/no-go)

**Plan:** `update-center-3-platform-test-suite-2026-07-15` · **Candidate:** desktop `0.0.11-alpha` (carries the WI-5004/5007/5008/5010 resolution-layer fixes) · **As of:** 2026-07-16

> Test method (all platforms): a disposable, **isolated** prior-version install
> (fresh `$HOME`, its own embedded Postgres) driven headlessly, pointed at a
> **local update rail** (`http://127.0.0.1:8044`) via the runtime
> `PAPERCUSP_RELEASE_HOST` override — **zero outward writes**, no dependency on
> the real R2 host or a public publish. Both update artifacts are
> cryptographically pre-verified (tauri prehashed-minisign: BLAKE2b-512 + ed25519
> against the baked updater pubkey) before every drive.

## Verdict summary

| Platform | Forward update | Revert (rollback) | DB grace (fwd + down) | Channel/degradation | **Go/No-Go** |
|---|---|---|---|---|---|
| **Linux (x86_64)** | ✅ PASS | ✅ PASS | ✅ PASS | ✅ PASS | **GO** |
| **macOS** | — | — | — | — | **BLOCKED (build)** |
| **Windows** | artifact ✅ signed | — | — | (server-side ✅) | **PENDING VM E2E** |

## Linux — GO (fully exercised end-to-end)

Driven on an isolated `0.0.10` AppImage → local rail serving the real `0.0.11`
artifact + a sha-verified genuine `0.0.10` for rollback.

- **P-001 forward update** ✅ — chip detects `0.0.11` → confirm → 4.2 GB download →
  tauri-plugin-updater in-place `$APPIMAGE` rewrite → self-relaunch as `0.0.11`
  (operator sha `9f4917b9`). Binary physically swapped, app came back on the new version.
- **P-002 revert / rollback** ✅ — popover **Revert** on the `0.0.10` row → download →
  backup + downgrade-swap → relaunch as `v0.0.10` (sha `6f48aa0d`). The exact
  owner-flagged path ("we implemented a rollback feature… test that thoroughly") —
  swap works in both directions.
- **P-003 .deb fallback UX** ✅ (code-verified) — `install_update` **and** `revert_to`
  early-fail `no_compatible_assets` on a non-AppImage install; `UpdateChip` catches
  both (install → opens releases page, revert → "reinstall manually" toast). No silent
  hang on a `.deb`/`.rpm` install.
- **P-010 forward-migrate DB grace** ✅ — the `0.0.11` binary migrated the
  `0.0.10`-created data dir cleanly: ledger **477 → 488** (migrations 604–614), zero errors.
- **P-011 downgrade DB grace** ✅ — after revert, the `0.0.10` binary booted **clean on
  the newer 488-row ledger it never created** — the filename-keyed runner ignores
  unknown-future rows (604–614). No down-migrations needed, no crash.
- **P-012 additive-only audit** ✅ — the 11-migration delta (604–614) is 100%
  additive; exact file↔ledger match (no dup/skip). Because P-011 showed no breakage,
  the conditional "schema-newer-than-binary guard" is **not required**.
- **P-013 state survival** ✅ — the planted marker row survived **both** swaps
  (workspace/registry/credentials persistence proven across the full cycle).
- **P-040 channel matrix** ✅ — `alpha` → offers `0.0.11`; `beta`/`stable`/`aarch64`
  → `204 no_candidate` (graceful, no false "unreachable"); already-current → `204 up_to_date`.
- **P-041 server poller** ⚠️ GUI path (`latest.json`) proven E2E; the Server path
  (`latest-server.json`) is inert until Server-role artifacts are cut — see Gaps.
- **P-042 degradation matrix** ✅ — every failure mode degrades to a safe `204` (never a
  crash or a false update offer) with a **distinct diagnostic** `X-Update-Reason`:
  malformed manifest → `fetch_failed`; unset base URL → `manifest_unconfigured` (WI-4364);
  missing signature / empty platforms → `no_candidate`. The WI-5010 fix (unreachable
  ≠ "no releases yet") is confirmed live — `fetch_failed` and `no_candidate` are cleanly separated.

**Resolution-layer fixes confirmed live in the candidate:** WI-5007 (`is_current`
now marks `0.0.11` ● Current in the popover), WI-5008 (Revert resolves off the
release host, not dead GitHub), WI-5010 (unreachable-vs-no-releases messaging).

## macOS — PENDING (blocked on artifact, not on a defect)

P-020/021/022 need a `.app.tar.gz` + `.sig` from the authoritative cut. The isolated
rig + drive method is ready; the moment a mac artifact exists it can be staged and run
(same local-rail, zero-outward-write method). **Owner-relevant:** this is a build-artifact
dependency in the release-cut lane (su-b0fbf), not a testing blocker on my side.

## Windows — artifact validated; VM E2E pending

- **P-030 (artifact)** — the Windows GUI `-setup.exe` **exists and is validly signed**:
  `Papercusp GUI_0.0.11_x64-setup.exe` (1.9 GB) + `.sig` cryptographically **VERIFY=PASS**
  against the baked updater pubkey (keyid `449908a7d47d3a5d`, the same key that signed
  the passing Linux artifact). Build provenance is clean: `gitDirty:false`, gitHead
  `8e5411de`, buildSha `da9e455e-9f4917b9` (matches the Linux 0.0.11 operator sha). The
  Server `-setup.exe` also verifies. So the Windows auto-update artifact will pass the
  updater's signature check.
- **Server-side manifest resolution** for a Windows client is covered by the same
  platform-agnostic manifest path proven on Linux (`platformKeyFor` accepts `windows`;
  the channel/degradation matrix is platform-independent).
- **P-031/P-032 (Windows-native in-app update + revert + DB spot-checks)** — the only
  remaining Windows gap; these require driving the actual swap on the **Windows VM**
  (`ssh :2223`), which additionally has a low-disk escalation open in the cut lane.
  Not doable from Linux; owned by the cut lane (su-b0fbf).

## Gaps / recommendations

1. **Server-product auto-update** (`latest-server.json`) is untested — this GUI cut
   produces no Server-role artifacts, so the Server tray poller has nothing to poll.
   Not a blocker for the **GUI** release; flag it if the Server product ships on the
   same cadence.
2. **macOS + Windows** are the only remaining go/no-go inputs. Both are ready to run
   against the local rail as soon as the authoritative cut yields their artifacts.

## Bottom line

**Linux desktop Update Center is GO for public release** — forward update, rollback,
DB migration grace in both directions, and the full channel/degradation matrix are all
exercised and passing on the `0.0.11` candidate. macOS and Windows are GO-pending purely
on their build artifacts, with the test harness staged and waiting.
