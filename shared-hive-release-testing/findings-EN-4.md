# Findings EN-4 — Owner-enforcement: the single `policy-admission` boot seam (the keystone)

**Status: LANDED + GREEN.** Plan `shared-hive-owner-enforcement-2026-06-19`, Phase EN-4 — the
KEYSTONE that makes EN-1/EN-2/EN-3 actually bite. Continued + completed 2026-06-19 (su-328af):
`policy-admission.ts` (the pure decider + decorator) existed and was suite-green, but was
**NOT wired into `boot.ts`** (`applyImpl: scopedApply`, zero enforcement) — so all of EN-2's
rate limiter and EN-3's ban/allowlist/takedown were DEAD CODE. This pass wired the seam.

## What EN-4 is

ONE `applyImpl` decorator at the substrate's op-merge driver — the single place every inbound
op is checked against the owner's signed policy before merge. "Hard to bypass by omission":
enforcement lives at the one merge seam, not per-table, so a new federated table cannot
silently skip it.

The composed decision stack on a REMOTE op (per `policy-admission.ts`):

```
ban → allowlist → takedown → content   (EN-4 makePolicyEnforcedApply, outer)
  → rate                               (EN-2 makeRateLimitedApply,   inner)
    → scopedApply                      (the real per-harness PG projection apply)
```

## What this pass WIRED into `boot.ts`

1. **Imports** — `getHivePolicy` (EN-1 reader), `isContentTakenDown` (EN-3 P-MOD),
   `MemberRateLimiter` + `makeRateLimitedApply` (EN-2), `makePolicyEnforcedApply` (EN-4),
   `type HivePolicy`.
2. **A stable `const rateLimiter = new MemberRateLimiter()`** next to `scopedApply` — the
   limiter is STATEFUL across passes (its per-(author,class) tumbling windows persist), so it
   is created once and reused; only the policy snapshot is re-read per pass.
3. **The per-pass seam** at `mergeOpts` construction:
   - Read the owner-SIGNED policy ONCE per merge pass via
     `getHivePolicy(workspaceId, hiveHomeProjectionSlug ?? harnessSlug)`. This runs **only past
     the `!changed` early-return** — an idle / un-policed harness pays NOTHING. The Hive-home
     slug is the scope (`hiveHomeProjectionSlug` rebinds on the joiner re-key; the owner's home
     is its own slug).
   - Compose `enforcedApply = ownerPolicy ? makePolicyEnforcedApply({…, apply: makeRateLimitedApply({…, apply: scopedApply})}) : scopedApply` — wrapping the CURRENT `scopedApply` (which `rekey` may have rebound), EN-2 inner + EN-4 outer, exactly as `policy-admission.apply.test.ts` proves.
   - `mergeOpts.applyImpl = enforcedApply`.

### Key properties (preserved by the wiring)

- **Default-off = byte-for-byte unchanged.** No owner policy ⇒ `enforcedApply === scopedApply`
  (not even a wrapper closure). Existing hives are unaffected.
- **Author attribution is unforgeable + fail-closed.** `resolveAuthor` / `resolveAuthorId`
  key off the receiver-stamped `op.sourceLogKeyHex` via `admittedIdentities`
  (`githubUserId` + `githubUsername`=`githubLogin`), NOT the self-declared `writerPubkey`. An
  author-dependent rule (ban/allowlist/rate-when-capped) with an unresolved author drops the op.
- **Local ops never enforced** — `originOf(op, ownLog.keyHex)==='local'` ⇒ passthrough (you
  don't moderate your own writes).
- **One policy read per merge pass, not per op** — a pass applies up to 50k ops; the snapshot
  feeds both EN-2's `currentCaps` and EN-4's `currentPolicy` synchronously.
- **Takedown ref convention:** the EN-3 `isContentTakenDown(policy, ref)` predicate is adapted
  as `(policy, op) => isContentTakenDown(policy, op.hbKey ?? '')` — `op.hbKey` IS the
  feature/work-item content ref the owner takes down (correct for the content tables; a no-op
  for non-targeted tables since the owner only takes down feature/issue ids).

## Teeth (GREEN)

- `policy-admission.apply.test.ts` — the composed seam drops by ban (EN-4), by rate (EN-2),
  by content (EN-4); a clean under-cap op passes both; driven through the REAL
  `mergeAdmittedLogsIncremental`, an adversarial peer's policy-violating ops are dropped while
  own + good-member ops apply (honest state stays converged + policy-correct). TEETH: remove
  either decorator and a drop assertion flips RED.
- `policy-admission.test.ts`, `rate-limit-enforcement.test.ts`, `rate-limit-admission.test.ts`
  — the deciders + the EN-2 wrapper (honest-majority, anti-OOM, fail-closed, default-off).
- **`policy-admission-boot-composition.integration.test.ts`** (NEW, real PG) — pins the one
  link the unit seams don't: a policy STORED in PG, READ by the production `getHivePolicy`,
  fed into the EXACT boot composition through the real merge — banned/over-cap/takedown/oversize
  dropped, own + good-under-cap kept, and default-off (no row ⇒ getHivePolicy null ⇒ the SAME
  flood fully lands). Guards the EN-1-store → EN-4-seam data handoff against silent regression
  (the c9577 EN-2-task-7 follow-up). 2/2 green.
- **Boot-area regression** (the merge path my edit sits on): `boot.test.ts`, `boot-all.test.ts`,
  `boot-revoke-production-path.test.ts`, `cold-boot-resume.test.ts` — 49/49.
- **Full backbone regression**: `vitest run lib/sync/hyperbee` = **131/132 files, 1076 passed
  | 2 skipped, zero failures**, ON TOP of the re-landed+guarded A-003 fix (incl. swarm-chaos
  real-Hyperswarm churn + the A-003 same-topic boot rig). My wiring composes cleanly with A-003.
- `tsc --noEmit` — all EN-4 source files (boot.ts + the wired modules) type-clean.

## Honest-majority trust model

A malicious peer CAN ignore the policy on its own machine, but CANNOT make honest peers accept
its policy-violating ops: every honest peer runs this single seam independently and drops the
excess/banned/taken-down/oversize op, so it never becomes canonical on the honest majority.
The documented residuals are EN-2's (the forged-`ts` slow-ramp rate residual — inherent to any
convergent op-time scheme) and EN-3's approval-mode (the join gate, not the per-op seam, owns it).

## Compose-order contract — the shared `applyImpl` seam (EN-4 ↔ C-001 re-key)

The C-001 re-key (Move 2) adds a **decrypt-gate** that ALSO wraps `scopedApply` at the SAME
`boot.ts mergeOpts.applyImpl` seam. The two must be COMPOSED in a fixed order, never raced
(whoever edits the `applyImpl` expression last would clobber the other). Agreed contract
(coordinated with the K/re-key lane, su-ee7e9):

**Order (outer → inner):** `decrypt-gate (re-key) → EN-4 ban/allowlist/takedown/content →
EN-2 rate → scopedApply`.

Rationale: EN-4/EN-2 inspect `op.value` / `op.table` / `op.hbKey` / author, so the op must be
PLAINTEXT before they run ⇒ decrypt is strictly outermost; and an undecryptable op (the
read-cut) must drop BEFORE it spends rate budget or hits content checks.

**Seam (designed for race-free composition):** boot.ts builds the EN stack as a NAMED const —
`const enforcedApply = ownerPolicy ? makePolicyEnforcedApply(…makeRateLimitedApply(…scopedApply)) : scopedApply;`
— and `mergeOpts.applyImpl = enforcedApply;`. The re-key lane composes by WRAPPING that stable
named value at the `applyImpl:` line only (flag-gated to `papercusp-hive-rekey`), e.g.
`applyImpl: rekeyOn ? decryptGate(enforcedApply) : enforcedApply` — never rebuilding the EN
construction. `enforcedApply` re-reads the CURRENT `scopedApply` per pass, so it survives the
rekey rebind. One owner per expression ⇒ no clobber.

**STATUS (REAL gate WIRED 2026-06-19):** the stub has been replaced by the live re-key
decrypt-gate (su-ee7e9). boot.ts now builds the deps ONCE at boot scope —
`const rekeyDeps = await buildHiveRekeyBootDeps({ workspaceId, harnessSlug })` (line ~639,
`Promise<HiveRekeyBootDeps | null>`, null on flag-off/non-hive/no-device, flag checked FIRST so
the off-path is one cached read) — and the seam is
`applyImpl: rekeyDeps ? rekeyDeps.epochGate(enforcedApply) : enforcedApply` (line ~1167).
All three invariants hold: epochGate OUTERMOST (inv-1), built once (inv-2), null ⇒ enforcedApply
byte-for-byte (inv-3). Flag-dark until `papercusp-hive-rekey` (FLAGS.HIVE_REKEY) flips.

The compose order is pinned by a regression test (su-328af):
`lib/sync/hyperbee/rekey-enforcement-compose-order.test.ts` (6/6) — a banned-pattern present in
the PLAINTEXT but absent from the ciphertext is dropped by EN-4 ONLY because decrypt ran first
(teeth: decrypt-off ⇒ EN-4 sees ciphertext, misses the rule, the op wrongly lands); an
undecryptable op (read-cut/defer) drops at the gate before EN-4/EN-2; the full chain
(decrypt → EN-4 ban) verified. Full `lib/sync/hyperbee` backbone GREEN with the gate wired:
136/137 files, 1081 passed | 1 expected-fail | 2 skipped. The real gate's crypto (round-trip /
defer=removed-member-cut / drop=wrong-key/tampered-AAD) is covered by hive-epoch-op-gate.test.ts (7/7).

## Honest residuals / not-yet

- **Live witness:** suite + structural GREEN; a live .deb witness (owner sets a policy → a
  member peer drops a banned/over-cap/taken-down op) is the remaining release-grade proof. It
  now rides the A-003 hive-home seam that just hit first green LIVE witness (policy federates
  owner→member on the real binary), so the path is unblocked.
- **EN-1 GUI snapshot surface** — the owner-facing "member X at N/cap" read off
  `limiter.snapshot()` is a fast-follow (the EN-1 panel exists; the live counter is additive).

## Done-gate (brief EN-4)

✅ The owner-enforcement layer is consolidated into one boot.ts merge seam; an owner policy is
read once per changed-pass and enforced (ban/allowlist/takedown/content via EN-4, rate via the
nested EN-2 wrapper) at op-admission on every honest peer, with byte-for-byte passthrough when
no policy is set, proven by the composed-seam + real-merge teeth and a zero-regression full
backbone (1076 tests). REMAINING for full release: the live .deb enforcement witness.
