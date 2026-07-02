# Fleet briefs — git plan (Phase 7/8) sonnet5 desktop members

**Leader:** su-3700b (the git-plan owner). **Members:** 4 × `sonnet5` @ high effort,
desktop terminals via `fleet:launch-on-plan`, worktree-isolated. **Plan:**
`cross-machine-coord-parity-and-trust-2026-07-01`. **DO NOT LAUNCH until su-cfd1b's
token-savings work ships** (else members hit the cap on turn one).

Each member gets: the **shared preamble** (§0) + their **lane section**. Members are
capable but need tight scope, explicit acceptance, and the exact verify command — write
the kickoff prompt as "read docs/plans/FLEET-git-briefs-2026-07-01.md §0 and your lane §N,
then execute; coord:send the leader when your lane is green or you're blocked."

---

## §0 Shared preamble (every member reads this)

**Mission of the plan (context, D-010/D-011, research in `p2p-git-research-2026-07-01.md`):**
replace GitHub-as-sync-transport with a p2p git layer over the existing Hyperswarm mesh.
Radicle-Heartwood model: one bare repo per (hive, repo); each device writes ONLY its own
`refs/namespaces/<devHex>/refs/…`; shared ODB; the "real" refs (staging, release tags) are
COMPUTED by the integrator, never pushed. Native git protocol-v2 fetch over a Protomux
channel — NOT bundles, NEVER loose objects.

**The foundation is built (G-1, landed by the leader) — build ON it, don't reinvent:**
`packages/operator-core/lib/sync/hive-git/storage.ts` gives you `hiveGitRepoPath`,
`ensureHiveGitRepo`, `deviceNamespaceKey(base64→hex)` (THE device→namespace mapping — use
it, never re-encode), `namespaceRefPath`, `writeNamespaceRef`/`readNamespaceRef`/
`deleteNamespaceRef`/`listNamespaces`/`listNamespaceRefs`, and the `RunGit` seam +
`defaultRunGit`. Read that file first; its test shows the usage.

**Ground rules (identical to the coordination handoff):**
- Edit ONLY the canonical tree `/home/marsh-office/papercupai-workspace/papercusp` (a
  worktree guard blocks the `-staging` sibling). You each get your own worktree checkout.
- MCP may be dropped → fallback: `node scripts/mcp-call.mjs <tool> '<json>' --client <your-su-id>`
  (colon tool names; `plans:set-status {slug,itemId,status}`).
- Tests: `cd packages/operator-core`. Unit `npx vitest run <path>`; integration (real PG /
  real git) `npx vitest run --config vitest.integration.config.ts <path>`.
- Fail-soft on every network/merge path (try/catch, never throw on the hot path). Reuse
  existing seams: the presence-gossip **device-signing idiom** (`presence-gossip.ts`
  verify: raw-32 b64 pubkey → SPKI rebuild → verify, fixed-field-order signing bytes,
  freshness window), the **P-009 federated-event rail** (`events:emit {scope:'hive'}` +
  the coord-message projection re-fire) for announcements, and `federated-wake-rate.ts` for
  any per-author budget.
- New federated table = the 6-surface recipe (`agent-insights/retire-or-add-a-federated-table`)
  PLUS the `stamp_local_federated_write` BEFORE trigger in the migration (the guard
  `stamp-trigger-coverage.integration.test.ts` fails if you forget it — run it).
- Reserve migrations with `db:next-migration`. Strip `BEGIN;/COMMIT;` when `sql.unsafe()`-
  applying a migration in a test. If `Edit` won't match a line with `—`/`…`, use a python heredoc.
- **Report cadence:** `coord:send { to:['@fleet-leader:<slug>'], plan_slug }` on lane-green,
  on a blocker, or before editing a SHARED file (below). Flip your item to `wip`/`done` via
  `plans:set-status`.

**SHARED files — coord:send the leader BEFORE editing:** `projections/coord-message.ts`
(coordination agent + leader both touch it), `authority/lock-authority.ts` (leader owns
G-0; also the coordination agent's P-021), `hive-policy-schema.ts` (Lane 2 + coordination).
Everything under `sync/hive-git/` is fair game per your lane.

**Definition of done per lane:** code + tests green (unit + integration + any federation
guard your change touches) + tsc clean on the package + item flipped `done` with the file
evidence in its text + a lane-green `coord:send` to the leader. The leader reviews every
merged diff — expect review comments.

---

## §1 Lane A — Sigrefs (crypto/signing)  [items G-4 (P-028), G-4b (P-039)]

Build `sync/hive-git/sigrefs.ts`: a device-signed snapshot of that device's namespaced
ref-set (name→sha listing), written as a git blob referenced at `refs/rad/sigrefs` in the
device's namespace (use `writeNamespaceRef`/`readNamespaceRef` from storage.ts).
- **G-4:** `buildSigrefs(repoPath, devicePubkey, sign)` → serialize the device's
  `listNamespaceRefs` output in a canonical fixed order, sign it (device-signing idiom),
  store `{ version, refs:[{ref,sha}], sig, ts }` as a blob; `verifySigrefs(blob, devicePubkey)`
  → validate the signature over the canonical bytes. A receiver (G-2 fetch) calls verify
  before trusting a fetched namespace's heads — closes the transitive-fetch relay-tamper hole.
- **G-4b (rollback protection):** a monotonic `version` counter INSIDE the signed blob +
  a per-device receiver high-watermark (`sigrefsWatermark`) — reject a sigrefs whose version
  ≤ the highest already seen for that device (TUF rollback class). Persist the watermark
  (a small table or an operator_state row).
- **Verify:** unit tests (sign/verify round-trip, tamper→reject, rollback→reject, canonical
  order stable) + one integration test writing/reading the sigrefs blob in a real bare repo.
- **Acceptance:** a tampered or rolled-back sigrefs never verifies; a fresh one always does;
  the blob round-trips through git storage.

## §2 Lane B — Policy & rules  [items G-6 (P-030), G-5c (P-035)]

- **G-6 canonical-ref rules:** extend `hive-policy-schema.ts` (mirror how `comms` was added
  in P-012) with `crefs: { rules: { "<ref-pattern>": { allow: [pubkey…], threshold } } }`
  — the crefs-style rules from the Radicle Aug-2025 model, used later by the integrator to
  decide when a release-class ref (`refs/tags/releases/*`) becomes canonical (allow =
  green-bot key + owner key, threshold 2). Validate + sign like the rest of the policy
  (`coerceHivePolicyInput`). Add a pure `resolveCanonicalRule(policy, refName)` →
  `{allow, threshold} | null`. **Coordinate on hive-policy-schema.ts** (SHARED).
- **G-5c multi-owner integration-requests queue:** a bounded local table (mirror
  `coord_quarantine`, mig pattern) where a non-`steer`-tier member's namespace head lands
  for owner ratification instead of auto-integrating; a `list` reader + a one-call
  `ratify(device, sha)`. This is the code twin of P-013 quarantine-don't-drop.
- **Verify:** schema unit tests (valid/invalid crefs rules, round-trip signed); integration
  test for the requests queue (insert→list→ratify, per-author bound).
- **Acceptance:** a garbage crefs rule is rejected; `resolveCanonicalRule` returns the right
  rule for a pattern; a below-tier head is queued not applied, and ratify promotes it.

## §3 Lane C — Guards & GC  [items G-10 (P-043), G-9 (P-042), G-1b (P-041)]

- **G-10 secrets-pattern guard:** a scanner (sibling of the oversized-blob guard in
  `run-git-sync.ts` `findOversizedDirtyFiles`) that refuses to publish a commit whose diff
  matches secret patterns (AWS keys, PEM blocks, `.env` with values, high-entropy tokens).
  Pure `scanForSecrets(paths|diff)` → findings; wire a hook the publish path can call.
  REQUIRED before any multi-owner autocommit replication.
- **G-9 namespace/ODB GC:** `gcHiveGitRepo(repoPath)` — keep each device's `work` + last-N
  published refs + sigrefs, drop older; archive a departed member's namespace on membership
  removal; run `git gc` on a cadence. Use `listNamespaces`/`listNamespaceRefs`.
- **G-1b:** already reflected in storage.ts (repo path is per (hive, repo)) — verify + add a
  test if any caller still assumes per-hive-only; otherwise close as covered.
- **Verify:** unit tests (secret patterns caught + clean diffs pass; GC keeps/ drops the
  right refs) + an integration test over a real bare repo for GC.
- **Acceptance:** a planted secret is refused; GC bounds the ref/object set without losing
  reachable-from-staging history.

## §4 Lane D — Distributed-gate seed  [items DG-1 (P-044), DG-2 (P-045)]

- **DG-1 verdict facts:** schema + store for a content-addressed, device-SIGNED verdict
  `{ stagingSha, shardId, inputsHash, verdict:'pass'|'fail', durationMs, deviceSig }` — a
  new federated table (6-surface recipe + stamp trigger) so verdicts federate as data.
  Verify sig + membership on receive.
- **DG-2 shard manifest + inputsHash:** derive the shard list from the test-config
  unit/integration split; per-shard `inputsHash` = a tree-hash of the files the shard
  depends on (so an unchanged shard's prior green verdict is reusable → the gate is
  INCREMENTAL). Pure `buildShardManifest()` + `shardInputsHash(shard)`.
- **Verify:** unit tests (verdict sign/verify, manifest determinism, inputsHash changes iff
  inputs change) + one integration test for the federated verdict table (capture→apply,
  stamp-trigger-coverage guard green).
- **Acceptance:** a verdict federates + verifies; an unchanged shard yields a stable
  inputsHash (cache hit); a changed input flips it.

---

## Leader-held (NOT for members): the serial spine + collisions
G-2 fetch transport, G-3 announcements, G-5 integrator (+G-5b/G-5d), G-7 worktree bridge
(+G-7b/G-7c), G-8 bootstrap, G-0 sha-token lock handoff (collides with lock-authority.ts).
Members roll onto a leader-assigned spine sub-task only when their lane is done AND the
leader hands it off explicitly.
