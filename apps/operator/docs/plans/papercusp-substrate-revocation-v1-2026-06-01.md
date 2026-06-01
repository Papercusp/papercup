---
title: Substrate revocation v1 — enforce + trigger self-revocation
slug: papercusp-substrate-revocation-v1-2026-06-01
status: draft
created: 2026-06-01
owner: avi@storewolf.com
implements_spec: self (small feature spec)
relates_to: papercusp-phase1b-bidirectional-federation-2026-06-01, papercusp-substrate-model-b-rewrite-2026-05-31
---

# Substrate revocation v1 — enforce + trigger self-revocation

## Now

**State:** DESIGN SPEC — design presented; proceeding to plan + build (the user
delegated; v1 has no open fork requiring input — it is authority-free and closes a
real gap). No code yet.

**Problem (latent gap found 2026-06-01):** the Model B admission `revoked` Set
(`boot.ts:401`) is seeded EMPTY at boot and is only ever mutated by the in-memory
`handle.revoke()`. **Published revocations are therefore ignored.** The data model
already exists — `harness_shared.contributors.revoked_pubkeys` (`TEXT[]`,
`ensure-schema-dogfood.ts:137`; `ContributorRow.revoked_pubkeys`;
`isPubkeyRevoked()` helper; written by the contributors projection) — but boot
never loads it, so a contributor who revokes a lost/compromised device (adds it to
their own row's `revoked_pubkeys` and replicates it) is **not enforced**: the
revoked device is still admitted. v1 fixes that and adds the trigger to perform a
self-revocation.

**Next:** writing-plans → subagent-driven build.

## Scope

**v1 = SELF-revocation (authority-free).** A peer is authoritative over its OWN
device keys (the Keybase/Sigstore model). Two halves:
1. **Enforce** published revocations at the admission gate (the missing piece).
2. **Trigger** a self-revocation of one of your own devices.

**OUT OF SCOPE (v2, needs a trust-model decision the owner makes):**
- **Owner-revokes-others** — kicking out a *different* contributor's device (a bad
  actor). This needs an authority model (who may revoke whom — likely the harness
  owner via the P-068 canonical-owner binding). It is the same class of decision as
  the read-admission/no-collaborator-gate posture and is explicitly deferred to its
  own design.
- A purely-local "this node refuses to replicate peer X" drop (authority-free but
  lower value than enforcing published self-revocations) — deferrable.
- Un-revoke / re-instate — YAGNI for v1; revocation is append-only here.

## Decisions

- **D-001 — Enforce the EXISTING `revoked_pubkeys`; no new table.** The
  per-contributor `revoked_pubkeys` (on `harness_shared.contributors`, replicated
  via the substrate) is the canonical revocation record. v1 makes boot/admission
  honor it; it does NOT add a parallel store.
- **D-002 — Boot seeds `revoked` from the union of all contributors'
  `revoked_pubkeys` for the harness, and REFRESHES after each merge.** So a
  revocation that replicates in mid-session is honored without a reboot.
- **D-003 — Self-revocation only.** The trigger revokes the LOCAL peer's own
  device pubkey(s): it appends the local peer's updated contributor row (target
  pubkey added to `revoked_pubkeys`) to the peer's own log via the existing
  `write-contributor-row`, and calls the live `handle.revoke(devicePubkey)` for
  immediate local effect. No authority over other identities.
- **D-004 — Surface: operator endpoint + MCP tool.** `POST /api/admin/substrate/
  revoke-self-device` (loopback/Host-gated like the other admin routes) +
  `substrate:revoke_self_device` MCP tool. No bespoke UI in v1 (the substrate admin
  page can grow a button in a follow-up).
- **D-005 — Append-only / idempotent.** Revoking an already-revoked pubkey is a
  no-op (it's already in the row + the Set). No un-revoke.

## Design

### Component A — `loadRevokedPubkeys(workspaceId, harnessSlug)` (enforcement read)
A small PG helper (lives beside the other hyperbee PG reads, e.g.
`apps/operator/lib/sync/hyperbee/load-revoked-pubkeys.ts`): selects
`revoked_pubkeys` across all rows of `harness_shared.contributors` for
`(workspace_id, harness_slug)` and returns the flattened, de-duplicated set of
device pubkeys. Pure read; injectable `runQuery` seam for tests.

### Component B — boot wiring (enforcement apply)
`bootHarnessSubstrate`:
- **At startup:** after the `revoked` Set is created, `await` `loadRevokedPubkeys`
  and add each to the Set (so admission honors published revocations from the first
  announce). Defensive: a load failure logs + leaves the Set as-is (fail-open on the
  LOAD is acceptable — the live `handle.revoke()` + the next refresh still apply; do
  NOT fail the boot).
- **After each merge:** in the merge driver (the `mergeNow`/poll path), re-run
  `loadRevokedPubkeys` and union any NEW pubkeys into the Set, then if any newly-
  revoked pubkey is currently `admitted`, drop it (reuse the `revoke()` drop path so
  its log leaves the admitted set + a `peer_revoked` event is recorded). This makes a
  mid-session replicated revocation take effect without a reboot. Inject the loader
  for tests (`opts.loadRevokedOverride`).

### Component C — self-revocation trigger
- A core function `revokeSelfDevice({ workspaceId, harnessSlug, devicePubkey })`:
  1. Resolve the local peer's identity (`resolveLocalGithubIdentity`) → its
     contributor row (from `harness_shared.contributors` by `github_user_id`).
  2. Guard: `devicePubkey` must be one of the local identity's OWN device pubkeys
     (in the row's `device_attestations` / its own published key) — refuse to
     "self-revoke" a key that isn't yours (that would be owner-revocation, out of
     scope). Return a structured error if not.
  3. Append the updated contributor row (with `devicePubkey` added to
     `revoked_pubkeys`, idempotent) to the local peer's own log via
     `write-contributor-row` (so it replicates to peers + projects to PG).
  4. Call the live booted `handle.revoke(devicePubkey)` for immediate local effect
     (drop from admitted + block re-announce).
  Idempotent; injectable seams (identity resolver, row loader, the write fn, the
  handle lookup) for tests.
- **Endpoint** `POST /api/admin/substrate/revoke-self-device` (deps-injected like
  `share-finalize`/`join-link`; loopback/Host-gated): body `{ workspaceId,
  harnessSlug, devicePubkey }` → calls `revokeSelfDevice`; 200 on success, 4xx on
  "not your key" / bad input, 404 if the harness isn't booted.
- **MCP tool** `substrate:revoke_self_device` (in `apps/operator/lib/agent-tools/`
  or `packages/agent-mcp` per the first-party-tool placement rule) wrapping the same
  core function, with `guidance.when`.

### Error handling
- Load failure at boot → log, continue (fail-open on load; live revoke + refresh
  still work). A revocation that can't be read at boot is re-tried on the next merge.
- "Not your device pubkey" → structured 4xx / tool error (out-of-scope owner
  revocation).
- Harness not booted → 404 (no live handle to apply to; the row write still
  persists so it's honored on next boot).

### Testing
- **Unit:** `loadRevokedPubkeys` (union + dedupe across rows; empty harness → empty
  set; injected query). `revokeSelfDevice` (writes the row with the pubkey added;
  calls handle.revoke; refuses a non-own pubkey; idempotent). Endpoint (deps-injected:
  success, not-your-key 4xx, not-booted 404, loopback gate). MCP tool registration +
  guidance.
- **Boot integration (extend the hyperbee suite):** boot with a seeded
  `loadRevokedOverride` → a pre-revoked pubkey is in the `revoked` Set → an announce
  from that pubkey is refused (`reason:'revoked'`) on the FIRST announce (proves
  startup enforcement). And: a revocation that appears via the merge refresh drops an
  already-admitted peer mid-session (proves the refresh path). Use the existing
  fake-store/handle + `verifyBindingOverride` seams.
- No new browser/UI test (no UI in v1).

## Verification (definition of done)
1. A device pubkey present in any contributor's `revoked_pubkeys` is in the boot
   `revoked` Set and its announce is refused — proven by the boot integration test.
2. `revokeSelfDevice` on one's OWN device: the row is updated + replicated (PG shows
   the pubkey in `revoked_pubkeys`), the live peer is dropped, and after the change
   replicates, OTHER peers refuse that device on its next announce.
3. Revoking a non-own pubkey is refused (owner-revocation stays out of scope).
4. Full hyperbee + harness + endpoint suites green.

## References
- Boot/admission: `apps/operator/lib/sync/hyperbee/boot.ts` (`revoked` Set @401,
  `revoke()` @609), `read-admission.ts`.
- Existing revocation data model: `apps/operator/lib/harness/contributor-row-types.ts`
  (`revoked_pubkeys`, `isPubkeyRevoked`), `ensure-schema-dogfood.ts:137`,
  `apps/operator/lib/sync/hyperbee/projections/contributors.ts`.
- Row write: `apps/operator/lib/sync/hyperbee/write-contributor-row.ts`.
- Identity: `apps/operator/lib/identity/resolve-local-github-identity.ts`.
- Admin-route + deps-injection pattern: `share-finalize.ts`, `join-link.ts`.
- Trust model (revocation tradeoffs — non-retroactive, GitHub-is-authority):
  `papercusp-trust-model-2026-05-31`, `papercusp-phase1b-bidirectional-federation-2026-06-01` §8 (D-009).
