# Brief I — A-003: hive_members / hive_settings reach a joiner (+ revocation)

Owner: su-d2230 (Claude). Lane: substrate fix — the joiner projection binding.
Disjoint area: `register-all.ts` (binding) · `hive-federation.ts` (gate) · `boot.ts`
(boot + rekey wiring). Coordinated with J (su-46b7a, fed_hlc/D-001) + H (su-dc9db,
swarm.ts) — no source overlap realized.

## Dimension verdict: **CODE-COMPLETE, but LIVE-RED — debugging (see "Live-RED debug log" at the end)**

A-003 turned out to be **two-sided** (receive AND send), and the send side is an
architecture fix, not a one-liner — see **Fix direction** below for the full a/a′/b
story. The complete path is now **landed + teeth-verified via approach (a′)**:
- **dc9db (swarm.ts/announce.ts):** the announce channel carries MULTIPLE log
  announces per topic + a SIGNED `harness_slug` origin field.
- **d2230 boot.ts half:** populate `harness_slug` in `buildAnnounce`; a slug-aware
  `onAnnounce` filter (`announceSlugInScope` — admit iff own-slug / rebind-home /
  legacy-absent; new `out_of_scope` reason) so one topic can carry many harnesses'
  logs WITHOUT cross-merge; re-applied the hive-home re-key (now safe).
- **d2230 receive-side rebind** (`register-all` `hiveHomeSlug` + `joinerHiveHomeSlug`
  + boot rekey) — committed; lands the admitted hive-home ops under the home.

Verification: full hyperbee suite **935 green / 1 skip**; every component teeth-
verified (announceSlugInScope 6 cases neuter→3 reject RED; the rebind RED/GREEN; the
re-key 21-test RED-on-neuter); + a **durable in-suite composition proof**
(`register-all-hive-home-binding.integration.test.ts`: slug-filter gate ↔ rebind apply
over the real apply + full PG). Typecheck clean.

**⚠ UPDATE — the live witness came back RED, not green.** su-9140a's content-matrix on
a fix-`.deb` (verified to carry my code) shows 28 member-scoped types federate but
`hive_settings`/`hive_members` still cross in ZERO directions. The code is correct in
isolation + integration + the binary, but a live runtime gap remains in the
announce→admit→apply of A's hive-home log. **See the "Live-RED debug log" at the end of
this file** for the full ruled-out list + the prime suspect. Do NOT mark A-003 green
until `origin=remote` hive rows appear on the joiner live.

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

### Fix direction (architecture decision — coordinated)
The precise gap is **EI-681 hitting the hive-HOME harness**: the publish flow
(`hive-publish-from-repo.ts` `publishListingForMeta` step 7) re-keys each **member**
onto the Hive topic via `rekeyHarness` (so members federate) but **never the
hive-HOME harness** (it's repo-less → not in the `members` set). So the hive-home
substrate never joins the topic / drains its outbox.

- **(a) Re-key the hive-home in the publish flow** — ATTEMPTED + teeth-verified
  (mirror the member re-key for `meta.hiveId`), but **REVERTED**: dc9db (A-002) found
  the announce channel is keyed by **topic** (`pair({protocol, id: topic})`), so
  member + hive-home on one topic **collide** (last-writer-wins → risks regressing
  the *member's* announce, not just stalling the hive-home). (a) cannot ship until →
- **(a′) Re-key the A-002 announce channel by `(topic, harness)`** [dc9db's domain]
  → the hive-home can share the member's topic → (a) works → the hive-home federates
  epoch/membership content = the **foundation the C-001 RE-KEY (Move 2) depends on**
  (su-9140a). Bigger, but pays off twice.
- **(b) Re-scope the CAPTURE** (the `capture_substrate_outbox` trigger) so
  hive_members/hive_settings ride a MEMBER harness's log (which already federates +
  which B's member reads). Faster, but a stopgap the re-key undoes; "which member" is
  ambiguous for multi-member hives; overlaps J's op_hlc outbox work.

The (a′ vs b) decision is surfaced to su-9140a (lead) / dc9db (A-002) / su-963ee
(Move-1). **My receive-side rebind is a required component of EITHER path** and stays
in the tree (committed). The K-2 revocation half is **subsumed by the owner's C-001 =
RE-KEY decision (Move 2)** per su-9140a.

## Done / verdict
**RED — two-sided, send-side dominant.** Receive-side (the joiner projection rebind)
is **landed + teeth-verified + fires live** — necessary, but insufficient alone. The
dominant blocker is the **send-side**: hive-HOME harnesses don't federate their
content, so hive_members/hive_settings never leave the owner. That is an architecture
fix (Move 1 "increment 2"), overlapping A-002/su-963ee's Move 1 — handed to the
hive-federation architecture coordination with the precise spec above. GREEN requires
the send-side fix + a re-witness (A's rows present on B `origin='remote'`).

---

## Live-RED debug log (in progress — the green-rig/red-binary gap)

The integrated `.deb` content-matrix is RED: 28 member-scoped content types federate,
but **hive_settings/hive_members never cross A→B** (the hive-home log). Reframed by
su-9140a + dc9db: the hive-home **boots + joins the topic + peer_connects + drains its
outbox (6/6)** — so the send side is up; the gap is **announce→admit→apply of A's
hive-home log on the shared topic**.

**What's RULED OUT (verified):**
- MY code is correct in the tested binary (bundle grep: `announceSlugInScope`=`(e==null?
  true:e===t||n!=null&&e===n)`; the onAnnounce slug-filter; the rekey is **resolve-then-
  join** — my re-order landed). The re-order did NOT close the RED → not the bug.
- MY receive-side rebind resolves at runtime: traces show `resolve hello-world:
  joinerHiveHomeSlug=hello-world-hive` → `rekey hello-world: next=hello-world-hive
  rebind=true`. So on B's member `home` is correct → the slug-filter would ADMIT A's
  hive-home frame (`origin==home`). The admit step is NOT the (sole) break.
- The apply/rebind is integration-GREEN (register-all-hive-home-binding: hive_settings/
  members land under the home origin=remote).

**Prime suspect:** A's hive-home log announce not actually reaching B's member's
onAnnounce on the live wire (dc9db's (a′) multi-log accumulation), OR a timing race from
the FIRE-AND-FORGET re-key (A's hive-home joins the topic asynchronously relative to the
A↔B connection). The added per-frame `[A-003] slug-filter <h>: origin=.. → ADMIT/REJECT`
trace splits it: if B's member NEVER logs `origin=hello-world-hive`, the announce never
arrived (dc9db); if it logs `→ ADMIT`, the break is downstream (live merge/cursor).
**Next:** su-9140a's traced re-run (PAPERCUSP_A003_TRACE=1) → read B's slug-filter lines.

### Update — announce late-join REFUTED (read-only)

Checked the prime suspect: `joinHarnessSwarm` (swarm.ts:442-459) ALREADY handles the
shared-swarm late-join — after `swarm.on('connection', handler)` it iterates
`swarm.connections` and calls `handler(socket)` for every EXISTING socket, which runs
`openAnnounceChannel` → registers the harness's entry on the existing muxer's topic
state + `if (state.opened) flushTopicAnnounces`. So A's hive-home, even joining the topic
LATE (after the A↔B connection), DOES register + flush its announce on the existing
connection. The comment names this exact case. **So a late-join is not the gap.**

Every step now traces as correct on read: announce accumulation + late-join flush (dc9db,
verified) → B's slug-filter ADMITs (home resolves, verified via runtime traces) → admit
opens the remote log → shared-muxer cross-corestore replication (same mechanism the 28
member types use successfully) → rebind apply (integration-green). The ONE thing not
yet observed live is **whether B's member's onAnnounce actually receives + ADMITs A's
hive-home frame** — the `[A-003] slug-filter` trace answers it directly. Reduced
hypotheses, in order: (1) B never receives the hive-home announce despite the late-join
handling (a runtime/timing reason the static read can't see — e.g. the hive-home joins
the topic but A↔B never re-pairs the announce channel for the 2nd log; or the fire-and-
forget re-key boots the hive-home AFTER the matrix has already sampled); (2) B receives
but the merge doesn't replicate the hive-home's separate corestore log. BLOCKED on
su-9140a's traced re-run (coord down + not in /tmp); staying armed.
