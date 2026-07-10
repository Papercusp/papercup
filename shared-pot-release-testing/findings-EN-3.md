# Findings EN-3 — Owner-enforcement: membership admission (P-MEMBER) + moderation (P-MOD)

**Status: LANDED + GREEN (code/suite/structural).** Plan `shared-pot-owner-enforcement-2026-06-19`,
Phase EN-3. Builds on EN-1 (the owner-signed federated policy) and is ENFORCED through the
EN-4 `policy-admission` seam (findings-EN-4.md). Continued + completed 2026-06-19 (su-328af):
the EN-3 modules + 7 agent-tools were authored earlier but were **unwired** — federation
TS-layer absent + tools unregistered; this pass wired and validated them.

## What EN-3 is

The claimed owner's **control surface**: who may join + write (P-MEMBER) and what gets
taken down / who gets banned (P-MOD). Two enforcement substrates:

- **Owner-SIGNED, on the policy (EN-1):** `membership: open|approval|allowlist` + `allowlist`
  (P-MEMBER), `moderation.bannedGithubIds` + `moderation.takedownList` (P-MOD ban/takedown).
  These ride the owner signature → forgery-resistant + monotonic-version no-resurrection for
  free, and are ENFORCED at the EN-4 seam on every honest peer.
- **Member→owner federated tables (mig 318):** `hive_pending_joins` (a joiner's approval
  request → the owner's decision) and `hive_reports` (a member's report → the owner's queue).
  These can't ride the owner signature (members write them), so they are their own federated
  peer-log tables.

## What shipped (modules — authored earlier)

- `pot-membership-policy.ts` — pure deciders: `isBannedGithubId` (stable numeric id),
  `isAllowlisted` (case-insensitive login), `evaluateMembershipAdmission` (open/approval/allowlist).
- `pot-membership-admission.ts` — `approvePendingJoin` / `denyPendingJoin` (owner decisions;
  approve → `upsertHiveMember` + status='approved').
- `pot-moderation.ts` — `takedownContent` / `restoreContent` (append/remove a ref on the
  owner-signed `moderation.takedownList`, re-signed), `banMember` / `unbanMember` (on
  `moderation.bannedGithubIds`), and the PURE predicates `isContentTakenDown(policy, ref)` +
  `filterTakenDownContent(rows, policy, refOf)`.
- `pot-pending-joins-store.ts` + `pot-reports-store.ts` — PG access to the two federated tables.
- **Migration 318** (`318-en3-membership-moderation-tables.sql`) — `hive_pending_joins` +
  `hive_reports`, both with the full federation bookkeeping (`stamp_local_federated_write`
  BEFORE trigger + `capture_substrate_outbox` AFTER triggers, `fed_hlc` LWW, `origin`
  echo-guard), scope column `harness_slug` = the Pot home (rides the Pot-pubkey topic).
- Hyperbee→PG projections `projections/pot-reports.ts` + `projections/pot-pending-joins.ts`
  (mirror `pot-settings`; HLC LWW so the owner's later decision/resolution wins over the
  request/report; per-projection `harness_slug` demux).
- 7 agent-tools under `agent-tools/pot/`: `membership_pending`, `membership_decide`,
  `report`, `moderation_queue`, `moderation_resolve`, `takedown`, `ban_member`.

## What this pass WIRED (the gap that made EN-3 dead)

The SQL capture + the projection modules existed, but the **connective TS federation layer
and the tool registration were missing** — so reports/pending-joins captured to the outbox
but could not drain/serve/apply, and no owner verb was callable. Completed, mirroring EN-1's
`pot-policy` exactly:

1. **`table-registry.ts`** — `hive_reports` + `hive_pending_joins` added to
   `PEER_LOG_WORKSPACE_OWNED` (→ `PEER_LOG_TABLES`, sync:'peer-log').
2. **`feature-issue-op-keys.ts`** — tableTag map (`hive_reports`→`pot-reports`,
   `hive_pending_joins`→`pot-pending-joins`) + value-mappers `toHiveReportValue` /
   `toHivePendingJoinValue` + the dispatch cases + the `value` union types. (This auto-bumped
   `CDC_CAPTURED_TABLES` 14→16.)
3. **`projection-engine.ts`** — `PEER_LOG_TAG_TO_TABLE` entries for both tags.
4. **`projections/register-all.ts`** — imports + `REGISTERED_PROJECTION_TAGS` + both built
   under `hiveScoped` (so a JOINER's member harness lands the home-grained ops — the same
   A-003 nuance hive_settings/hive_members/hive_policy use).
5. **`agent-tools/index.ts`** — registered the 7 EN-3 tools.

## Enforcement path (how a policy actually bites)

- **ban / allowlist:** federate on the owner-SIGNED `hive_policy` (EN-1, already wired) →
  ENFORCED at the EN-4 `policy-admission` seam in `boot.ts` (findings-EN-4): a banned author's
  ops are dropped in every mode; under `allowlist`, a non-listed author's ops are dropped.
- **takedown:** federates on the signed policy → enforced at the EN-4 seam (`isContentTakenDown`
  matches the op's content ref = `op.hbKey`, the feature/work-item id) → a taken-down content
  op is dropped before merge on every honest peer (no resurrection: an old signed policy
  lacking the ref loses on `policy_version`/`fed_hlc`).
- **report:** `pot:report` (gated on `moderation.reportable`) writes `hive_reports` origin=local
  → federates to the owner's `pot:moderation_queue` → owner `pot:moderation_resolve` /
  `pot:takedown` / `pot:ban_member`; the resolution federates back.
- **approval mode:** a joiner's request writes `hive_pending_joins` → federates to the owner →
  `pot:membership_decide` (approve → `upsertHiveMember`) → the decision federates back. NOT
  re-decided per-op at the EN-4 seam (that would wrongly drop already-approved authors — the
  join gate owns approval; stated honestly in `policy-admission.ts`).

## Revocation teeth (the hard cut) — DEPENDS on the C-001 re-key

`pot:ban_member` records the ban on the signed policy (soft cut: honest peers drop the
banned author's ops) AND is designed to drive `substrate:revoke_contributor` → the **C-001
re-key (Move 2)** epoch advance, which cuts the abuser's READ+WRITE at the next epoch (the
ultimate teeth). The signed-policy drop is live now; the cryptographic read-cut rides the
re-key build (in flight, separate critical-path item per the rollup). Documented honestly:
until the re-key lands, ban is a write-admission drop on honest peers, not a read cut.

## Teeth (GREEN this pass)

- `pot-membership-admission.test.ts`, `pot-moderation.test.ts` — pure deciders + owner
  actions (part of the 100-test EN-1..EN-4 unit pass).
- `agent-tools/pot/tools.test.ts` 26/26 — tool registry intact after registering the 7 tools.
- Structural federation guards GREEN with the 2 new tables:
  - `capture-coverage.test.ts` 9/9 — every PEER_LOG table has exactly one producer
    (CDC + LOG_FIRST + ACCEPTED == PEER_LOG_TABLES; balance held at +2/+2).
  - `projection-engine.test.ts` — every federated tableTag has a projection + tag→table map.
  - `federated-column-completeness.integration.test.ts` 17/17 (real PG, 000→head): mig 318
    applies clean; every `hive_reports` / `hive_pending_joins` column is carried by its mapper,
    PROVENANCE (workspace_id/origin/fed_ts/fed_hlc/author_pubkey), GENERATED
    (`pending_join_fed_key`), or documented machine-local (created_at/updated_at). Count
    bumped 14→16.
- `tsc --noEmit` — all EN-3 source files type-clean.

## Honest residuals / not-yet

- **Live witness:** federation is suite + structural + column-grain GREEN, and rides the
  A-003 pot-home seam that just hit its first green LIVE witness (owner→joiner on the real
  .deb). A dedicated live report→queue→takedown round-trip on a .deb is the remaining
  release-grade proof (rides the EN-4 enforcement live-witness, findings-EN-4).
- **Ban's hard read-cut** waits on the C-001 re-key (above).
- **`prsPerDay`** is a code-plane cap (Brief AH), not substrate-enforced — EN-1's GUI labels it
  fast-follow.

## Done-gate (brief EN-3)

✅ The claimed owner can set membership mode + ban/takedown via the signed policy and the
report/approval flow federates member↔owner; a banned/non-allowlisted author's ops and
taken-down content are dropped by an honest peer at the EN-4 seam; reporting is off by default
(no behavior change for existing pots). REMAINING for full release: the live .deb round-trip
witness + the C-001 re-key for ban's cryptographic read-cut.
