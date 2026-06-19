# Brief I — A-003: hive_members / hive_settings reach a joiner (+ revocation)

Owner: su-d2230 (Claude). Lane: substrate fix — the joiner projection binding.
Disjoint area: `register-all.ts` (binding) · `hive-federation.ts` (gate) · `boot.ts`
(boot + rekey wiring). Coordinated with J (su-46b7a, fed_hlc/D-001) + H (su-dc9db,
swarm.ts) — no source overlap realized.

## Dimension verdict: **YELLOW → GREEN-on-deploy**

The fix is **landed + teeth-verified** at the two seams the brief allows for the
joiner path ("the binding resolver directly" + a real-apply integration test). The
end-to-end **live witness is deploy-gated**: the running pair (`shared-hive-retest`)
runs the shipped `Papercusp_0.0.2` `.deb`, which **predates this fix** — so it
re-confirms the BUG, not the fix (same constraint Brief G/L hit; git-sync owns the
push, a fix-built artifact carries it). Flip to GREEN when the content-matrix smoke
on a fix-`.deb` shows `hive-settings`/`hive-members` crossing to B `origin=remote`.

---

## Root cause (pinned EI-1591 su-963ee; live-confirmed this session)

A joiner boots the **member** harness. The `hive_members`/`hive_settings` projection
guards demux on the **hive-HOME** slug (`hive-members.ts:94`
`row.hive_home_slug !== opts.harnessSlug`; `hive-settings.ts:66` likewise), but
`register-all.ts` built those projections with the **member** slug — so every
home-grained op the member's merge reads off the shared Hive topic was **dropped**.

**Live confirmation (read-only psql on the running pair, A=17692 owner / B=22267
joiner):** A's `hive_members`(`hive_home_slug=hello-world-hive`, origin=local) +
4 `hive_settings`(`harness_slug=hello-world-hive`, origin=local) — and B has only its
OWN local rows; **zero `origin=remote`** hive_members/hive_settings on either side.
Decisively: **both peers use the SAME slug `hello-world-hive`** for these rows — so it
is NOT a slug mismatch, it is the member-vs-home projection binding. The member's
merge crosses everything else (8/11 types) but drops these two.

**Why the registered remote_hive HOME view doesn't save it:** the join flow
(`join-hive.ts`) materializes the `remote_hive` home view + re-keys the MEMBERS
(steps 2/2b/2c) but never boots/binds a home-slug apply; the member harness is the
only thing on the Hive topic reading A's home-log ops, and it was member-bound.

**Revocation half (the S0 escalation):** `boot.ts` seeds/refreshes the joiner's
admission union from `loadRevokedHivePubkeys(<home>)` ← `hive_members`. With
`hive_members` never landing on the joiner, the revoked set is ∅ → a revoked member
is never refused. So A-003 breaks member revocation for joiners (compounds C-001).

---

## The fix (Move 1 — mechanical, no product decision)

Bind ONLY the two hive-home-grained projections (`hive_members` +
`hive_settings`) to the **hive-HOME slug** when — and only when — the harness is a
**joiner's** member (its Hive home is a `remote_hive` view). The already-running
member merge then lands the ops it currently drops; `loadRevokedHivePubkeys(<home>)`
then finds the federated `revoked_pubkeys`, so revocation reaches joiners **for
free** (no extra code — the existing boot seed/refresh reads the now-present rows).

Three surgical edits:

1. **`projections/register-all.ts`** — `RegisterAllOpts.hiveHomeSlug?`; in
   `buildHarnessProjections`, build `buildHiveSettingsProjection` +
   `buildHiveMembersProjection` with `harnessSlug = hiveHomeSlug ?? harnessSlug`
   (every other projection stays on the member slug). Exported `buildHarnessProjections`
   for testing. Both `registerAllHarnessProjections` + `buildHarnessProjectionApply`
   derive from it, so they never drift.

2. **`hive-federation.ts`** — `joinerHiveHomeSlug(ws, slug)`: returns the home slug
   iff the Hive home is a `remote_hive` (joined) view (the joiner topology), else
   `null`. Uses the SAME `remote_hive` registry signal `resolveHiveSwarmBinding`
   keys the joiner topic on — so the rebind triggers exactly when the joiner topic
   does. Returns `null` for an OWNED hive's member (the owner home owns the write
   side → an owned member must NOT rebind, or it would double-apply the owner's own
   rows as `origin='remote'`) and for a non-hive harness.

3. **`boot.ts`** — resolve the joiner hive-home slug (gated on a `hive` swarm
   binding so non-hive boots skip the read; fail-open) and thread it into the
   projection wiring. Resolved at boot **AND re-resolved on `rekey`** — a FIRST join
   boots the member on the gh topic (no `hive_slug` yet → `null`) then re-keys onto
   the Hive topic AFTER join stamps `hive_slug` + the remote_hive home
   (`join-hive.ts` 2/2b precede the 2c re-key), so the re-key is where the rebind
   actually engages; a later restart boots straight onto the Hive topic and engages
   it at boot. `scopedApply` became a `let` so `rekey` can rebuild it
   (`mergeOnePass` reads the CURRENT `scopedApply` each pass); an `applyOverride`
   (the rigs) is never rebuilt.

### Why not route revocation through the `contributors` seam (option b)?
Narrower (revocation-only) but leaves the member-list/settings gap; option (a)
closes both with one change and matches the design doc's Move 1 ("finish *hive is
the top-level federation unit*"). Chosen.

---

## Tests (teeth-verified: green → neuter → RED → restore → green)

1. **`projections/register-all-hive-home-binding.integration.test.ts`** (real
   full-schema PG via `createOrgTestDb`; drives the REAL `buildHarnessProjectionApply`
   dispatch with federated `origin=remote` ops — NOT a hand-bound projection):
   - **RED/GREEN pair:** a member-slug apply with NO `hiveHomeSlug` DROPS the
     home-grained `hive_members`+`hive_settings` ops (the A-003 bug); WITH
     `hiveHomeSlug=HOME` the same ops LAND under the home slug.
   - **Revocation:** a federated `revoked_pubkeys` lands where
     `loadRevokedHivePubkeys(<home>)` reads — ∅ without the fix, `['bad-pk']` with it.
   - **Surgical:** the rebind still demuxes — an op for a DIFFERENT hive home is
     dropped (not blindly accepted).
   - Teeth: neutering `register-all`'s `hiveScoped` → exactly the two GREEN
     assertions go red; the bug + surgical stay green. Confirmed.

2. **`hive-federation.test.ts`** (+3 cases, PG-free, mocked reads) — the rebind
   GATE: a JOINED (remote_hive) member → the home slug; an OWNED hive's member (even
   published) → null; a non-hive harness → null. Teeth: neutering the `remote_hive`
   check (always return home) → the owned-member case goes red. Confirmed.

**Coverage boundary (honest):** every rig (`composition-rig`, `_cross-peer-rig`,
`hive-two-peer-federation`) boots with `applyOverride` + a `kind:'local'` binding,
so NONE exercise the real boot/rekey→`joinerHiveHomeSlug`→binding wiring (the brief
flags this: rigs bypass `defaultResolveSwarmBinding`). The binding mechanism and the
gate are each teeth-verified directly; the WIRING that joins them in boot/rekey is
proven end-to-end only by the **live witness** (deploy-gated, below).

## Regression

- `lib/sync/hyperbee/projections/*` unit: **180/180** green (incl. `register-all.test.ts`).
- `cross-peer-coordination.integration`: **9/9** green (boot.ts change is rig-safe —
  `applyOverride` + `kind:'local'` skip both the boot gate and the rekey rebind).
- `hive-members.integration` + `hive-settings-store.integration`: green.
- `tsc --noEmit`: my 5 files clean (the repo has many PRE-EXISTING unrelated errors).
- **NOTE (not mine):** `federated-column-completeness.integration.test.ts` is RED for
  all 12 tables — `Dropped: fed_hlc`. That is **J's mig `314-d001-hlc-ordering-key.sql`**
  (su-46b7a's D-001 `fed_hlc` column) needing the mapper/allowlist updated; flagged to
  J. A-003 touches no columns/mappers — unaffected.

## LIVE WITNESS (2026-06-19, instrumented, :180) — A-003 is TWO-SIDED; the receive-side fix is NECESSARY but the dominant blocker is SEND-SIDE

Ran the env-gated `[A-003]` trace witness on a fresh-from-staging integrated
fix-sidecar (`/tmp/a003-trace.sh`, NO SKIP_INVITE, real binary, Xvfb :180). The fix
bundles (`joinerHiveHomeSlug`×6, `[A-003]`×5). Result: hive_members/hive_settings
**still don't cross** (B: 0 rows) — but the root cause is now decisively pinned, and
it is NOT the receive-side binding.

### The receive-side rebind FIRES correctly (my fix works)
B's `inst-b.log`:
```
[A-003] boot hello-world:  swarmBinding.kind=topic  hiveHomeProjectionSlug=<none>
[A-003] resolve hello-world: joinerHiveHomeSlug=hello-world-hive
[A-003] rekey hello-world: binding.kind=hive next=hello-world-hive prev=<none> rebind=true
```
`joinerHiveHomeSlug` resolves the right slug (no null, no throw); the rekey rebind
**fires** and rebuilds the scoped apply with a `hive-members`/`hive-settings`
projection bound to `hello-world-hive` (verifiable: `buildScopedApply` →
`buildHarnessProjections({hiveHomeSlug})` → re-registered; `mergeOnePass` re-reads
`scopedApply` each pass). So the receive-side is correct. (The boot binding is
`kind=topic` from the stored shared.json topic — the boot-time hook correctly skips
and the **rekey** path is the one that engages.)

### The SEND side is broken — the ops never leave the owner (decisive PG evidence, A=19494)
- A wrote `hive_members`(1) + `hive_settings`(4) under `hello-world-hive`, origin=local. ✓
- **A's outbox rows for those tables are `drained_at = NULL` (NEVER drained)** — while
  every MEMBER-slug content table (features/coord/plans under `hello-world`) is
  `drained=t`. The outbox-drain runs `WHERE harness_slug = handle.harnessSlug` per
  **booted** harness; `drained_at=NULL` ⇒ the `hello-world-hive` harness's drain never ran.
- **A's hive-HOME harness `hello-world-hive` is NOT on the hive topic** —
  `inst-a.log` `joined topic` shows only `hello-world` (member) + `spoon-knife` (the
  2nd hive's member). NEITHER hive-HOME harness federates; only members do.

### Root cause (pinned)
`hive_members`/`hive_settings` are captured to the outbox scoped to the **hive-HOME**
slug, but **hive-HOME harnesses (`kind:'hive'`) do not federate their own content** —
they neither drain their outbox nor join the Hive topic; only member harnesses do. So
hive-home-scoped content **never enters federation**, regardless of any receive-side
binding. This is su-963ee's DESIGN-doc **Move 1 "increment 2"** (the Hive's
non-member harnesses draining onto the Hive's peer-log) — declared but unbuilt.

### Fix direction (architecture decision — coordinated, not a drive-by)
- **(a) Federate the hive-home harness** (su-9140a's recommendation, cleaner Move-1):
  boot the hive-HOME harness onto the Hive topic + wire its outbox drain on the OWNER
  so its log carries hive_members/hive_settings. B's member then admits A's hive-home
  log and **my receive-side rebind applies it** → end-to-end. (Mind A-002's
  multi-harness-on-one-muxer hazard — H's domain.)
- **(b) Re-scope the capture** so hive_members/hive_settings ride a MEMBER harness's
  outbox/log (which already federates + which B's member reads). Smaller, but
  "which member" is ambiguous for a multi-member hive.

Either way, **my receive-side rebind is a required component of the end-to-end fix**
and stays in the tree. The K-2 revocation half is now **subsumed by the owner's C-001
= RE-KEY decision (Move 2)** per su-9140a.

## Done / verdict
**RED — two-sided, send-side dominant.** Receive-side (the joiner projection rebind)
is **landed + teeth-verified + fires live** — necessary, but insufficient alone. The
dominant blocker is the **send-side**: hive-HOME harnesses don't federate their
content, so hive_members/hive_settings never leave the owner. That is an architecture
fix (Move 1 "increment 2"), overlapping A-002/su-963ee's Move 1 — handed to the
hive-federation architecture coordination with the precise spec above. GREEN requires
the send-side fix + a re-witness (A's rows present on B `origin='remote'`).
