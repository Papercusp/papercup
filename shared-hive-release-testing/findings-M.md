# Brief M — Desktop UI: share flow + the G-004 live status surface — findings

Owner: su-d53bf (Claude). Lane: desktop UI shared-hive journey + **G-004** (the
missing live peer/sync status surface). Continuation of Brief G (desktop UX/honesty).

**Headline:** G-004 (the gap Brief G named — *the desktop has no live federation
status surface*) is now **CLOSED in code**: a minimal, honest, live peer/sync status
surface is **shipped + teeth-verified at two layers** (route + component, 14 tests).
The honesty fixes G-001/G-002/G-003 are confirmed present in the staging tree. The
remaining thread is a **live GUI render** on a binary built with this code (the
existing fix-`.deb` predates G-004) — covered today by the component tests, exactly
as Brief G covered its honesty render.

**DEPLOY-LIVE CLOSURE (su-1c8bc, 2026-06-20 ~03:20):** the G-004 route is now
**verified live on the deployed `:3070`** (after main advanced f9464a9fc→fbd1c134c at
the 02:18 green-checkpoint, deploying the EI-1618 wiring). `GET /api/discovery/
federation-status` on the running operator returns the surface with the new EI-1618
`substrate.drain` field present + correct: `substrate` keys = `[active, bootedHarnesses,
booting, degraded, drain, healthy]`, `drain = {stalledHarnesses:0, worstUndrainedCount:0,
worstOldestUndrainedAgeMs:null}` (honest zero-drain — no booted harness is stalled). So
the route half of G-004 + the EI-1618 drain-health wiring are PROVEN on the real deployed
binary, not just in tests. The only thing still pending is the pixel-level GUI screenshot
of `HiveFederationStatus` (a VirtualGL drive, never `:0`) — the same optional last-mile
already accepted as covered by the component render tests. WI-254 (the proactive periodic
drain reconcile, EI-1618 item 2) is BUILT + tested (30 tests), shipped default-OFF
(`PAPERCUSP_FEDERATION_DRAIN_RECONCILE=1`) pending an enablement review.

---

## UPDATE (continuation, su-1c8bc) — EI-1618 drain/sync-health WIRED into G-004

A continuation session (su-1c8bc, with the coord MCP the prior Brief-M session lacked)
picked up su-9140a's explicit handoff: the drain-health DETECTION logic
(`assessHarnessSubstrateHealth(drainStats)` in `health.ts` + `resolveDrainStats` /
per-harness `drain` in `in-process-status.ts`, 18 tests, already landed + teeth-verified
by su-9140a) was DONE but **not wired into the live G-004 read** — the route called
`getInProcessSubstrateStatus()` with no resolver, so a stalled outbox (captured but not
federating — the EI-681 class) still reported "healthy" through `/api/discovery/
federation-status`. That last-mile is **now landed + teeth-verified**, making G-004
honest about **SYNC**, not just boot/reach:

- **New loader** `packages/operator-core/lib/sync/hyperbee/load-drain-stats.ts`
  (`loadSubstrateDrainStats`) — one grouped read
  `SELECT workspace_id, harness_slug, COUNT(*) AS undrained, MIN(ts) AS oldest_ts FROM
  harness_shared.substrate_outbox WHERE drained_at IS NULL GROUP BY 1,2` → a Map for the
  route's sync resolver; `oldestUndrainedAgeMs = now - MIN(ts)`. **COLUMN CORRECTION**
  (verified against `000-baseline.sql` + `outbox-drain.ts`): the real columns are `ts`
  (capture epoch-ms) + `drained_at` (epoch-ms, NULL = undrained) — NOT the `created_ts`
  (handoff recipe) / `captured_ts` (in-process comment) either doc named; the recipe's
  `EXTRACT(EPOCH FROM now()-MIN(created_ts))` SQL would have errored. 6 tests
  (teeth-shaped: exact age math, drained_at-only filter, skew clamp, throw→empty).
- **Route** `federation-status.ts` — prefetches the drain map via
  `getOrgPg().sql.unsafe` and passes `resolveDrainStats`, so a stalled harness now flips
  off `healthy` AND rolls into a new `substrate.drain { stalledHarnesses,
  worstUndrainedCount, worstOldestUndrainedAgeMs }` summary (stall lag mirrors
  `health.ts`'s 60s `drainStalledThresholdMs`). Best-effort: a PG failure degrades to
  zero-drain (honest), never throws the read. Test: 7 (was 4; +3) — teeth-verified
  (drop the resolver → the wiring test RED).
- **Component** `HiveFederationStatus.tsx` — new pure `drainLabel` + a `fed-drain`
  sync-stall row that renders ONLY when stalled ("⚠ not syncing — N harness(es) with
  content captured but not federating…"), down dot; **never** a positive "synced"
  claim (silence = the honest healthy state). Scope note updated (sync-health is
  install-wide; per-hive content-sync peer counts still not surfaced). Test: 15 (was 10;
  +5) — teeth-verified (neuter `drainLabel` to claim "synced" → 3 RED).
- **Verification:** loader 6/6, route 7/7, component 15/15, neighbors (HivesTab,
  WorkbenchHiveDirectoryPanel) 12/12 — all GREEN; touched files tsc-clean (operator-core
  + operator-vite). Both honesty layers teeth-verified (each lie → RED → restore →
  GREEN). NOT committed by me — git-sync owns commit+push; left clean in the tree.

**EI status after this wiring:**
- **EI-1618** (silent-stall observability gap — "a stuck outbox reports healthy"):
  proposed items **1 (per-harness undrained metric → off-healthy) + 3 (honest desktop
  "not syncing" copy)** are DONE + tested. Item **2 (a periodic ACTIVE federation
  reconcile / self-check)** is a separate proactive mechanism, not part of the on-read
  surface — carried forward as a follow-up (the on-READ silent-stall is now visible;
  an active periodic reconcile that auto-detects without a reader is the residual).
- **EI-1599** (per-hive content-replication peer count): **PARTIALLY** addressed — the
  desktop can now honestly show install-wide "not syncing" when an outbox stalls. The
  full ask (a TRUE per-hive content-peer count + last-merge timestamp) still needs Brief
  H's per-hive swarm/topic connection accounting — EI-1599 stays OPEN for that, scope
  note unchanged.

---

## What shipped (G-004 — the live federation status surface)

The brief's G-004 directive: *"design + implement a minimal peer/sync indicator
(peer count for the active hive, last-sync/drained state) — OR document the absence
honestly + an EI."* **Implemented**, with the honest signals that actually exist
today (see M-001 for why the naive version would lie).

### Backend — `GET /api/discovery/federation-status` (read-only, loopback)
`packages/operator-core/lib/endpoint-route/routes/discovery/federation-status.ts`
(new) + registered in `routes/index.ts`. Mirrors the `GET /api/discovery/hives`
pattern (`defineTool({ method:'GET', path:'/discovery/federation-status', auth:'loopback' })`).
Returns:
- `hives[]` — per **owned** hive: `{ hiveId, title, visibility, memberCount,
  reachablePeers }`. `reachablePeers` = `HiveDirectory.reachablePeersForHive(hiveId)`
  — peers on **that hive's announce/discovery topic** (who can find + join it). Owned,
  non-private only; the directory `owned` map is registry-hydrated at boot
  (`ensureHiveDirectoryWired` → `listOwnedHiveMeta`), so it is accurate once wired. A
  private hive is `0` by construction (never announces) — the route short-circuits it
  rather than asking the seam, so it can never accidentally report a non-zero "reach"
  for a hive that doesn't announce.
- `substrate` — install-wide local boot health from `getInProcessSubstrateStatus()`:
  `{ active, bootedHarnesses, healthy, booting, degraded }`. "Is my federation
  infrastructure up", **not** a per-peer sync claim.

### UI — `HiveFederationStatus` mounted in the always-visible Hives tab
`apps/operator-vite/src/components/left-sidebar/HiveFederationStatus.tsx` (new),
mounted in `HivesTab.tsx` (gated on `active` so it polls only while the tab is open;
10s cadence). Renders the honest copy:
- announced + reach>0 → **"discoverable to N peer(s)"** (live dot).
- announced + reach=0 → **"no peers connected yet — broadcasting into the void"**
  (down dot) — the **corrective surface for the G-001 stranded-publish blind spot**:
  a user who published to 0 peers can now SEE it. (Mirrors `ShareHiveForm`'s honest
  0-peer copy.)
- private → **"private — not announced"** (NOT "0 peers", which would imply a failed
  reach).
- substrate line → **"substrate active · N harnesses booted · M healthy · ⚠ K
  degraded"** (down dot when degraded), labeled install-wide.
- a permanent scope note: **"Reach = peers who can discover this hive on its announce
  topic. Per-hive content-sync peer counts are not yet surfaced."**

### Tests — teeth-verified at BOTH layers (the honesty is genuinely enforced)
- `…/routes/discovery/federation-status.test.ts` (4 tests, GREEN). **Teeth:** neutered
  the reach mapping to a constant `0` → the reach-mapping test went RED
  (`reachablePeers 3 → 0`) → restored → GREEN. Covers reach mapping, private→0,
  empty-list, and the loopback 403 gate (mirrors `hives.test.ts`).
- `…/left-sidebar/HiveFederationStatus.test.tsx` (10 tests, GREEN). Pure
  `reachLabel`/`substrateLabel` honesty fns + rendered-DOM assertions. **Teeth:**
  neutered `reachLabel` to return `'synced'` for the 0-peer case → **2 tests went RED**
  (the pure-fn honesty assertion AND the rendered stranded-DOM test both caught the
  lie: `expected 'synced' to be 'no peers connected yet — broadcasting into the void'`)
  → restored → GREEN. The assertions are honesty-shaped: a 0-peer hive must NOT read
  "synced"/"connected"; a private hive must NOT read "0 peers".
- No regressions: `HivesTab.test.tsx` (7) + `WorkbenchHiveDirectoryPanel.test.tsx` (5)
  still GREEN after mounting the new surface. My touched files are tsc-clean
  (operator-core + operator-vite); the only `routes/index.ts` tsc errors are
  **pre-existing** on HEAD (verified by stashing my edit — same errors shift by my 2
  added lines).

---

## M-001 — the honesty constraint that shaped the surface (an architectural finding)

**Why the surface is scoped to "directory reach + install health," not "synced to N
peers."** I deliberately did NOT build a "peers: N / synced" per-hive indicator, because
**no clean per-hive content-substrate peer count exists** — and inventing one would be
the exact dishonesty this surface exists to prevent (the brief: "the UI never lies").

Evidence:
1. **`reachablePeersForHive` is OWNED-ONLY + directory-scoped.** `hive-directory.ts:235`
   reads `this.owned.get(hiveId)` → returns 0 for a *joined* hive. It counts peers on
   the **announce/discovery** topic (`openChannelCount(topicHex)`), NOT content
   replication. A naive "peers connected: reachablePeersForHive" would show **0 for
   every joined hive** (a lie — the joiner IS connected) and would conflate
   discoverability with sync.
2. **The content substrate uses a SHARED swarm.** `swarm.ts` replicates via a single
   shared Hyperswarm (`connections` is process-global across all hives/harnesses — the
   same singleton Brief H/A-002 is fixing). There is no exposed per-hive
   content-peer count, only a process-wide connection iterable.
3. **The honest signals that DO exist** are what I surfaced: per-owned-hive **announce
   reach** (precise: "discoverable to N", not "synced") + install-wide **substrate
   health**. Both are labeled for exactly what they are.

→ **EI filed: a true per-hive content-replication peer count + last-merge timestamp.**
That is the signal a full "is hive X syncing with peer Y" surface needs; it requires
either per-hive swarm/topic connection accounting or a replication-progress probe, and
it composes naturally onto Brief H's per-hive swarm work. Until then, the shipped
surface is honest about its scope (the permanent scope note + the EI), not silently
partial.

---

## Honesty fixes from Brief G — confirmed present in the staging tree

(Not re-litigated here — see findings-G. Confirmed in code as the baseline this lane
builds on:)
- **G-001** `reachablePeers` count-by-topic — `hive-publish.ts:125`
  `dir.reachablePeersForHive(meta.hiveId)`. ✅ present.
- **G-002** honest invite-join copy — `CreateHarnessPicker.tsx:605-608` "✓ Subscribed
  to this invite … won't appear if the invite was withdrawn or the link is wrong". ✅
- **G-003** discover-panel poll + Refresh — `WorkbenchHiveDirectoryPanel.tsx:59`
  `DIRECTORY_REFRESH_MS = 30_000` + `data-testid="hive-directory-refresh"`. ✅
- **ShareHiveForm** honest 0-peer copy — `ShareHiveDialog.tsx:371` "no peers are
  connected yet — it becomes discoverable once peers come online". ✅

---

## Flow matrix (the brief's 4 scenarios)

| # | Scenario | State | Evidence |
|---|---|---|---|
| 1 | **ShareHiveDialog** honest reach (public + invite) | ✅ code-honest + **BACKEND-LIVE-PROVEN by Brief L** | Brief L (su-ed300, findings-L): G-001 invite publish `reachablePeers=0` (was 1) on the fix-`.deb`, real 2-peer. Component copy teeth-tested (`ShareHiveDialog.test.tsx`). GUI pixel render = pending. |
| 2 | **Discover panel** drops withdrawn hives on poll/Refresh | ✅ code-present (G-003) + **BACKEND-LIVE-PROVEN by Brief L** | Brief L: withdrawn hive drops from discover ~3s on the real binary. Component-tested. |
| 3 | **Invite-join** honest-failure copy | ✅ code-present (G-002) + **BACKEND-LIVE-PROVEN by Brief L** | Brief L: dead secret → `joined:false/found:false/subscribed:true` (was `joined:true`) on the real binary + a route-level fix (`confirmInviteAnnounce`). Component copy teeth-tested. |
| 4 | **G-004** live status surface | ✅ **SHIPPED + teeth-verified + LIVE-PROVEN** | route+component tests (14, teeth-verified both layers); CONFIRMED bundled in the real `.deb` (route in `serve.mjs`, component in the `HivesTab` SPA chunk); **route LIVE on the real integrated `.deb`** — A's 2 owned hives `reachablePeers:1` == B (the 1 peer that discovered exactly those 2). GUI pixel screenshot = optional bonus last-mile. |

---

## Live verification status (honest)

- ✅ **G-004 CONFIRMED BUNDLED in the real shipped `.deb`** (artifact-level evidence,
  2026-06-19). ed300's current-staging fix-`.deb` (`/home/marsh-office/.cargo-target-L/
  .../Papercusp_0.0.2_amd64.deb`, 08:42, built from the working tree) carries BOTH halves
  of G-004:
  - **route** — `usr/lib/Papercusp/sidecar/serve.mjs` (41.7MB) contains
    `discovery/federation-status` ×3 (sanity: `reachablePeersForHive` ×4). My route
    esbuild-bundles from the working-tree operator-core source.
  - **component** — `usr/lib/Papercusp/sidecar/spa/.../HivesTab-Bo1MV5ob.js` contains
    `broadcasting into the void` + `hive-federation-status` + `fed-scope-note` (my
    component bundles into the HivesTab chunk it mounts in; prod vite preserves the
    string literals + data-testids).

  So the surface SHIPS in the real packaged app — the only remaining gap is driving the
  rendered pixels. (Earlier note that the 08:07 `.deb` lacked G-004 was correct — that
  build predated G-004; the 08:42 rebuild has it. Tar gotcha: `dpkg-deb --fsys-tarfile`
  paths have NO `./` prefix — `tar -xO usr/lib/...`, not `./usr/...`.)

- ✅ **G-004 ROUTE LIVE-PROVEN on the real binary, against ground truth** (2026-06-19,
  on su-9140a's integrated `.deb` 2-peer witness pair — `/tmp/integrated-witness/
  Papercusp_integrated.deb`, A=papercupai :18754 / B=aviynw :23498, real embedded-PG +
  live Hyperswarm federation). Evidence (preserved in-tree — the pair was torn down
  after the witnesses, so the raw curl output is captured durably here):
  `shared-hive-release-testing/evidence-M-g004-backend-live.txt`.
  - **A (owner)** `GET /api/discovery/federation-status` →
    `substrate {active, bootedHarnesses:2, healthy:2}` + 2 owned public hives
    (`spoon-knife-hive`, `hello-world-hive`) each **`reachablePeers: 1`**.
  - **B (joiner)** → `substrate {active, healthy:1}`, `hives: []` (owns none — honest
    empty, not a fake).
  - **GROUND-TRUTH MATCH:** B's `/api/discovery/hives` discovered **exactly those 2
    hives** → so A's `reachablePeers: 1` per hive == B, the single connected peer. The
    reach number is exactly correct against the live federation. A's own
    `/api/discovery/hives` = 0 (an owner doesn't re-discover its own published hives —
    correct). This is the L-equivalent backend-live proof, now for G-004: the route
    returns honest, ground-truth-correct per-hive reach + substrate health on the real
    packaged binary.
- ✅ **Tests** — 14 new, teeth-verified at both layers; neighbors green; tsc-clean.
- ⏳ **Live GUI render of the new surface** — pending a build with G-004 (a `npm run
  dev` shell from staging hot-reloads the component + compiles the host with the route;
  or a fresh `.deb`). The honesty *render* is covered by the component tests in the
  interim (same posture findings-G took). Driven on a sandbox Xvfb `:1xx`, **never `:0`**
  (fleet-halt).
- ⏳ **Live render of G-001/G-002 honest copy** on the fix-`.deb` (scenarios 1–3) — the
  fix-`.deb` is ready; a VirtualGL pass confirms the rendered copy. Queued behind Brief
  K on the `:154` pair (per su-9140a's coordination) / a fix-`.deb` single instance.

---

## Brief M dimension verdict: **GREEN** (data layer fully live-proven; GUI pixel screenshot the one optional last-mile)

**G-004 is shipped + honest + teeth-verified + LIVE-PROVEN on the real binary against
ground truth.** The brief's "implement a minimal one" is satisfied, it directly closes
the stranded-publish blind spot, and the live route returns honest, ground-truth-correct
data on the real packaged `.deb`. No S0/S1: there is no "synced while stranded" lie (the
surface refuses a sync claim it can't back — M-001), and the corrective surface for a
0-peer publish now exists + renders the real reach.

**Evidence stack (all four scenarios):**
- **Scenarios 1–3** (ShareHiveDialog reach / Discover withdrawn-drop / invite-join copy)
  — **BACKEND-LIVE-PROVEN by Brief L** on the real fix-`.deb`, 2 peers (G-001 invite
  `reachablePeers=0`, G-002 dead-secret `joined:false`, G-003 withdrawn-drop ~3s) +
  honesty copy teeth-verified in component tests.
- **Scenario 4 (G-004)** — (a) route + component **teeth-verified** at both layers (14
  tests; neutering each → RED); (b) **CONFIRMED BUNDLED** in the real shipped `.deb`
  (route in `serve.mjs` ×3, component in the `HivesTab` SPA chunk); (c) **route
  LIVE-PROVEN on the real integrated `.deb`** — A's 2 owned hives show `reachablePeers:1`
  == B (the single peer that discovered exactly those 2 hives), B's owned-list empty +
  honest, substrate health live + accurate. The reach matches the live federation
  exactly.

**The one optional last-mile:** a GUI **pixel** screenshot of the rendered
`HiveFederationStatus` surface (the component drawing the now-proven data). This is the
literal-most reading of "driven on the real shell"; it is **covered** by the bundled
component + the jsdom render tests (which assert the exact rendered copy against the
exact data shape the live route returns) + the live route proof — the same accepted
posture lane G took ("the rendered copy is covered by component tests"). A release `.deb`
has no debug bridge, so this is a screenshot-only VirtualGL drive on a sandbox Xvfb
`:171` (never `:0`); pursued as a bonus, not a blocker. The integrated `.deb` witness
pair (su-9140a, DISPLAY :158) carries G-004 and is left up for this.

**Net:** Brief M's federation-honesty journey is GREEN — every scenario is either
live-proven on the real binary or backend-live + teeth-verified, and the new G-004
surface is shipped, bundled, and live-correct. (This is a *stronger* evidence position
than lane G shipped at, since G-004 now has the live route-vs-ground-truth proof on the
real packaged binary, not just component tests.)

**Landed this lane (low-risk, in-lane, GUI-free):** the `discovery:federation-status`
read + the `HiveFederationStatus` surface in the Hives tab + 14 teeth-verified tests;
M-001 (the per-hive content-peer-count honesty constraint) + its EI.
