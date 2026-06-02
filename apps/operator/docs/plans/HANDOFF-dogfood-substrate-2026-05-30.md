---
title: Handoff — dogfood substrate (Hyperbee sharing) continuation
slug: HANDOFF-dogfood-substrate-2026-05-30
created: 2026-05-30
owner: avi@storewolf.com
status: active
---

# Handoff: dogfood substrate (Hyperbee sharing) — continue here

> Every fact below was verified against source/git on 2026-05-30 before writing.
> Where something is unverified or a risk, it says so explicitly. Do NOT trust a
> claim in this file that you can re-check cheaply — re-check it; the repo moves
> under many agents.

## Context in one paragraph

The dogfood "sharing" feature = a per-harness **Hyperbee/Autobase substrate**
that replicates harness state (feature queue, contributors, PRs, etc.) between
machines over Hyperswarm. The audit (`apps/operator/docs/dogfood-audit-2026-05-30.md`)
found it was **write-only and never went online**: (a) nothing replayed a
harness's merged Autobase view back into Postgres, and (b) nothing wrote the
`.harness/shared.json` file that the boot path needs to join a swarm. This
session shipped both halves. What remains is frontend wiring + a live two-peer
verification.

## Session 2 (2026-05-31) update — TODOs 1-3 done, Option B binding system built

Shipped (all verified: tsc location-diff = 0 new errors; tests green; per-turn commits):

- **TODO 3 — BootHistoryKind drift** (`be200deb`). They were REAL TS2345 errors (not
  "widening"). Added `peer_connected` + `swarm_join_failed` to BOTH unions
  (boot-history.ts + BootHistoryTable.tsx) + the two `Record` maps; fixed the
  pre-existing `boot-all.test.ts:25` fake handle missing `swarm`.
- **TODO 2 — finalize re-boots the harness** (`bf25171b`). New `rebootHarness()` in
  boot-all.ts (= closeBootedHarness + bootSingleHarness); finalize calls it
  best-effort, flag-gated, surfaces a `swarm` field. **Process topology verified**:
  the substrate boots in the :3070 hono-host (`bin/host-bootstrap.ts`), which ALSO
  serves the finalize route → in-process reboot is safe (NOT a 2nd corestore). The
  `instrumentation-node.ts:~341` boot block is retired/dead (Next :3055 has no flag).
  Also hardened a pre-existing native-crash flake (the `83a12e90` real-boot test
  core-dumped on vitest worker teardown; now deterministic via a throwing resolver).
- **TODO 1 — binding/resolve route was ENTIRELY MISSING** (not stubbed). Confirmed via
  live curl: 404 on both :3070 and :3055. The binding SERVICE (resolveRepoBinding,
  createUnclaimedBinding) existed but was unexposed over HTTP. Built the full Option-B
  binding system (user-chosen over the minimal route):
  - `82d4891f` — exported `resolveRepoIdentity()` (returns the GitHub-resolved repo
    id/owner/repo EVEN with no binding row; resolveRepoBinding is now a thin wrapper) +
    stored `provisional_owner_github_login` on the binding cache (schema column + ALTER).
  - `0a07f3b3` — `POST /api/harness/binding/resolve` route (wraps resolveRepoIdentity,
    maps BindingServiceError→HTTP, registered in routes/index.ts).
  - `abd6fb7d` — finalize now creates the unclaimed binding row (createUnclaimedBinding),
    BINDING_EXISTS-safe, best-effort, surfaces a `binding` field.
- `91b6afe4` — fixed a pre-existing red test (DOGFOOD_REACTIVE_TABLES count 13→14 from
  another agent's `a6f30883`).

End-to-end path now exists: wizard → `/binding/resolve` (real github_repository_id +
existing_binding) → `/share/finalize` writes shared.json + creates binding row + reboots
to join swarm. **ShareWizard needs NO frontend change** — it already POSTs both routes.

### LIVE-VERIFIED (after a `systemctl --user restart papercup-dev-api.service`)
- gh-token: the operator uses `gh auth token` = the active `gh` account (**papercupai**,
  scope `repo`); confirmed it resolves `Papercusp/papercup` → id **1223568103**.
- `POST /api/harness/binding/resolve {github_remote:".../Papercusp/papercup.git"}` →
  **200** `{github_repository_id:1223568103, github_owner:"Papercusp", github_repo:"papercup",
  existing_binding:null}`. Unparseable remote → **400**.
- `POST /api/harness/:slug/share/finalize` → live (unregistered-slug probe returns the
  handler's JSON 404, zero side effects). A *real* finalize writes a git-committed
  shared.json + creates a binding + joins a swarm = a deliberate share; not exercised.
- **Live-fix `976c95ee`**: first real call 500'd — `shared_repo_binding_cache` didn't
  exist because the hono-host never runs the dogfood schema-ensure
  (`ensureAllDogfoodTables`/`wireDogfoodTriggers` have NO runtime callers; projections
  don't self-ensure). binding-service now self-ensures its LOCAL-only table.
  **Broader gap (NOT fixed, worth a pass):** wire `ensureAllDogfoodTables()` +
  `wireDogfoodTriggers()` into `bin/host-bootstrap.ts` — the read-loop's projection
  writers will also hit missing tables once a harness has ops to replay.

### Still remaining
1. ~~Live verification~~ DONE (above). A real share of papercup is the user's call.
2. **Live two-peer (P-079)** — still needs Tauri + 2 peers (unchanged).
3. **P-070 usage-events** — still types-only (no emitUsageEvent/rollupForContributor impl).
4. **PG→Hyperbee backfill** — still the ShareWizard `defaultRunBackfill` setTimeout(200) stub.
5. **Pre-existing, NOT mine**: auth-posture (D3) test flags several `/admin/*` routes
   (plans, locks, dogfood-substrate-*) as `auth:'public'` vs expected verified/trusted
   (confirmed 'public' on HEAD). Worth a separate auth pass.

## Session 3 (2026-05-31) — `sheets` is live-shared single-machine (substrate ON)

Per the user's call: dogfood the SHARED path on disposable `sheets`, NOT papercup
(papercup is actively-developed + papercusp-inside-papercusp self-reference = footgun).

Done + verified live this session:
- **Substrate enabled** on the `:3070` systemd host: added `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`
  to `apps/operator/.env.local` (the unit's WorkingDirectory is `apps/operator`; it sources
  `./.env.local`), restarted `papercup-dev-api.service`. `dogfood-substrate-status` → `enabled:true`.
- **Sheets shared**: `POST /api/harness/sheets/share/finalize` with a SYNTHETIC repo id (999000001;
  no real GitHub repo needed to test substrate mechanics — the swarm topic is just
  `sha256("…:gh:<id>")`). Wrote `/home/marsh-office/sheets-clone/.harness/shared.json`,
  response `swarm:{rebooted:true,state:"booted"}`. `binding:{created:false,error:"GITHUB_API_DOWN"}`
  is EXPECTED (synthetic repo doesn't exist; the claim layer is best-effort + not needed for replication).
- **Verified online**: `dogfood-substrate-status` → `booted:[{default,sheets}]`; boot-history
  `boot_start→boot_ok`; `dogfood-substrate-health` → `worstVerdict:"healthy"` ("no issues detected").

Single-machine validates "goes online + healthy." It does NOT prove replication.

### ⚠️ Code-verified finding (2026-05-31): TWO-PEER MERGE IS UNBUILT, not just untested

Before standing up a 2nd peer I traced the merge path. Multi-peer replication CANNOT work with
the current code — it's missing the writer-admission step:
- **`boot.ts:148` boots every peer `bootstrap: opts.bootstrap ?? null`**, and the flag-on boot path
  (`bootAllHarnessesForActiveWorkspace`) supplies no bootstrap → each peer is its OWN independent
  Autobase root.
- **The autobase root key is never surfaced** anywhere (no `base.key` export), and the join link
  (`papercusp://harness?topic=…&github=…&repo_id=…`, parsed in `url-scheme.ts` / `join-link.ts`)
  carries only topic + repo_id — **no autobase key**. So a joining peer can't bootstrap the sharer's base.
- **`addWriter` is HANDLED in `autobase-setup.ts`'s apply fn but NEVER EMITTED** — no code in the
  boot/swarm/join path produces an addWriter op or exchanges keys.

Net: two peers on the same topic connect over Hyperswarm + replicate raw cores, but each
materializes ONLY its own view. **Peer A's writes never reach peer B's projected PG.** This is the
designed-but-unbuilt writer-admission / bootstrap-key-exchange (the Model-B substrate rewrite / the
deferred gate arc, per `papercusp-trust-model-2026-05-31` + `papercusp-user-protection-gate-2026-05-31`).

**Consequence for "get sheets sharing working":** it needs BUILDING, not just testing. Minimal
read-replication slice = surface peer A's autobase key → carry it in the join link / shared.json →
pass it as `bootstrap` to the joining peer's boot (peer B then materializes peer A's view).
Bidirectional writes + auth (addWriter admission, op signing) is the larger gate-arc work. A
2nd-peer stand-up today would only DEMONSTRATE the gap (connect-but-no-merge), not close it.

Revert when done testing: remove `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1` from `.env.local` +
`rm /home/marsh-office/sheets-clone/.harness/shared.json` + restart.

## Session 4 (2026-06-01) — Model B substrate Stages 0-7 implemented + two-peer test

The Model B substrate rewrite (per `papercusp-substrate-model-b-rewrite-2026-05-31`)
that the Session-3 finding above flagged as UNBUILT is now implemented through
**Stage 7**: per-peer single-writer logs (`peer-log.ts`), the LWW read-merge
(`read-merge.ts`), the signed peer-announce (`announce.ts`), the read-admission
security gate (`read-admission.ts`), the advisory append-only feature claim
(`orchestrator/feature-claim.ts` + `projections/feature-claims.ts`), and the boot
wiring — all shipped with unit coverage in Stages 1-6.

Stage 7 adds a **deterministic, Docker-free two-peer-on-one-box integration test**
that composes the REAL modules across two Corestores + two own-logs and proves the
four load-bearing claims at the read-merge → apply boundary (asserted via
`mergeAdmittedLogs`'s injectable `applyImpl` spy, so NO Postgres/Docker is needed —
the projection→PG final hop is already unit-tested per-table):
- file: `apps/operator/lib/sync/hyperbee/__tests__/two-peer.test.ts` (4 tests, green).
  Named `*.test.ts` (NOT `*.integration.test.ts`) so it RUNS in the normal unit
  suite (`npx vitest run lib/sync/hyperbee/`) — the unit layer excludes the
  integration glob and the integration layer's globalSetup wants Docker, which this
  spy-asserted test does not.
- (1) replication — peer A's write crosses the wire to peer B's merge → apply;
  (2) admission refusal — a forged binding → `binding_invalid`, a tampered announce
  → `bad_sig`, and the refused peer's ops never enter the merged set;
  (3) revocation — a revoked peer → `revoked`, none of its ops apply;
  (4) claims are APPEND-ONLY audit history (corrected Stage-5 semantics) — two
  peers' claims for one feature land as SEPARATE `<feature_id>/<seq>` rows, NOT an
  LWW-clobber (distinct seqs achieved by A's log carrying a prior op → A claims at
  seq 1, B at seq 0; current-holder is a separate latest-`claimed_at` read).

**The real two-MACHINE smoke (P-079) remains the user's manual acceptance step** —
it still needs the Tauri desktop + two actual peers (see `/internal/docs/testing`);
this single-box test proves the module composition + replication + gate logic, not
the cross-machine Hyperswarm transport.

## Session 5 (2026-06-01) — live Tauri-shell verification + idle-state false-'booting' fix

Drove the running Tauri desktop (via the `tauri-agent-tools` bridge — no
focus-steal) to verify the Model B host. **Result: the operator boots cleanly on
Model B** (host restarted onto the new code, `enabled:true`, no crash) and the
Substrate admin page renders with the Stage-4 flag-copy fixes live
(`staleFlagCopy:false`, `fixedEmptyCopy:true` — "No shared harnesses booted yet").

The verification surfaced one real defect — the phantom health-endpoint entry the
Session-4 handoff couldn't yet explain — and it is now **root-caused + fixed**
(commit `b5c2df3a0`). Root cause: Stage 4d's flag removal left three
flag-conditional branches built on the old singleton-flag assumption ("flag on ⇒ a
substrate should be booted"), which is false under per-harness Model B:
- `dogfood-substrate-health` synthesised a phantom `{workspaceId:'',harnessSlug:'',
  verdict:'booting'}` row when nothing was booted (while the summary filtered it out
  → inconsistent payload, stuck orange "Booting" pill).
- `summariseWorkspaceSubstrate` mapped enabled+empty → `worstVerdict:'booting'`.
- `format-cli` mapped enabled+0-booted → exit 1 (a permanent false alarm for every
  env with no shared harness: fresh installs, this dev box, CI).

Fix: **zero booted harnesses is the idle ground state, not an alarm.** Endpoint →
`harnesses:[]` (UI empty state); summary → `worstVerdict:'healthy'`; CLI → exit 0 +
idle hint. A real boot failure still surfaces as a per-harness
`unhealthy`/`booting` row or a boot-history `boot_fail` event. Verified live
post-restart: `GET /api/admin/dogfood-substrate-health` → `{harnesses:[],
summary.worstVerdict:'healthy', totalHarnesses:0}`. 411 hyperbee+insights unit
tests green.

**P-079 same-box TRANSPORT surrogate is now BUILT + green** (commit `d75dcfaed`).
Earlier handoffs said the two-peer test "still needs Tauri + 2 peers" / was the
user's manual step — that was an over-claim for the *transport* layer.
`apps/operator/lib/sync/hyperbee/__tests__/two-peer-swarm.test.ts` boots two REAL
`bootHarnessSubstrate` peers over a **local testnet DHT** (`hyperdht/testnet.js`,
offline + deterministic), injected via the existing `swarmOverride` seam, and
proves a write on peer A reaches peer B's apply sink via the ACTUAL wire — DHT
discovery → `corestore.replicate(socket)` → signed-announce exchange on the
`papercusp/announce` channel → `onAnnounce` admit → remote-log replicate →
`mergeNow`. This fills the exact gap `two-peer.test.ts` stubbed (it hand-piped the
replication stream). Stable across repeated runs (~0.5s; loopback DHT, no
holepunch delay). One small production-no-op test seam was added to `boot.ts`
(`announceIdentityOverride` — injects a fake gh user + a self-generated Ed25519
keypair + a matching signer, so the announce SIGNATURE genuinely verifies over the
wire without touching `gh`/the OS keychain).

**Still genuinely gated (NOT solo-doable):** the channel-2 GitHub-binding
admission gate is BYPASSED in this test (`verifyBindingOverride:()=>true`) — the
real gate needs two GitHub-**published** two-channel bindings (contributor file +
OAuth `GET /user`), which need a 2nd GitHub identity + the binding-publish /
ShareWizard pipeline. So the **gate-active, two-real-identities** P-079 (and the
true cross-MACHINE P-080 soak) remain the user's acceptance steps. The gate LOGIC
itself is already unit-covered (`read-admission` tests + `two-peer.test.ts`
Cases 2-3: forged binding / tampered announce / revoke).

## Session 6 (2026-06-01) — Phase-1b bidirectional federation SHIPPED

Brainstormed → specced → planned → built (subagent-driven, 11 tasks, two-stage
review each + a final holistic review = **SHIP**). Spec
`papercusp-phase1b-bidirectional-federation-2026-06-01`; plan
`papercusp-phase1b-bidirectional-federation-impl-2026-06-01`. This wires the live
join/share identity pipeline onto Model B so two **different** GitHub engineers can
federate **bidirectionally** through the desktop UI.

The audit found three real defects (all fixed): (1) the join UI couldn't
authenticate (sent empty creds → 400) → **server-side gh-identity resolution**
(`resolveLocalGithubIdentity`); (2) **the keystone latent bug** — admission ran
channel-1 OAuth (`GET /user` with the LOCAL token vs the REMOTE id), which ALWAYS
failed for a *different* user → two different GitHub users could never admit each
other. Fixed by **admission = channel-2 ONLY** (the remote-verifiable, GitHub-
published, device-signed contributor file; channel-1 is a self-attestation a remote
peer can't run — it stays on the publish/self path). Validated against
Keybase/Sigstore/Radicle (the OLD code was the outlier). (3) only the joiner
published a binding → **symmetric `ensureMyBindingPublished`** now called by BOTH
join and share so each side is channel-2-verifiable by the other.

Also: join orchestrator collapsed 10 Autobase-era steps → **6 Model-B steps +
auto-boot**; a **pending-retry** self-heals the GitHub-propagation window
(channel-2 404 → retry within a 30-min grace, freshness anchored to arrival);
**announce freshness** (`ts`+window) replay hardening (D-007). Contributor files
are published via the **GitHub Contents API** so the commit is `verified` (R-1) —
NEVER local git push.

**Proof:** `two-peer-swarm-bidi.test.ts` — two distinct identities admit each
other over the real testnet-DHT swarm and each peer's PG converges with the
OTHER's op (deterministic, ~0.5s, no flake). Full suite 1896 tests green.

**STILL the user's acceptance step — R-1 LIVE confirmation:** the
`commit.verification.verified === true` guarantee from the Contents API is
by-design and CANNOT be asserted offline. The manual two-machine P-079 (now
genuinely runnable — two real GitHub accounts) must confirm Contents-API commits
are actually `verified` in the real gh-token context. **If they are NOT, channel-2
step (c) fails for everyone and escalation is needed** (register the device key as
an account SSH/GPG signing key, or a GitHub App with commit signing). Other
recorded-not-built limitations: one verifiable device per GitHub login
(multi-device collision, D-008); login-rename fragility; gist-proliferation minor
(share creates a fresh attestation gist each finalize). See
`agent-insights/phase1b-federation-limitations.mdx`.

## Session 7 (2026-06-01) — substrate revocation v1 SHIPPED

Spec/plan: `papercusp-substrate-revocation-v1-2026-06-01` (+ `-impl-`). Subagent-driven,
3 tasks, two-stage review each. Closes a **latent security gap** the Phase-1b work
exposed: the admission `revoked` Set was seeded EMPTY at boot and the published
`revoked_pubkeys` (a `TEXT[]` already on `harness_shared.contributors`) were NEVER
enforced — a contributor who revoked a lost/compromised device was ignored and the
device still admitted.

- **T1** `load-revoked-pubkeys.ts` — read the union of published `revoked_pubkeys`.
- **T2** boot now ENFORCES them: seeds the `revoked` Set at startup (unconditional,
  before swarm join, fail-open) AND refreshes inside every `mergeNow` (under the merge
  lock), dropping a newly-revoked admitted peer mid-session. An opus security review +
  the automated commit-review both caught an initial version that skipped the
  production startup seed (conditional on a test override) → fixed to unconditional
  (commit `1330db8e8`); fail-open-on-load-failure is documented as the intentional
  tradeoff (D-006: advisory substrate + GitHub-is-authority; visible via `merge_error`
  events; self-healing via the per-merge refresh).
- **T3** `revokeSelfDevice` core + `POST /api/admin/substrate/revoke-self-device`
  (auth `{trust:['verified','trusted']}`) + MCP tool `substrate:revoke_self_device` —
  **SELF-revocation only**: appends your updated contributor row (`revoked_pubkeys +=`
  the target) via `publishContributorRow` + calls the live `handle.revoke()`. A
  `not_your_key` guard refuses revoking any pubkey not among the local identity's own
  `device_attestations` (no side effects on refusal).

Trigger→enforcement loop verified closed (T3 writes `revoked_pubkeys` → contributors
projection → the column T1 reads → T2 enforces). Suites green.

**DEFERRED to v2 (needs the owner's trust-model decision):** owner-revokes-OTHERS
(kicking a bad actor — an authority-model question, same class as the no-collaborator-gate
decision); un-revoke; a revocation UI.

## Session 8 (2026-06-02) — P-070 contributor usage-events wired END-TO-END

The audit's "P-070 usage-events — still types-only (no emit/rollup impl)" is now
**stale**: the engine (`emitUsageEvent`/`rollupForContributor`) already existed +
was unit-tested but had ZERO callers and ZERO consumers — a fully-built, inert
ledger. This session made it live (5 commits; per-commit tsc + tests green):

- **Emit foundation** (`937899915`): `lib/harness/usage-actor.ts`
  (`resolveUsageActor` — cached `{githubUserId, devicePubkey}` from gh + device
  key, NO booted-log needed; null when gh-unauth → emit skipped) +
  `lib/harness/emit-usage.ts` (`emitUsageEventBestEffort` — the never-throws seam
  every call site uses).
- **8 emitters** (`00ecf2566`): `lib/harness/usage-emitters.ts` (8 unit-tested
  mapping helpers) wired at the canonical sites: feature_authored + feature_queued
  (`routes/harness/features.ts` create + reset→todo), decision_added
  (`plans/add-decision`), plan_authored (`plans/new`), pr_opened (`pr-host/
  poll-daemon.ts`, with a per-harness `seeded` flag so a daemon restart doesn't
  re-emit for already-open PRs), feature_worked_start/end + agent_run_completed
  (`dbos/orchestrator-runner.ts` `realRunner`, run_id = idempotency key).
- **Read route + Contributors per-kind breakdown** (`c86fd86ba`): `GET
  /api/harness/:slug/contributor-usage?github_user_id=` → `rollupForContributor`;
  `AdvContributorsPanel` activity badge expands a `?cusage=`-backed per-kind view.
  (The flat "N act" total was ALREADY wired — `/contributors` + user-profile COUNT
  the ledger inline — so the emitters light those up automatically.)
- **Federation send-side** (`4d35d4183`): the usage projection was already
  registered (tableTag `'usage'`, receive side) but nothing SENT. Added the
  `contributor_usage_events → 'usage'` map + `toUsageValue` (ISO-ts→epoch-ms) in
  `feature-issue-op-keys.ts`, the `origin` echo-guard column + the
  `OUTBOX_CAPTURE_TARGETS` entry (`event_id` key) in `ensure-schema-dogfood.ts`,
  and `origin`-from-provenance in `projections/usage.ts`. Capture + echo-guard
  verified live in a ROLLED-BACK tx (local emit captured; remote-origin skipped).
- **Cleanup** (`510e82ca5` + `2604a9f6b`): deleted the zero-importer stale
  duplicate `lib/sync/usage-events-types.ts` (the divergent 10-kind module); the
  live contract is `lib/harness/contributor-usage-event-types.ts` (8 kinds, ULID).

### ⚠️ Deploys on the NEXT host restart — not live on the running :3070 yet
The `:3070` host has no hot-reload, so the running operator still serves the OLD
code (no emitters, no usage capture trigger). On the next host restart the new
code + `ensureContributorUsageEventsTable` (adds the `origin` column) +
`wireDogfoodTriggers` (adds the capture trigger) all load **atomically** — which
matters: applying the capture trigger BEFORE the new drain code would make the old
`outboxRowToLocalWriteOp` throw on usage rows. So do NOT hand-apply the trigger to
the live DB ahead of a restart. Verification done at the code level (all unit
suites + 502 hyperbee tests green, tsc clean) + DB level (rolled-back capture/
rollup round-trips); the live emit-on-real-activity → panel path is confirmable
once the host restarts.

### Still genuinely remaining (P-070)
- The finalizer's curator/documenter runs (`realFinalizer`) emit no
  `agent_run_completed` (they have no per-run idempotency key) — a small tracked
  follow-up, NOT silently skipped. `realRunner` covers the main pipeline roles.
- Cross-MACHINE federation of usage events is exercised only at the unit/DB level;
  the real two-peer P-079 (user's manual acceptance step) would confirm it on the
  wire alongside feature/issue federation.

## What shipped session 1 (verified present on disk + wired)

1. **Hyperbee→PG read-loop** — commit `409681ff`
   (subject: "feat(dogfood/substrate): Hyperbee→PG read-loop — make the substrate round-trip (P-031 read side)").
   - `apps/operator/lib/sync/hyperbee/read-loop.ts` (+ `read-loop.test.ts`, 7 tests).
   - `startHyperbeeReadLoop({ workspaceId, harnessSlug, base })` replays the merged
     Autobase view op-log (`handle.base.base.view`, a Hypercore: `.length` + `await .get(i)`)
     into PG via `applyHyperbeeOpToPg(op)`. Driven by the Autobase `'update'` event +
     a 1s polled fallback. Idempotent op-replay over `[0, length)`; in-memory cursor,
     replay-from-0 on boot is a safe backfill.
   - Wired in `apps/operator/lib/sync/hyperbee/boot.ts`: import at line 40, start at
     line ~169 (after the bootstrap-progress poller), `readLoop.stop()` in `close()` at
     line ~222. (Verified these line refs on 2026-05-30; they drift.)

2. **ShareWizard finalize route** — commit `043617f7`
   (subject: "feat(dogfood/substrate): ShareWizard finalize route — write .harness/shared.json (P-077)").
   - `apps/operator/lib/endpoint-route/routes/harness/share-finalize.ts` (+ test, 8 tests).
   - `POST /api/harness/:slug/share/finalize`. Maps the ShareWizard `{ state }` body →
     `finalizeShare(input, deps)` → builds a validated `HarnessSharedConfig` via
     `buildFreshConfig(...)` and writes it to `<projectDir>/.harness/shared.json`
     (`resolveHarnessPaths(slug, activeWorkspaceId())`; 404s an unregistered slug whose
     path resolves under `/tmp/papercusp-unresolved/`).
   - Registered in `apps/operator/lib/endpoint-route/routes/index.ts`: import line 57,
     `...flatten(harnessShareFinalize as AnyRoute)` line ~469 (mirrors `harnessJoinLink`).

Both were verified clean before commit: their unit tests pass and `tsc --noEmit -p
apps/operator/tsconfig.json` reports **no errors in the files I added** (read-loop.ts,
share-finalize.ts + tests). Run those checks again yourself before building on them.

## The decisive architecture facts (verified — don't re-derive wrong)

- **The Autobase view is an append-only op LOG (a Hypercore), NOT a Hyperbee KV.**
  So the read side is op-*replay*, not row-reconciliation. `view.get(i)` returns the
  **bare `OpEnvelope`** (the apply fn appended `node.value`). `OpEnvelope` is exported
  from `apps/operator/lib/sync/hyperbee/autobase-setup.ts:25`.
- **`applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean>`** — single arg, no PG handle.
  In `apps/operator/lib/sync/hyperbee/projection.ts`. Each projection writer resolves
  PG itself via `getOrgPg()`; the read-loop needs no PG plumbing.
- **Writing `.harness/shared.json` IS the "go shared" action. There is NO registry
  `state` column.** `ProjectEntry` (`apps/operator/lib/harness-core.ts`) is `{ slug,
  path, ... }` only. Every consumer (boot, discord, projects `is_shared`) derives
  shared-ness from the file's presence. The reverted first attempt invented a
  `setHarnessState` helper — it does not exist; do not reintroduce it.
- **Boot derives its swarm topic from `github_repository_id`, ignoring the file's
  `topic` field.** `apps/operator/lib/sync/hyperbee/boot-all.ts:144` `defaultResolveSwarmBinding`
  reads shared.json and returns `{ kind: 'gh', github_repository_id }`;
  `deriveSwarmTopic` (`derive-swarm-topic.ts:46`) = `sha256("papercusp-substrate-v1:gh:<id>")`.
  The `topic` in shared.json is only for the human `papercusp://harness?...` link.
  Consequence: **a valid shared.json with the right `github_repository_id` is all boot
  needs to go online.**
- **Real shared-config API names** (in `apps/operator/lib/harness/harness-shared-config-types.ts`):
  `buildFreshConfig({topic, github_remote, github_repository_id, privacy, discord_channel?, now})`,
  `isHarnessSharedConfig(x)`, `HarnessSharedConfig`, `HarnessSharedPrivacy`,
  `HARNESS_SHARED_CONFIG_REL_PATH = '.harness/shared.json'`,
  `HARNESS_SHARED_PRIVACY_LEVELS`. `apps/operator/lib/harness/load-shared-config.ts` is
  **read-only** (`loadSharedConfigFromProjectDir`) — there is no write helper; the
  finalize route writes the file directly.
- **The whole substrate is gated `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`** (checked at
  `apps/operator/instrumentation-node.ts:341`; default OFF). Nothing boots/swarms in
  normal dev unless this env var is set.

## Remaining work (TODO — none of this is done)

### 1. ShareWizard frontend → real github_repository_id  [frontend]
`apps/operator/app/harness/ShareWizard.tsx` ALREADY POSTs `{ state }` to
`/api/harness/:slug/share/finalize` (line ~170, `defaultWriteSharedJson`), so the
route now receives real calls. BUT: `finalizeShare` rejects (400) unless the body
carries a **positive-integer `github_repository_id`** (boot keys the swarm on it).
The wizard's binding step (`state.github_repository_id`, set around ShareWizard.tsx:294
from a `/api/harness/binding/resolve` lookup) must supply a real id. VERIFY whether
`/api/harness/binding/resolve` exists and returns a real numeric repo id — the audit
flagged that route as possibly missing/stubbed; if it's a stub returning 0/undefined,
the finalize will 400 and sharing still won't work. Trace it end-to-end with a real
GitHub repo before claiming sharing works.

### 2. Re-boot after finalize so an already-booted harness joins the swarm  [backend, small]
`bootSingleHarness` (`boot-all.ts:161`) caches handles and returns `already-booted`
if one exists (`handles.has(k)`, line 171) — so writing shared.json does NOT
retroactively swarm-join a harness that booted earlier as `swarm: null`. There is
**no single `rebootHarness` helper** (an earlier draft of this brief claimed one at
`boot-all.ts:242` — that was wrong; do not look for it). The real exported helpers
(verified `grep -nE '^export (async )?function' boot-all.ts` on 2026-05-30) are:
`closeBootedHarness(workspaceId, harnessSlug)` at `boot-all.ts:265` (deletes the
handle from the map at line 272 then `await handle.close()` at 274) and
`bootSingleHarness(...)` at 161. So the reboot path is: `await closeBootedHarness(ws,
slug); await bootSingleHarness(ws, slug);` (the close removes the cache entry so the
re-boot actually re-resolves the swarm binding instead of returning `already-booted`).
Decide whether the finalize route triggers that sequence after writing the file (only
meaningful when `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`) or just documents "restart to
go online." Other boot-all exports for reference: `getBootedHarness` (130),
`defaultResolveSwarmBinding` (144), `bootAllHarnessesForActiveWorkspace` (238),
`closeAllBootedHarnesses` (282), `listBootedHandles` (308).

### 3. BootHistoryKind type drift  [backend, small — was attempted + reverted]
`boot.ts` emits two event kinds NOT in the union:
`recordBootEvent(..., 'peer_connected')` (boot.ts:181 and :192) and
`recordBootEvent(..., 'swarm_join_failed')` (boot.ts:201). But
`apps/operator/lib/sync/hyperbee/boot-history.ts:22` declares
`BootHistoryKind = 'boot_start' | 'boot_ok' | 'boot_fail' | 'close'` — a real tsc
error (the param currently widens so it compiles in practice).
**Why my fix (`50db259d`) was reverted (`d422af94`):** there is a SECOND,
independent `BootHistoryKind` declaration at
`apps/operator/app/harness/insights/BootHistoryTable.tsx:18` (plus `KIND_COLOR`/
`KIND_MARK` `Record<BootHistoryKind, string>` maps at lines 38/45 that must stay
exhaustive). Widening only the boot-history.ts union made the two types mismatch and
introduced a new tsc error. A correct fix updates BOTH declarations together (add
`peer_connected` + `swarm_join_failed` to both, and add entries to the two `Record`
maps in BootHistoryTable.tsx), then `tsc --noEmit -p apps/operator/tsconfig.json` and
confirm no NEW errors. (There are pre-existing unrelated errors in the tree; diff the
error set, don't just check exit code.)

### 4. Other substrate gaps from the audit (not started, larger)
- **P-070 usage-events runtime** — `apps/operator/lib/.../usage-events*` is types-only;
  `emitUsageEvent`/`rollupForContributor` have no implementation/callers. (Verify the
  exact path; I did not re-confirm it this session.)
- **PG→Hyperbee backfill seeder** — ShareWizard's `defaultRunBackfill`
  (ShareWizard.tsx, a `setTimeout(200)` stub) is meant to seed existing PG rows into
  Hyperbee on first share. Not built. Not required for the swarm to come online (boot
  joins from shared.json regardless), only for historical rows to propagate.
- **Live two-peer verification (P-079)** — none of this has been exercised against two
  real machines. Needs the Tauri desktop (`cd ../papercusp-desktop && npm run dev`),
  `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`, and two peers. See `/internal/docs/testing`.

## Hard-won process lessons (heed these — I violated them and paid for it)

- **This session repeatedly hallucinated file contents and API names.** Three commits
  were reverted because they were written against imagined code (a non-existent
  `read-model.ts`/`readAllRows`; a non-existent `poll-daemon` merge path; invented
  `writeSharedConfig`/`setHarnessState`/`generateSwarmTopicHex`). The fix that worked:
  **read the actual source file before writing any code that imports from it, and
  grep that each imported symbol truly exists.**
- **Run `tsc --noEmit -p apps/operator/tsconfig.json` and the unit test, and READ THE
  RESULT, BEFORE `git commit`.** Multiple bad commits happened because I committed in
  the same batch as the verification and didn't wait for it. For server-side files tsc
  is the real gate (vitest + vite build both gave false-greens on missing imports this
  session — esbuild is lenient on missing named imports; the SPA build excludes
  server files).
- **`git add <path>` in this shared checkout silently stages other agents' modified
  files too.** Always `git diff --cached --name-only` before committing and confirm it
  is EXACTLY your files; `git reset -q HEAD .` then add only yours if it swept extras.
- **Do not trust commit hashes from memory** — re-read them with `git log` (I cited
  wrong/fabricated hashes in commit bodies and plan notes this session).
- Server-side code at `:3070` has **no hot-reload** (see CLAUDE.md): edits need a host
  restart to take effect; a too-fast/stale probe means you're testing old code.

## Plan references
- Master audit: `apps/operator/docs/dogfood-audit-2026-05-30.md`
- Phase 11 plan (substrate wiring items, incl. the P-002/P-004 correction):
  `apps/operator/docs/plans/papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26.md`
- Phase 5a (substrate plumbing): `apps/operator/docs/plans/papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.md`
- Phase 2 (completion_ref writer — separate unstarted thread, design recorded as D-001):
  `apps/operator/docs/plans/papercusp-dogfood-phase2-completion-ref-2026-05-24.md`
