# Findings EN-1 — Owner-enforcement: policy model + claim-gated authoring

**Status: LANDED + GREEN** (2026-06-19). Plan `shared-hive-owner-enforcement-2026-06-19`,
Phase EN-1. The FOUNDATION of the owner-enforcement layer — owner-signed federated policy
storage + the claim-gated authoring surface. No enforcement yet (EN-2/3/4 build on this).

## What shipped

### 1. `harness_shared.hive_policy` storage (federated, owner-signed)
- **Migration 317** (`libs/papercusp/libs/db/sql/317-hive-policy.sql`). SINGLETON per Hive:
  PK `(workspace_id, harness_slug)` where `harness_slug` = the Hive home_slug (so it rides the
  Hive-pubkey topic via the existing peer-log machinery — the capture trigger reads
  `harness_slug`, so the column MUST be named that, exactly like `hive_settings`).
- Columns: `policy_json TEXT` (the canonical signed JSON — **TEXT not jsonb on purpose**: the
  signature is over the exact canonical bytes, and a jsonb round-trip could re-canonicalize
  them; mig-186 follows the same "no jsonb-binding dance" rule), `owner_pubkey`, `signature`,
  `policy_version INT`, + the standard federation columns (`author_pubkey`, `origin`, `fed_ts`,
  `fed_hlc` (D-001 mig-314 LWW key), `created_at`, `updated_at`).
- Federation wiring mirrors `hive_settings`: capture triggers + the **`stamp_local_federated_write`
  BEFORE trigger** (required — mig-314's stamp list is fixed, so a new federated table must attach
  it itself, else local writes never get `fed_hlc`/`fed_ts` and never federate). Table-registry
  (`PEER_LOG_WORKSPACE_OWNED`), op-keys value-mapper (`toHivePolicyValue`, tableTag `hive-policy`),
  and `register-all` (scoped to `hiveScoped` — the hive-HOME slug — so a JOINER's member harness
  receives it, the same A-003 nuance `hive_settings`/`hive_members` use).

### 2. Typed, versioned, forward-compatible schema (`hive-policy-schema.ts`)
`{ rate?, membership?: open|approval|allowlist, allowlist?, moderation?: {reportable, bannedGithubIds,
takedownList}, contrib?, content? }` + `[k:string]: unknown`. Unknown keys are PRESERVED (canonical
form covers the whole object) — an older peer round-trips + verifies a newer field. Absent policy ⇒
permissive (no enforcement); existing Hives unaffected.

### 3. Owner signature — signed on author, VERIFIED on apply (the S0)
- Sign: `hive-policy-author.ts` → `signWithHiveKey` (owner Swarm only) over
  `hivePolicySignedBytes({domain, ws, slug, version, canonicalJson})` (domain-separated + binding-bound
  ⇒ no cross-hive/version replay).
- Verify: `projections/hive-policy.ts` re-derives the SAME bytes (single source of truth in
  `hive-policy-schema`) and checks `verifyEd25519` against the **trust anchor = the Hive identity
  pubkey** (`getHiveBySlug().pubkeyBase64`, known on owner + member). A forged/wrong-signer/unsigned
  policy is DROPPED, never materialized; absent hive identity ⇒ fail closed.

### 4. Claim-gated authoring API + GUI
- `POST /api/hive/:id/policy` (`endpoint-route/routes/hive/policy-set.ts`) — gated: `claim_status==='claimed'`
  AND viewer ∈ `claimed_by_github_user_ids` (reuses the `shared_repo_binding_cache` row +
  `resolveLocalGithubIdentity`). Unclaimed/no-binding ⇒ 403; non-claimant ⇒ 403; claimant-but-no-hive-key
  ⇒ 409. `GET` reads current policy. Then `authorHivePolicy` signs + writes (federates).
- Minimal GUI: `HivePolicyPanel` mounted in `/settings/hive-customization`, gated on
  `useHarnessClaimStatus().viewer_is_claimant`, nuqs `?hivePolicy=` open-state. Honestly flags that
  `prsPerDay` is an EN-4 P-CONTRIB rule (not yet substrate-enforced).

### Reader for EN-2/EN-3/EN-4
`getHivePolicy(ws, hiveHome) → ResolvedHivePolicy | null` (null = permissive). Returns ALREADY-VERIFIED
state (forged never lands in PG). `mutateHivePolicy()` = read→mutate→re-sign accessor for EN-3 ban/takedown.

## Teeth (all GREEN)
- **27 unit tests**: canonicalization determinism + forward-compat, signed-bytes binding, sign→verify
  roundtrip (tamper/wrong-key/replay all rejected), input validation, claim-gate (all S0 cases +
  the teeth: flip viewer to claimant ⇒ 200, proving the gate blocks the outsider), author version-bump.
- **7 real-PG integration teeth** (`hive-policy.integration.test.ts`): round-trip owner→member applies;
  newer fed_hlc wins + stale replay rejected (LWW); **forged (attacker key) DROPPED**, unsigned DROPPED;
  **TEETH — neuter the verify ⇒ the SAME forged policy applies** (proves the sig check is load-bearing);
  absent policy ⇒ null; absent hive identity ⇒ fail closed.
- **Structural CI guards GREEN**: capture-coverage (hive_policy has its CDC producer), projection-engine
  (every tableTag has a projection), federated-column-completeness (bumped 13→14; migration 317 applies
  clean 000→head on real PG; every column carried-or-documented-local).

## Done-gate (brief EN-1)
✅ An owner-signed policy authored only by the claimed owner federates to members, is signature-verified,
orders by fed_hlc, and a non-owner/forged policy cannot be written (403) or applied (dropped).
