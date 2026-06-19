# Shared-Hive Public-Release Test Program

**Goal:** reach the point where we can *confidently* say the shared-hive (P2P
federated) feature set is ready for a **public release** — not "the existing
suites are green" (they are), but "we have actively tried to break it across
correctness, data-completeness, security, concurrency, resilience, and UX, and
it held."

These briefs are **parallel lanes**. Each is a self-contained assignment for one
agent. Read this README first (shared context + rules), then your brief.

---

## Why a new pass (what was already done)

A prior pass confirmed the **entire automated surface is green** (~28,600 tests:
all 11 packages, all libs, all apps, operator-core integration) and fixed 5 real
bugs this session:

1. **Topic-split** (the major federation bug) — owner federated on
   `hive:<pubkey>`, a joiner re-derived `gh:<repo_id>` → different swarm topic →
   incremental writes never crossed. Fixed in `boot-all.ts` (`defaultResolveSwarmBinding`
   now honors the link topic), `derive-swarm-topic.ts` (explicit `topic` carrier),
   verified across `derive-swarm-topic.test.ts` + `default-swarm-binding-p007.test.ts`.
2. **Deceptive-publish** — `reachablePeers` now an honest signal end-to-end.
3. **EI-1534** — conversations workspace isolation (dynamic `getWorkspaceId` thunk).
4. **requeue_count schema drift** — `composition-rig.ts` test schema was missing
   migration 307's column → real `setWorkItemState` UPDATE errored.
5. **pending-wakes-sweep contamination** — cross-file `reg.current` drift; pinned
   via `runWithWorkspace` (ALS).

**The gap this program closes:** that pass largely *ran existing tests*. It did
NOT systematically (a) prove every federated table's full path, (b) threat-model
the P2P attack surface, (c) verify the real multi-peer end-to-end, or (d) inject
failures. That's what these briefs do.

**Known blind spot to exploit:** the 2-peer integration rigs (`makeSwarm`,
`composition-rig`, `_cross-peer-rig`, `_hive-substrate-rig`) wire **both peers
onto matching topics directly** — they bypass `defaultResolveSwarmBinding`. So no
integration test exercises the real **joiner-resolves-its-own-topic** path. Any
brief touching federation MUST cover the joiner path explicitly, not assume the
rigs cover it.

---

## Architecture map (pointers — read before testing)

- **Federation substrate:** `packages/operator-core/lib/sync/hyperbee/` —
  `boot.ts` (`bootHarnessSubstrate`), `boot-all.ts` (`defaultResolveSwarmBinding`),
  `derive-swarm-topic.ts` (topic derivation: `gh:` / `local:` / `hive:<pubkey>` /
  explicit `topic:`), `swarm.ts`, `corestore.ts`, `wire-presence.ts`, `wire-outbox`.
- **Hive lifecycle:** `lib/hive-*.ts` — `hive-create*`, `hive-publish*`,
  `hive-set-listing.ts`, `hive-directory*.ts`, `hive-federation.ts`
  (`resolveHiveSwarmBinding`), `identity/hive-keypair.ts` (`hiveKeychainId`).
- **Join:** `lib/harness/join-shared-harness.ts` (synthesizes `shared.json` with
  the link topic at line ~582).
- **Authority/locks:** `lib/authority/`.
- **Federated tables (capture side):** `libs/papercusp/libs/db/sql/*.sql` capture
  triggers (migration 102 family). **Projections (apply side):**
  `lib/sync/.../projections` (`build*Projection`, `tableTag`).
- **Coordination stores:** `lib/agent-tools/coordination/`, `packages/coordination`.
- **Desktop app:** `papercusp-desktop/` (Tauri). Shared-hive UI:
  `apps/operator/app/harness/ShareHiveDialog.tsx`, `apps/operator-vite`.

---

## Test infrastructure & rules (ALL agents)

**Frameworks — every new test goes in exactly ONE:** Vitest
(`<pkg>/lib/**/<name>.test.ts` unit, `*.integration.test.ts` integration),
Playwright (`apps/operator/e2e/<name>.spec.ts`), Cargo (`#[cfg(test)]`), or LLM
scenarios (`apps/operator/lib/llm-testing/scenarios/`). **No new `.mjs`/tsx smoke
scripts** (CI lint P-038 fails the build).

**Run commands:**
- Unit: `cd packages/operator-core && npx vitest run <path>`
- Integration (testcontainer PG, Docker required):
  `npx vitest run --config vitest.integration.config.ts <path>`
- A sub-lib with its OWN `vitest.config.ts` (e.g. `libs/generic/sync` is jsdom)
  MUST be run from its own dir — running from the parent applies the wrong env.

**2-peer / N-peer test rigs (reuse these):**
`lib/sync/hyperbee/__tests__/_cross-peer-rig.ts` (`pollUntil`, `buildPeerApply`),
`_hive-substrate-rig.ts`, `lib/shared-hive-loop/composition-rig.ts`
(`bootCompositionRig`). Real local DHT via `createTestnet` from
`hyperdht/testnet.js`, or `PAPERCUSP_DHT_BOOTSTRAP=127.0.0.1:<port>`.

**Live packaged instances:** `papercusp-desktop/bin/two-instance-interactive.sh
<deb>` (+ `federation-asserts.sh`). The fixed `.deb` (all 5 fixes) is at
`/home/marsh-office/.cargo-target/release/bundle/deb/Papercusp_0.0.2_amd64.deb`.
⚠ **The script's "share" step uses a RETIRED non-rekeying endpoint** — drive the
CURRENT share/join flow (the live UI or the current API), not that endpoint, or
you won't exercise the topic-split fix.

**Teeth-verify discipline (required for every new test):** write it green →
back up the source → neuter the specific invariant (perl) → run → confirm RED →
restore → confirm GREEN. A test that can't go red proves nothing.

**Project rules:** Work on `staging` directly — NO branches/worktrees/stashes.
**git-sync owns commit+push — you do neither.** Coordinate via `locks:*` +
`coord:*` (declare-intent with your brief's items). **NEVER open `:3055`/`:3070`
in a browser** (PreToolUse hook blocks it; `curl` for API health is fine).
Server-side operator-core edits have no hot-reload — restart
`papercup-staging-api.service` to test `:3170`. New flags default ENABLED.
Desktop UI verification: follow `/internal/docs/testing` + `testing/agent-e2e`
(drive the Tauri shell, not a browser at the ports).

---

## Deliverables (every brief)

1. **New tests** (in the right framework, teeth-verified) closing the gaps in scope.
2. **A findings report** `shared-hive-release-testing/findings-<brief>.md`: every
   bug (with repro + severity), every gap closed, every gap left open (with why).
3. **A release-readiness verdict for your dimension**: GREEN (ready) / YELLOW
   (ready with caveats — list them) / RED (blockers — list them).
4. Fix bugs you find when the fix is clearly in scope + low-risk; for anything
   cross-cutting or another lane's, file it in your report and `coord:*` the owner.

## Severity rubric

- **S0 release-blocker:** data loss/corruption, privacy leak (non-member reads
  private data), unauthorized write accepted, non-convergence, crash/hang.
- **S1 major:** a feature silently doesn't federate, revocation not enforced,
  recovery fails, deadlock under churn.
- **S2 minor:** UX/honesty, slow path, recoverable-but-noisy.

## Coordination

Lanes overlap at the edges. Before deep work, `coord:declare-intent` with your
brief letter + the files/areas you'll touch. The **live-instance lanes (A, E, G)**
share the 2-instance harness — coordinate launches (one fixed-`.deb` pair at a
time) via a `locks:*` lock named `shared-hive-live-instances`.
