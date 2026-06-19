# Brief A — Live multi-peer end-to-end federation (findings)

Owner: su-76203 (Claude). Lane: live-instance federation on the REAL packaged
binary. Holds the `shared-hive-live-instances` lock.

**Dimension verdict: RED for release** — not because federation is broken (it
isn't; it federates end-to-end on the packaged artifact) but because the
**shipped `.deb` does not boot at all** (A-001). The headline feature works once
the artifact boots; the artifact as built does not. RED until the `.deb` is
rebuilt + re-gated, then GREEN-with-the-matrix-below.

---

## A-001 — The shipped `.deb` does not boot: `createRequire('luxon')` not shipped (S0, release-blocker)

**Severity: S0.** The release artifact `Papercusp_0.0.2_amd64.deb` (designated by
the program README as "the fixed .deb, all 5 fixes") crashes at boot before the
operator/embedded-PG come up — i.e. the app never starts.

**Repro:** launch the packaged binary (or run its bundled
`usr/lib/Papercusp/sidecar/serve.mjs`). serve.mjs throws:

```
[serve] fatal: Error: Cannot find module 'luxon'
  Require stack: …/sidecar/serve.mjs
  at …/packages/operator-core/lib/harness/routines/schedule-next.ts (serve.mjs:457971:52)
  code: 'MODULE_NOT_FOUND'
[papercusp-desktop] FATAL: the operator process (serve.mjs) exited with exit status: 1
  before becoming ready
```

→ `fed_wait_boot` reports `EMBEDDED_PG_FAILED`. The desktop never opens.

**Root cause — the createRequire bundling gotcha (the brief named it):**
`schedule-next.ts:41` loads luxon via `createRequire(import.meta.url)('luxon')`
(deliberately — a static `import` trips TS7016 because `@types/luxon` is not a
dependency). esbuild only follows **static** imports, so it neither inlines luxon
into `serve.mjs` nor adds it to the externalize-and-copy list. Result: **0** luxon
files ship in the bundle.

**Evidence (not speculation):**
1. `.deb` sidecar `node_modules`: `rrule` = **125 files shipped**, `luxon` = **0**.
2. `schedule-next.ts` has **two** such requires: `createRequire(...)('rrule')`
   (line 24) and `createRequire(...)('luxon')` (line 41). Boot crashed on luxon
   *after* rrule resolved → rrule ships, luxon doesn't.
3. `build-desktop-sidecar.sh:322-333` **already** handles this exact bug for rrule
   (`copy_pkg_closure rrule`, with a comment naming the identical
   `Cannot find module 'rrule'` → `EMBEDDED_PG_FAILED` symptom). The parallel
   `copy_pkg_closure luxon` was never added.
4. Regressed in commit `5472dec3c` (2026-06-17, "AUTO mode: fixing the 4
   scheduled-plans bugs", marked `[skip ci]`) — luxon landed; the build copy did not.

**Why the ~28,600 green tests missed it:** dev/test runs under tsx with the
hoisted root `node_modules` (luxon resolves fine). Nothing exercises the packaged
esbuild bundle's runtime module graph — only a live packaged-instance boot catches
it. This is precisely the gap Lane A exists to close.

**Fix (applied to staging, low-risk, mirrors rrule):**
- `papercusp-desktop/bin/build-desktop-sidecar.sh`: added `copy_pkg_closure luxon`
  immediately after the rrule copy (with a comment naming this finding).
- Unblocked live testing now by copying luxon into the existing staging bundle
  (`src-tauri/sidecar/node_modules/luxon`) — `serve.mjs` is unchanged (it already
  does the runtime require), it just needed the files present.

**Teeth-verified:**
- WITHOUT luxon → deb-mode boot crashes `EMBEDDED_PG_FAILED` (`Cannot find module 'luxon'`).
- WITH luxon → `HIVE_SMOKE_MODE=sidecar two-instance-hive-from-repo-smoke.sh`
  passes end-to-end (every leg PASS, see below). The staging `serve.mjs` is
  **byte-identical** (sha `21bd428cf02f3605`) to the `.deb`'s, so this is a
  faithful proof of what the `.deb` does once luxon ships.

**Remaining (release lane, NOT this lane):** the **shipped `.deb` must be rebuilt**
from the patched build and re-gated by the green-checkpoint. Tracked as **EI-1589**;
broadcast to the fleet (live-instance lanes E/G must not burn time on the
non-booting `.deb` — workaround: inject luxon into the extracted tree).

---

## Federation proof (packaged artifact, current share/join flow)

After the A-001 fix, the **current** flow — `POST /api/harness/hives/from-repo`
(create+publish) → `GET /api/discovery/hives` (discover) → **`POST
/api/discovery/join-hive`** (the real join that materializes the remote_hive view
and re-keys the joiner onto the owner's hive-pubkey topic) — was proven on the
packaged `serve.mjs` artifact:

| leg | result |
|---|---|
| create-from-repo (public) | PASS |
| publish.announced (signed announce on directory topic, testnet) | PASS |
| degraded-cupboard (live Cupboard never touched) | PASS |
| B discovered hive in directory | PASS |
| member-links present | PASS |
| join-offer (paste dedup → existing hive) | PASS |
| offer-from-directory (member_repos match) | PASS |
| join-hive (view materialized + re-key) | PASS |
| **federate A→B (feature, owner→joiner)** | PASS |
| **federate B→A (feature, joiner→owner, bidirectional)** | PASS |
| **federate-continuous (2nd A→B write — live stream, not one-shot)** | PASS |

This exercises the **real joiner-resolves-its-own-topic path** (the topic-split
bug's home) that the 2-peer integration rigs bypass.

---

## Per-content-type bidirectional matrix (real binary trio)

Driver: `papercusp-desktop/bin/two-instance-content-matrix-smoke.sh` (real binary,
3 peers, A owner / B joiner / C late-joiner). Each cell: write `origin='local'` on
src → the capture trigger enqueues to `substrate_outbox` → peer-log → the dst
projection re-applies `origin='remote'` within a bounded poll.

<!-- MATRIX_RESULTS -->
_(matrix run in progress — table filled on completion)_

---

## Late-joiner backfill + negative isolation

<!-- BACKFILL_NEGATIVE -->
_(in progress)_

---

## Reusable live-test runbook

Two scripts, both sourcing `papercusp-desktop/bin/lib/federation-asserts.sh`:

1. **Headline (create→publish→join→feature-federation), proven:**
   ```
   cd papercusp-desktop
   HIVE_SMOKE_MODE=sidecar bin/two-instance-hive-from-repo-smoke.sh \
     /home/marsh-office/.cargo-target/release/bundle/deb/Papercusp_0.0.2_amd64.deb
   # MODE=deb runs the real binary; the on-disk .deb needs the A-001 luxon fix first.
   ```

2. **Full Lane A matrix + backfill + negative (real binary trio):**
   ```
   cd papercusp-desktop
   bin/two-instance-content-matrix-smoke.sh [path/to/Papercusp_*.deb]
   # extracts the .deb, injects luxon into the extracted sidecar (A-001), launches
   # A/B/C under Xvfb:152, runs the matrix, then LEAVES the trio up for lanes E/G.
   # ports: ~/.papercusp-lane-a-fed/instances.env   ·   stop: ~/.papercusp-lane-a-fed/stop.sh
   ```

Verify federation by each instance's embedded PG: `psql
postgresql://harness_admin:harness_admin_pwd@localhost:<pg>/papercusp` and check
the `origin` column (`local` = wrote here, `remote` = federated in).

---

## Gaps left open

<!-- GAPS -->
_(filled on completion)_
