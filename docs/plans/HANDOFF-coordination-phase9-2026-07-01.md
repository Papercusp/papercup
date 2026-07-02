# Handoff brief — finish shared-hive coordination (Phase 9 + open items)

**For:** an Opus 4.8 / xhigh agent taking over the coordination work on plan
`cross-machine-coord-parity-and-trust-2026-07-01` (papercusp harness).
**Why the split:** the originating agent is now focused on the git plan (Phases 7–8,
`G-*`/`DG-*`); you own the coordination remainder (Phase 9 + `P-021`). Minimal file
overlap — see **Scope boundary** at the end.

---

## 0. Orient first (one read, in this order)

1. `plans:get { harness:'papercusp', slug:'cross-machine-coord-parity-and-trust-2026-07-01' }`.
2. **Read decision `D-014`** — the honest completion matrix (DONE-in-process /
   FLAG-DARK / UNPROVEN-LIVE / MULTI-OWNER-BLOCKED). It is the single source of truth
   for what's real; do not overstate readiness past it.
3. **Read `D-013`** — the adversarial audit (every finding, file:line, severity) that
   generated your backlog. **Also `D-010`/`D-011`** for how the git phase interacts.
4. Skim `docs/plans/p2p-git-research-2026-07-01.md` only if you touch git-adjacent code
   (you shouldn't).

**Refuted — do NOT re-investigate** (D-013 checked these): trust enforcement is live
(`ownHiveHomeSlug`, `boot.ts:796`); tier resolution fails-open to `message` not `steer`;
fed-event re-fire is exactly-once + budget-capped (no loop); HLC is now populated for
`bee_claim_specs` (mig 439).

## 1. Ground rules (environment)

- **Canonical tree:** edit ONLY `/home/marsh-office/papercupai-workspace/papercusp`.
  A worktree guard blocks edits to the `…-staging` sibling; if you get "not the
  canonical staging tree", you're in the wrong path.
- **MCP is dropped this session** — the `papercusp-su` server is disconnected. Drive it
  via the HTTP fallback: `node scripts/mcp-call.mjs <tool> '<jsonArgs>' --client <your-own-su-id>`
  (tool names use COLONS, e.g. `plans:set-status`, `coord:send`, `db:next-migration`).
  Quirks learned: `plans:add-item` wants `{ slug, phase, items:[{text,importance}] }`;
  `plans:set-status` wants `{ slug, itemId, status }` (or `items:[{slug,itemId,status}]`);
  `plans:edit` is a CAS string-replace on the plan markdown (`{slug, old_string, new_string, rationale}`).
- **AUTO mode is ON** for this plan (owner-directed, `D-007`) — act and disclose, don't
  ask-then-wait. Broadcast material progress via `coord:send { to:['*'], plan_slug }`.
- **Tests:** `cd packages/operator-core`. Unit: `npx vitest run <path>`. Integration
  (real PG): `npx vitest run --config vitest.integration.config.ts <path>` (running an
  integration test under the unit config errors with a "layered test path" message —
  that's the harness telling you to use the integration config).
- **Fail-soft is mandatory** on the merge/apply/coord hot paths — every federation leg is
  best-effort `try/catch`; never throw inside a projection `writeToPg` or the wake fan.

## 2. The work — prioritized, with anchors + acceptance + verification

### Tier A — cheap, same-owner-relevant (do first; unblocks nothing but real correctness)

- **M5b** (`P-054`, currently `wip` — M5a already landed). Budget-bound the quarantine
  receipt. In `packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts:191`
  the `below-message`/`rate-exceeded` quarantine still emits a receipt with no per-author
  cap → an untrusted admitted member floods receipt-requesting directed wakes and makes
  us emit one federated receipt row each. Fix: wrap that emit in
  `tryConsumeFederatedWake(authorPubkey, 1)` (from `federated-wake-rate.ts`); skip if over
  budget. Keep receipts directed-only (they already require the sender's `receipt:true`).
  **Verify:** extend `coord-message-federation.integration.test.ts` — a flood of below-tier
  receipt-requesting rows emits ≤ budget receipts. Flip `P-054` done.

- **M8** (`P-057`). No TTL reaper for `shared_presence` / `shared_session_presence` — a
  crashed device's rows are immortal, and `machine_label` is sender-controlled so a member
  can rotate it to bypass the full-set-replace prune (128 rows/rotation, forever). Add a
  scheduled reaper (mirror `presence-reaper.ts`, which today only reaps `coord_presence`):
  `DELETE … WHERE last_seen_at < now() - TTL`, plus a per-`device_pubkey` row cap. Wire it
  into `dbos/in-process-periodic.ts` beside the existing sweeps. **Verify:** integration
  test — stale rows deleted, live rows kept, per-device cap enforced.

- **L9** (`P-058`). Two small pinning fixes: (a) the `put` presence path trusts the
  sender's `hive_slug`/`harness_slug` — pin them to the receiver's binding exactly as the
  *sessions* path already does (`presence-gossip-wiring.ts` `applySessions` vs `applyPut`);
  (b) `bee_claim_specs` PK is `(workspace_id, bee_id)` with no hive component — add
  `harness_slug` to the uniqueness/conflict key (partial unique index) and federate a
  tombstone on scope-downgrade so a stale spec can't strand. **Verify:** projection +
  store integration tests.

### Tier B — MULTI-OWNER SECURITY BLOCKERS (careful design; these gate multi-owner enablement)

**One root cause fixes most of it:** `admittedDeviceSet` (`presence-gossip-wiring.ts:108`)
flattens attestations into a bare `Set<pubkey>`, **discarding the
`device_pubkey → github_user_id` binding** the membership store holds
(`hive-membership-store.ts` — `listHiveMembers().deviceAttestations[].device_pubkey`
+ `.githubUserId`; `loadRevokedHivePubkeys` for the revoked union). Thread that map into
the gate and validate every sender-declared identity field against it. Then:

- **H1** (`P-050`) — sessions `owner_id` spoofing. `verifyPresenceFrame`
  (`presence-gossip.ts:252`) type-checks `owner_id` but binds it to nothing (contrast the
  `put` self-announce pin at `:271`). A member can claim `owner_id:'queen'` or a victim's
  id → feeds `remoteSessionOwnerIds` (`recipient-resolve.ts:93,117`) → impersonation +
  prefix-ambiguity coordination-DoS + (with a local `events:await`) partial wake-eavesdrop.
  Fix: reject a frame whose `github_user_id` ≠ the signer's attestation; key session rows
  by `(owner_id, device_pubkey)`; never let a remote session shadow a local/other-member id.
- **H2** (`P-051`) — presence `del` has no self-announce pin (`presence-gossip.ts:274`);
  `deleteFromPg` (`projections/presence.ts:129`) keys on fields none tied to the signer →
  any member evicts any member's presence row (de-presence DoS → breaks lock-authority
  election). Fix: carry `device_pubkey` in `PresenceDelKey` and require the target row's
  `device_pubkey === frame.device_pubkey` in the delete WHERE.
- **H3** (`P-052`) — presence `put` PK is `(ws,harness,gh_user,machine)`, not device
  (`projections/presence.ts:95`); the pin covers only `device_pubkey`, so `github_user_id`/
  `machine_label` are forgeable → (user,machine) impersonation. Fix: validate
  `github_user_id` vs attestation + include `device_pubkey` in the conflict key / reject a
  device writing a foreign `(user,machine)`.
- **M6** (`P-055`) — federated claim-spec authz. `bee-claim-spec.ts` `writeToPg` guards only
  on `harness_slug` — no member/tier check — and `set_claim_spec` is any-`COORD_ROLES`, so
  a member can redirect another member's bee. Fix: mirror `coord-message`'s pattern — thread
  `hiveHomeSlug`/`resolveAuthorDevice`/`resolveCommsTier` into `BeeClaimSpecProjectionOpts`
  and gate apply behind `decideMemberContentOp` (verified device ∈ members) AND
  `commsTierAtLeast(authorTier,'steer')` (a claim spec is a steer-class action).

**Security discipline for Tier B:** these are the trust boundary. Design deliberately,
add adversarial tests (a hostile signed frame must be dropped), and DO NOT enable any
multi-owner hive until H1–H3 + M6 are done AND `LIVE-1` is green. The same-owner dogfood
hive (`comms.defaultTier:'steer'`) is unaffected by all four, so Tier B does not block
dogfood.

### Tier C — the feature-done gate

- **LIVE-1** (`P-059`). Nothing in this plan is proven live cross-machine — all green is
  in-process + fake-swarm, and the program's cardinal rule is "in-process green ≠ live
  green" (the A→B owner-admit race passed every in-process test and failed live). Build a
  2-machine rig (chassis: `papercusp-desktop/bin/lib/deb-hetzner-rig.sh` +
  `federation-asserts.sh`; owner-gated paid infra) proving at least: wake bridge, receipts,
  federated events, presence gossip, claim-spec federation. Then flip `PRESENCE_GOSSIP`
  (currently DARK — writer off → remote agents NOT yet addressable in prod) after the
  reader ships on both machines. This is the gate before the feature can be called done.

### Tier D — deferred design

- **P-021** (reset to `todo`, no code shipped). Rendezvous-hash the lock/claim authority
  per scope key (instead of one global `argmin(device_pubkey)` in
  `authority/lock-authority.ts selectAuthorityFromRows`) + short authority-lease stickiness
  to damp flapping. Keep the deterministic-across-peers property. Flag-gated cutover, like
  the other authority changes; prove the pure selector + churn-confinement in a unit test
  before touching the live election.

## 3. Load-bearing gotchas (will save you hours)

- **New federated table = 6 surfaces + the stamp trigger.** Follow
  `agent-insights/retire-or-add-a-federated-table` (registry, tag→table map, register-all,
  the projection, hyperbee-key-types, the capture producer). **AND** attach the
  `stamp_local_federated_write` BEFORE trigger in the migration (mirror mig 214/317/439) —
  the mig-438 omission of exactly this was the M7 regression. The
  `stamp-trigger-coverage.integration.test.ts` guard (exact-set-equality) catches it; run
  it. Also run `capture-coverage`, `projection-engine`, `register-all.test`,
  `hyperbee-key-types.test` for any federation-surface change.
- **Reserve migrations** with `db:next-migration`; write at
  `libs/papercusp/libs/db/sql/NNN-*.sql`.
- **Integration tests apply migs against fresh PG** (`createFreshPgDb`); when
  `sql.unsafe()`-applying a migration on a pooled connection, **strip `BEGIN;`/`COMMIT;`**
  (they error with `UNSAFE_TRANSACTION`) — reuse the `stripMeta` helper pattern.
- **Edit tool vs SQL em-dashes/NUL bytes:** exact-match `Edit` failed on lines with `—` or
  a literal NUL sentinel; when `old_string` won't match, do the surgical edit with a small
  `python3` heredoc instead.
- **Device-signing idiom** (for the identity-binding work): raw-32 Ed25519 pubkey base64 →
  SPKI rebuild → verify; fixed-field-order JSON signing bytes; freshness window. Templates:
  `presence-gossip.ts` (`verifyPresenceFrame`) and `hive-announce.ts`.
- **`federated-wake-rate.ts`** is the per-author-device token bucket already used by the
  wake fans — reuse it for M5b (don't invent a second limiter).

## 4. Scope boundary (avoid colliding with the git agent)

- **You own:** `sync/hyperbee/presence-*`, `projections/presence.ts`,
  `projections/bee-claim-spec.ts`, `session-presence-store.ts`, `comms-tier-gate.ts`,
  `coord-quarantine-store.ts`, `member-rate-gate.ts`, `recipient-resolve.ts`,
  `authority/lock-authority.ts`, the presence/session/comms migrations, and Phase 9 / P-021
  plan items.
- **The git agent owns:** everything under a new `hive-git` module, the `G-*`/`DG-*` items,
  and the git-transport/integrator design.
- **Shared file to coordinate on:** `projections/coord-message.ts` (you edit the M5b
  receipt path; the git agent may add a `git:staging-advanced` fed-event consumer). Small,
  additive, different regions — `coord:send` a heads-up before a big edit there.

## 5. Definition of done for your handoff

Tier A + B landed with tests green (unit + integration + the federation guards); `D-014`'s
matrix updated as items move (mark done with evidence via `plans:edit`, like M4/M7 were);
Tier B items closed as blockers so multi-owner can be considered; `LIVE-1` either done or
explicitly left as the owner-gated gate with the rig scaffolded. Keep `## Now` and `D-014`
honest — a future reader must be able to tell real from flag-dark from unproven-live.
