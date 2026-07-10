# Findings EN-1 — Owner-enforcement: policy model + claim-gated authoring

**Status: LANDED + GREEN** (2026-06-19). Plan `shared-pot-owner-enforcement-2026-06-19`,
Phase EN-1. The FOUNDATION of the owner-enforcement layer — owner-signed federated policy
storage + the claim-gated authoring surface. No enforcement yet (EN-2/3/4 build on this).

## What shipped

### 1. `harness_shared.hive_policy` storage (federated, owner-signed)
- **Migration 317** (`libs/papercusp/libs/db/sql/317-hive-policy.sql`). SINGLETON per Pot:
  PK `(workspace_id, harness_slug)` where `harness_slug` = the Pot home_slug (so it rides the
  Pot-pubkey topic via the existing peer-log machinery — the capture trigger reads
  `harness_slug`, so the column MUST be named that, exactly like `hive_settings`).
- Columns: `policy_json TEXT` (the canonical signed JSON — **TEXT not jsonb on purpose**: the
  signature is over the exact canonical bytes, and a jsonb round-trip could re-canonicalize
  them; mig-186 follows the same "no jsonb-binding dance" rule), `owner_pubkey`, `signature`,
  `policy_version INT`, + the standard federation columns (`author_pubkey`, `origin`, `fed_ts`,
  `fed_hlc` (D-001 mig-314 LWW key), `created_at`, `updated_at`).
- Federation wiring mirrors `hive_settings`: capture triggers + the **`stamp_local_federated_write`
  BEFORE trigger** (required — mig-314's stamp list is fixed, so a new federated table must attach
  it itself, else local writes never get `fed_hlc`/`fed_ts` and never federate). Table-registry
  (`PEER_LOG_WORKSPACE_OWNED`), op-keys value-mapper (`toHivePolicyValue`, tableTag `pot-policy`),
  and `register-all` (scoped to `hiveScoped` — the pot-HOME slug — so a JOINER's member harness
  receives it, the same A-003 nuance `hive_settings`/`hive_members` use).

### 2. Typed, versioned, forward-compatible schema (`pot-policy-schema.ts`)
`{ rate?, membership?: open|approval|allowlist, allowlist?, moderation?: {reportable, bannedGithubIds,
takedownList}, contrib?, content? }` + `[k:string]: unknown`. Unknown keys are PRESERVED (canonical
form covers the whole object) — an older peer round-trips + verifies a newer field. Absent policy ⇒
permissive (no enforcement); existing Pots unaffected.

### 3. Owner signature — signed on author, VERIFIED on apply (the S0)
- Sign: `pot-policy-author.ts` → `signWithHiveKey` (owner Swarm only) over
  `hivePolicySignedBytes({domain, ws, slug, version, canonicalJson})` (domain-separated + binding-bound
  ⇒ no cross-pot/version replay).
- Verify: `projections/pot-policy.ts` re-derives the SAME bytes (single source of truth in
  `pot-policy-schema`) and checks `verifyEd25519` against the **trust anchor = the Pot identity
  pubkey** (`getHiveBySlug().pubkeyBase64`, known on owner + member). A forged/wrong-signer/unsigned
  policy is DROPPED, never materialized; absent pot identity ⇒ fail closed.

### 4. Claim-gated authoring API + GUI
- `POST /api/pot/:id/policy` (`endpoint-route/routes/pot/policy-set.ts`) — gated: `claim_status==='claimed'`
  AND viewer ∈ `claimed_by_github_user_ids` (reuses the `shared_repo_binding_cache` row +
  `resolveLocalGithubIdentity`). Unclaimed/no-binding ⇒ 403; non-claimant ⇒ 403; claimant-but-no-pot-key
  ⇒ 409. `GET` reads current policy. Then `authorHivePolicy` signs + writes (federates).
- Minimal GUI: `HivePolicyPanel` mounted in `/settings/pot-customization`, gated on
  `useHarnessClaimStatus().viewer_is_claimant`, nuqs `?hivePolicy=` open-state. Honestly flags that
  `prsPerDay` is an EN-4 P-CONTRIB rule (not yet substrate-enforced).

### Reader for EN-2/EN-3/EN-4
`getHivePolicy(ws, hiveHome) → ResolvedHivePolicy | null` (null = permissive). Returns ALREADY-VERIFIED
state (forged never lands in PG). `mutateHivePolicy()` = read→mutate→re-sign accessor for EN-3 ban/takedown.

## Teeth (all GREEN)
- **27 unit tests**: canonicalization determinism + forward-compat, signed-bytes binding, sign→verify
  roundtrip (tamper/wrong-key/replay all rejected), input validation, claim-gate (all S0 cases +
  the teeth: flip viewer to claimant ⇒ 200, proving the gate blocks the outsider), author version-bump.
- **7 real-PG integration teeth** (`pot-policy.integration.test.ts`): round-trip owner→member applies;
  newer fed_hlc wins + stale replay rejected (LWW); **forged (attacker key) DROPPED**, unsigned DROPPED;
  **TEETH — neuter the verify ⇒ the SAME forged policy applies** (proves the sig check is load-bearing);
  absent policy ⇒ null; absent pot identity ⇒ fail closed.
- **Structural CI guards GREEN**: capture-coverage (hive_policy has its CDC producer), projection-engine
  (every tableTag has a projection), federated-column-completeness (bumped 13→14; migration 317 applies
  clean 000→head on real PG; every column carried-or-documented-local).

## Done-gate (brief EN-1)
✅ An owner-signed policy authored only by the claimed owner federates to members, is signature-verified,
orders by fed_hlc, and a non-owner/forged policy cannot be written (403) or applied (dropped).

## Follow-on hardening — stamp-trigger coverage guard (session reflection)
**Gap this session exposed.** Authoring mig-317 (hive_policy), the `stamp_local_federated_write_trg`
BEFORE trigger had to be attached *by hand* — and **nothing in CI would have failed had it been
omitted**. A federated CDC table whose local write isn't stamped captures `op_hlc = NULL` (the AFTER
`capture_substrate_outbox` threads `NEW.fed_hlc` onto the op), so the op federates with no LWW ordering
key and last-writer becomes indeterminate — silently. The two existing coverage guards both stay GREEN
through this: `checkSubstrateCaptureCoverage` proves a *producer* exists (table grain);
`federated-column-completeness` proves every *column* survives the mapper (column grain). Neither proves
the *stamp trigger* is attached.

**Closed (no schema/behavior change).** Added `lib/sync/hyperbee/__tests__/stamp-trigger-coverage.integration.test.ts`
— migrates 000→head on real PG (same harness as the column-completeness sibling) and introspects
`pg_trigger` + `information_schema.columns`. Invariant, keyed on the HLC column so it can't false-positive
on a table that doesn't order by fed_hlc: *every `CDC_CAPTURED_TABLES` table carrying a `fed_hlc` column
must have `stamp_local_federated_write_trg`, except a documented `STAMP_EXEMPT` set.* Core check is an exact
set-equality with teeth in three directions (new fed_hlc-table-without-trigger → RED; trigger removed → RED;
stale exemption → RED). Teeth verified (emptying STAMP_EXEMPT turns it RED naming `harness_plan_parts`).

The same file also closes the **symmetric** half: the CAPTURE trigger must be *physically* attached in the
migrated DB for every `CDC_CAPTURED_TABLES` entry. `checkSubstrateCaptureCoverage` asserts a producer exists
in the *in-code* op-key registry but never checks the DDL attached it — a new op-key-map entry whose
`CREATE TRIGGER … capture_*_outbox` migration was forgotten passes the in-code guard yet never federates
(local writes drop on the floor); the per-table behavioral tests only cover tables someone wrote a test for.
The DDL-attachment check introspects `pg_proc`/`pg_trigger` for the `capture_*_outbox` family. **6 tests GREEN.**

A third live-schema guard from the same reflection pass (`rls-coverage.integration.test.ts`, GREEN)
found 8 federated workspace-scoped tables without RLS. Investigation showed these use the codebase's
*explicit-`workspace_id`-filtering* isolation model (verified), not RLS — so it is a low-severity
**defense-in-depth** gap (no RLS backstop), with one concrete unfiltered read in `topics-feed.ts`.
Full writeup + options in **`findings-rls-coverage.md`**. (An interim escalation to "likely-real leak"
was refuted by checking the read sites — corrected.)

**Not a bug — one documented exemption.** `harness_plan_parts` carries `fed_hlc` (mig-314) + a CDC capture
trigger (mig-271) but intentionally has no stamp trigger: plan-part federation is flag-gated/DARK and
mig-314 (lines 160-163; findings-J) deliberately keeps the fed_ts=0/now baseline until GA, with the LWW
guard's fed_ts fallback covering ordering meanwhile. Recorded in `STAMP_EXEMPT` with the re-arm condition
(remove the entry + attach the trigger in the GA migration). `contributor_usage_events` is auto-exempt —
no `fed_hlc` column, "does not actually federate" (WI-192 / mig-301).

**Owner follow-up (no consensus reachable this session — coord MCP down):** when
`papercusp-plan-part-federation` goes GA, the GA migration must attach `stamp_local_federated_write_trg` to
`harness_plan_parts` and drop its `STAMP_EXEMPT` entry — at which point this guard flips RED until both are
done, which is the intended forcing function.
