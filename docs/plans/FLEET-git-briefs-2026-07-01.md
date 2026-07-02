# Fleet briefs — git plan (Phase 7/8) — fable5 desktop members

**Leader:** su-3700b (git-plan owner). **Members:** 4 × `claude-fable-5` @ **xhigh**
effort, pinned to the **aviynw4** gateway account, desktop terminals via
`fleet:launch-on-plan`. **Plan:** `cross-machine-coord-parity-and-trust-2026-07-01`
(harness `papercusp`). Each member is launched with its lane's launch-context file
(`docs/plans/FLEET-lane-<X>-2026-07-01.md`) and auto-starts on the plan.

---

## LEADER-LANDED FOUNDATION — build ON these, do NOT reimplement (all green)

Everything below is committed under `packages/operator-core/lib/sync/hive-git/` with
passing tests. Read the file + its test before touching adjacent work; reuse the seams.

- **G-1 `storage.ts`** — per-hive bare repo, per-device ref namespaces. Seams:
  `hiveGitRepoPath`, `ensureHiveGitRepo`, `deviceNamespaceKey(base64→hex)` (THE
  device→namespace map — never re-encode), `namespaceRefPath`,
  `writeNamespaceRef`/`readNamespaceRef`/`deleteNamespaceRef` (CAS), `listNamespaces`,
  `listNamespaceRefs`, `RunGit` seam + `defaultRunGit`.
- **G-2 `fetch-transport.ts` + `git-ext-bridge.mjs`** — native git protocol-v2 fetch
  over an injected `Duplex`. `serveUploadPack(repo, duplex)`, `fetchOverDuplex(repo,
  duplex, refspecs)`, `fetchPeerNamespace`, `peerNamespaceRefspec`. NOTE: sockets
  bridging git streams MUST be `allowHalfOpen:true` (in-band pack delimiter).
- **G-4/G-4b `sigrefs.ts`** — device-signed ref snapshots + monotonic rollback guard.
  `buildSigrefs`, `readSigrefs`, `verifySigrefs`, `acceptFetchedSigrefs`,
  `reconcileFetchedHeads` (closes the transitive-relay tamper hole).
- **G-5 core `integrator.ts`** — merge-queue staging: `integrateMemberHeads(repo,
  integratorDev, memberHeads)` (ff / 3-way `merge-tree` / conflict-skip),
  `collectMemberHeads`, `readStaging`. Consts `WORK_REF`, `STAGING_REF`.
- **G-10 `secrets-guard.ts`** — publish-time secret scan: `scanForSecrets`, `hasSecrets`,
  `describeSecretFindings`.

Also DONE by the leader: the whole coordination audit (Phases 0-9 hardening verified),
and the release green-gate is being greened separately. Do NOT touch coordination files.

---

## §0 Shared ground rules (EVERY member) — identical to the coordination handoff

- **Edit ONLY** the canonical tree `/home/marsh-office/papercupai-workspace/papercusp`
  (a worktree guard blocks the `-staging` sibling).
- **MCP is dropped** → drive it via `node scripts/mcp-call.mjs <tool> '<json>' --client <your-own-su-id>`
  (colon tool names; `plans:set-status {harness:'papercusp',slug,itemId,status}`).
- **Tests:** `cd packages/operator-core`. Unit `npx vitest run <path>`; integration
  (real PG / real git) `npx vitest run --config vitest.integration.config.ts <path>`.
  Pure modules (no git/PG) can be plain unit tests.
- **Fail-soft** on every network/merge/apply path (try/catch, never throw on the hot path).
- Reuse the device-signing idiom (`ed25519.ts`: `verifyEd25519`, `signWithPrivateKeyDer`
  for tests, `signWithDeviceKey` in prod) and the leader-landed hive-git seams above.
- New federated table = the 6-surface recipe (`agent-insights/retire-or-add-a-federated-table`)
  **+ the `stamp_local_federated_write` BEFORE trigger** in the migration (the M7 trap —
  `stamp-trigger-coverage.integration.test.ts` catches an omission; run it). Reserve migs
  with `db:next-migration`; strip `BEGIN;/COMMIT;` when `sql.unsafe()`-applying a mig in a test.
- **DEFINITION OF DONE per item:** code + tests green (unit + integration + any federation
  guard your change touches) + tsc clean for the package + `plans:set-status … done` with
  file evidence + a `coord:send { to:['@fleet-leader:git-plan'] }` (or to `su-3700b`) when
  your lane is green OR you're blocked OR before editing a SHARED file. **The leader reviews
  every merged diff — expect review comments.**
- **SHARED files — coord:send the leader BEFORE editing:** `authority/lock-authority.ts`
  (Lane B G-0), `hive-policy-schema.ts` (Lane A G-6), `projections/coord-message.ts`.

---

## §1 Lane A — Policy, canonical-ref rules, GC & scope  [G-6 P-030, G-5c P-035, G-9 P-042, G-1b P-041]
See `docs/plans/FLEET-lane-A-2026-07-01.md`.

## §2 Lane B — Integrator completion & lock handoff  [G-5b P-034, G-5d P-038, G-0 P-033, G-0b P-037]
See `docs/plans/FLEET-lane-B-2026-07-01.md`.

## §3 Lane C — Worktree bridge & cold-clone bootstrap  [G-7 P-031, G-7b P-036, G-7c P-040, G-8 P-032]
See `docs/plans/FLEET-lane-C-2026-07-01.md`.

## §4 Lane D — Distributed test gate  [DG-1 P-044 … DG-6 P-049]
See `docs/plans/FLEET-lane-D-2026-07-01.md`.

---

## LEADER-HELD (su-3700b, not for members)
G-3 ref announcements (P-027, the P-009 federated-event rail → fetch trigger) + the G-2
LIVE channel adapter (open a `papercusp/hive-git` Protomux sub-stream per fetch on the real
hive-swarm connections, bridged to `fetchOverDuplex`/`serveUploadPack`) + final end-to-end
integration + reviewing every member diff. A member rolls onto a leader-assigned spine
sub-task only when its lane is done AND the leader hands it off explicitly.
