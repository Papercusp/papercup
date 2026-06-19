# Brief AK — Owner-enforcement layer: live enforcement witness (the release-grade proof)

**Priority: S0/S1 lane.** Integration + live (.deb). The owner-enforcement layer
(`PLAN-owner-enforcement-layer.md`, EN-1..EN-4) is now **fully wired + suite/structural-green**
(findings-EN-1..EN-4) and committed/on-staging. This is the test lane the plan §8 names —
"Brief AK drives these once the layer lands." The layer has landed; drive the live witness.

## Objective
Prove on the REAL binary, across two peers, that an owner-set Hive policy is ENFORCED at op
admission on an honest peer — not just suite-green. The implementation is done; this is the
"green-rig/red-binary" closer (the lesson that bit A-003 three times this program).

## Why it matters
EN-1..EN-4 are proven by unit + integration + the full hyperbee backbone (1076 tests) + a
new boot-composition integration test, AND they ride the A-003 hive-home seam that just hit
its first green LIVE witness (policy federates owner→member on the real .deb). What is NOT yet
live-witnessed is the *enforcement bite* end-to-end on the binary: owner sets a policy → it
federates → a member peer's violating op is dropped. That is the public-safety S0.

## Scope / scenarios (drive on an integrated .deb, 2 peers, never :0 — Xvfb)
1. **S0 — honest peer DROPS a policy-violating op.** Owner (claimed) sets `moderation.bannedGithubIds`
   = [member-B's gh id] via `hive:ban_member` / `POST /api/hive/:id/policy`. B authors content ops.
   Assert: on the OWNER's peer (and any third honest peer), B's ops are DROPPED at merge
   (origin=remote rows absent), while a non-banned member's ops apply. Teeth: stub the policy
   read to null (or neuter `decidePolicyOp`) → the SAME ops land = RED (proves the gate is load-bearing).
2. **EN-2 rate (P-RATE) live.** Owner sets `rate.opsPerMin=N`. A member floods >N in a window.
   Assert the honest peer keeps only the first N (per-author, per-window), the excess dropped;
   two honest peers converge on the SAME canonical set WITHOUT the flood.
3. **EN-3 allowlist (P-MEMBER) live.** Owner sets `membership:'allowlist'` + `allowlist`. A
   non-listed (but topic-admitted) member's ops are dropped; a listed member's apply.
4. **EN-3 takedown (P-MOD) live.** Owner `hive:takedown` a feature/work-item ref → the op for
   that `hbKey` is dropped on honest peers; **no resurrection** — re-federating the old content
   op stays hidden (the signed policy's takedownList wins on policy_version/fed_hlc).
5. **EN-3 report→queue→action federation.** With `moderation.reportable=true`, a MEMBER
   `hive:report`s content → it federates to the OWNER's `hive:moderation_queue` → owner
   `hive:moderation_resolve` / `hive:takedown`; the resolution federates back. (Rides the new
   `hive_reports` peer-log table — the EN-3 federation TS-wiring this session landed.)
6. **EN-3 approval mode (P-MEMBER).** `membership:'approval'`: a joiner's request federates to
   the owner (`hive_pending_joins`) → `hive:membership_decide` approve → `upsertHiveMember` +
   the decision federates back; the joiner is NOT trust-admitted until approved.
7. **S0 — authority + forgery.** Only a GitHub-verified `claimed` owner can write policy
   (non-claimant 403, unclaimed 403 — brief-AI's authority root); a forged/unsigned policy is
   DROPPED at apply (neuter the verify → forged applies = RED). (EN-1; suite-proven — confirm live.)
8. **Default-off.** A hive with NO policy set: byte-for-byte today's behavior (no drops). Existing
   hives unaffected.

## Method
Build the integrated .deb (sidecar-swap from staging — the A-003 lane's `/tmp/integrated-witness.sh`
pattern; reuse, DON'T leak PG instances — tear down every spawned instance, the su-9140a
witness-#3 leak is the cautionary tale). 2 peers on isolated ports. Set policy via the EN-1
HTTP route / the EN-3 tools. Assert drops on the honest peer's PG (origin='remote' rows
present/absent). Teeth-verify each S0 gate (neuter → RED). GUI leg optional: the EN-1
`HivePolicyPanel` (claim-gated) + the owner moderation queue.

## Out of scope (other lanes)
- **Ban's hard READ-cut** (a revoked abuser can't read NEW content) — the C-001 re-key (Move 2,
  K lane). Scenario 1 here proves the WRITE-admission drop (soft cut, live now); the read-cut
  rides the re-key. Don't block AK-green on the re-key.
- The decrypt-gate compose-order (findings-EN-4 §contract) — wired as an identity stub; the
  re-key lane fills it. Not exercised until `papercusp-hive-rekey` flips.

## Deliverables
- `findings-AK.md`: the live enforcement matrix (per scenario: GREEN / caveat / RED), the teeth
  evidence (each S0 gate RED when neutered), and any binary-only gap the suite missed.

## Done / verdict
GREEN when, on the real binary across 2 peers: an owner-set policy DROPS a banned/over-cap/
non-allowlisted/taken-down member op on an honest peer (teeth-verified), report+approval
federate member↔owner, a forged/non-owner policy can't be written or applied, and a no-policy
hive is byte-for-byte unchanged.

## Key files / prior art
- Enforcement seam: `packages/operator-core/lib/sync/hyperbee/boot.ts` (mergeOpts `applyImpl`),
  `policy-admission.ts`, `rate-limit-admission.ts`, `rate-limiter.ts`.
- EN-3: `hive-membership-policy.ts`, `hive-moderation.ts`, the 7 `agent-tools/hive/` verbs,
  `projections/hive-reports.ts` + `hive-pending-joins.ts`, migration 318.
- EN-1: `hive-policy-store.ts`, `hive-policy-author.ts`, `routes/hive/policy-set.ts`, migration 317.
- Suite prior art to extend live: `policy-admission.apply.test.ts`,
  `rate-limit-enforcement.test.ts`, `policy-admission-boot-composition.integration.test.ts`.
- Witness rig: the A-003 integrated-witness pattern (findings-AH / the I/J live legs).
- Findings: `findings-EN-1.md` .. `findings-EN-4.md`; authority root: `findings-AI.md`.
