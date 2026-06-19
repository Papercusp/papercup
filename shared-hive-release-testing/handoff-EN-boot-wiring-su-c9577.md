# Handoff — owner-enforcement boot.ts wiring (READY-TO-APPLY patch + verification verdict)

**Author:** su-c9577 (continuing session 10ce449f → EN-2 task-7 verification).
**For:** su-68c96 (EN-2, holds the boot.ts wiring standby) + su-328af (owns findings-EN-4.md / EN-3).
**Plan:** `shared-hive-owner-enforcement-2026-06-19` (EN-1/EN-2/EN-4).
**Status:** ✅ modules verified GREEN + type-clean on current staging; ⛔ **NOT applied**
(boot.ts was held by su-53f39/su-c2a63 for A-003 — now FIRST-GREEN per ee7e9, so the file
is about to free). This doc is the exact diff so the wiring lands instantly + safely.

> I did **not** edit boot.ts (contended) or findings-EN-4.md (su-328af owns). This is a
> dedicated, uniquely-named handoff artifact.

---

## 1. Verification verdict (the EN-2 task-7 ask: "full typecheck + test green")

Run on the current staging tree (post A-003/J/I/EN-3 churn), `packages/operator-core`:

- **Tests — 62/62 GREEN** (`npx vitest run` on the 5 enforcement files):
  - `rate-limiter.test.ts` 21 · `rate-limit-admission.test.ts` 14 · `rate-limit-enforcement.test.ts` 7
    (= EN-2's 42) · `policy-admission.test.ts` 18 · `policy-admission.apply.test.ts` 2 (= EN-4's 20).
- **Typecheck — ZERO errors** in `rate-limiter.ts`, `rate-limit-admission.ts`,
  `rate-limit-enforcement.ts`, `policy-admission.ts`, **and `boot.ts`** (`tsc --noEmit`).
  The only `lib/sync/hyperbee/**` tsc errors are pre-existing ambient noise in `__tests__/`
  helpers (`TableProjection<T>` variance, `.mock` typings, a fake handle missing `rekey`) —
  unrelated to enforcement, present before this work.

**Conclusion:** EN-1 (reader, landed), EN-2 (rate mechanism), EN-4 (policy seam) are all
built, tested, and type-clean. **The one remaining gap is live wiring:** `boot.ts`
`mergeOpts.applyImpl = scopedApply` (the raw PG projection apply) — `makePolicyEnforcedApply`
+ `makeRateLimitedApply` are imported by **nothing but tests**. So today the owner-enforcement
layer is inert in the running binary (a "green-rig / red-binary" gap). The patch below closes it.

---

## 2. The wiring contract (already specified by EN-2 findings; confirmed against source)

Composed stack, OUTER→INNER: **policy (ban/allowlist/content/takedown) → rate → scopedApply (PG)**.
- `MemberRateLimiter` is created **once per booted harness** (its per-(author,class,window) counts
  accumulate over the op STREAM — must persist across passes).
- Owner policy is read **once per merge pass** (`getHivePolicy`), NOT per op (a pass applies up to
  `maxOpsPerPass` ops; an async PG read per op is a non-starter).
- `null` policy ⇒ permissive ⇒ pure passthrough (zero behavior change for an un-policed hive).
- Both wrappers skip local (own-log) ops; rate gate fail-closes on an unattributable author when a
  cap is in force.

All signatures line up exactly (`(op: OpEnvelope) => Promise<boolean>`), and boot.ts already has
every ingredient in scope: `ownLog.keyHex`, `admittedIdentities`, `scopedApply` (rekey-rebuilt),
`hiveHomeProjectionSlug`, `opts.workspaceId`, `opts.harnessSlug`.

Confirmed source facts:
- `getHivePolicy(workspaceId, hiveHomeSlug): Promise<ResolvedHivePolicy|null>` — `lib/hive-policy-store.ts`.
  `.policy: HivePolicy`, `.policy.rate?: HivePolicyRate` (= EN-2 `RateCaps`).
- `RateDropInfo = { authorId: number|null; cls: RateClass|'unattributable'; cap: number|null; ... }`.
- `PolicyEnforcedDropInfo = { reason: PolicyDropReason; author: number|null; ... }`.
- `AuthorIdentity = { githubUserId: number; githubUsername: string }`.
- `admittedIdentities` value = `{ devicePubkey, githubLogin, githubUserId, attestationGistId }`
  (note: `githubLogin`, not `githubUsername` → map it in the `resolveAuthor` closure).
- Boot-history kinds `'peer_rate_limited'` + `'peer_rejected'` both exist (`boot-history.ts`).
  `recordBootEvent` only buffers (never throws), so onDrop needs no try/catch.

---

## 3. READY-TO-APPLY patch (`packages/operator-core/lib/sync/hyperbee/boot.ts`)

### (a) Imports — add near the other `./`-relative hyperbee imports

```ts
import { MemberRateLimiter } from './rate-limiter';
import { makeRateLimitedApply } from './rate-limit-admission';
import { makePolicyEnforcedApply } from './policy-admission';
import { getHivePolicy } from '../../hive-policy-store';
```

### (b) One limiter per booted harness — add right after the `let scopedApply = ...` init (~line 603) / the `admittedIdentities` decl (it just needs to be in the boot fn scope)

```ts
// EN-2 owner-enforcement: ONE rate-limiter per booted harness. Its per-(author,
// class, window) counts accumulate over the op STREAM, so it MUST persist across
// merge passes (created here, never per pass). Pure + Date.now-free (windows derive
// from each op's own ts) → deterministic + safe in the sidecar/worker paths.
const rateLimiter = new MemberRateLimiter();
```

### (c) Per-pass policy read + composed apply — inside the merge pass, immediately BEFORE `const mergeOpts = {` (it is past the `if (!changed) return 0` early-return, so idle passes pay nothing), then point `applyImpl` at it

```ts
// ── Owner-enforcement seam (EN-1 reader → EN-4 policy gate → EN-2 rate gate). ──
// Read the owner-signed policy ONCE per merge pass (NOT per op: a pass applies up to
// maxOpsPerPass ops; an async PG read per op is a non-starter — EN-2 contract). Runs
// only on passes with new ops (past the `!changed` early-return), so an idle harness
// does zero extra PG work. null ⇒ permissive ⇒ pure passthrough (zero behavior change
// for an un-policed hive). Scope = the same hive-home slug hive_settings/hive_policy
// demux on (rekey-updated `hiveHomeProjectionSlug`).
const passPolicy = await getHivePolicy(
  opts.workspaceId,
  hiveHomeProjectionSlug ?? opts.harnessSlug,
);
// Compose OUTER→INNER: policy (ban/allowlist/content/takedown) → rate → scopedApply (PG).
// Rebuilt each pass so it always wraps the CURRENT scopedApply (rekey rebinds it) and
// the CURRENT passPolicy snapshot. Local + (no-policy) ops pass straight through.
const enforcedApply = makePolicyEnforcedApply({
  currentPolicy: () => passPolicy?.policy ?? null,
  resolveAuthor: (srcKey) => {
    const id = admittedIdentities.get(srcKey);
    return id ? { githubUserId: id.githubUserId, githubUsername: id.githubLogin } : null;
  },
  ownLogKeyHex: ownLog.keyHex,
  // isContentTakenDown: <- wire EN-3's hive-moderation predicate here once it lands.
  apply: makeRateLimitedApply({
    limiter: rateLimiter,
    ownLogKeyHex: ownLog.keyHex,
    resolveAuthorId: (srcKey) => admittedIdentities.get(srcKey)?.githubUserId ?? null,
    currentCaps: () => passPolicy?.policy.rate ?? null,
    apply: scopedApply,
    onDrop: (info) =>
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'peer_rate_limited',
        `${info.cls} author=${info.authorId ?? '?'} cap=${info.cap ?? '?'}`,
      ),
  }),
  onDrop: (info) =>
    recordBootEvent(
      opts.workspaceId,
      opts.harnessSlug,
      'peer_rejected',
      `policy:${info.reason} author=${info.author ?? '?'}`,
    ),
});
```

```diff
       const mergeOpts = {
         // D-021: route through THIS harness's scoped projection apply, not the
         // global registry (which the last-booted harness would own).
-        applyImpl: scopedApply,
+        // Owner-enforcement: policy → rate → scopedApply (see seam above). Inert
+        // (== scopedApply) when no owner policy is set.
+        applyImpl: enforcedApply,
```

> `applyOverride` (the rigs) path: the rigs set `opts.applyOverride` and `scopedApply`
> is never rebuilt for them. The enforcement seam composes over whatever the current
> `scopedApply`/override is, so the rigs keep their exact apply — verify the rig tests
> stay green (they should: no policy row ⇒ passthrough). If a rig should bypass
> enforcement entirely, gate the seam on `!opts.applyOverride` (mirrors the rekey guard).

---

## 4. Open decisions for the applier (su-68c96) — small, all owner's-call

1. **Flag-gate?** Enforcement is inherently default-off (null policy ⇒ passthrough), so a
   flag isn't strictly required. The fleet's convention gates new substrate behavior behind
   a flag (P-007 etc.). Recommend: land UN-gated (inert without an owner policy) **or** behind
   a one-line kill-switch flag for first-land safety. Either is a 1-line change.
2. **Per-pass PG read** is placed after the `!changed` early-return → idle harnesses pay
   nothing; an active policed hive pays one indexed PK `SELECT` per ~1s poll. Negligible, but
   confirm it matches intent (could cache with a short TTL if a profile ever flags it).
3. **EN-3 takedown** — `isContentTakenDown` left unset until `hive-moderation.ts` (su-328af's
   EN-3) lands; wire it then. P-CONTENT (`parseContentPolicy`/`contentAdmits`) already flows
   through `decidePolicyOp`, so it activates automatically when an owner sets `policy.content`.

## 5. After applying — re-verify
```
cd packages/operator-core
npx vitest run lib/sync/hyperbee            # full hyperbee suite green (esp. the rig/integration files)
npx tsc --noEmit 2>&1 | grep 'sync/hyperbee/boot.ts'   # expect no new boot.ts errors
```
Then add a `boot.ts`-level enforcement integration test (or extend `rate-limit-enforcement.test.ts`)
that drives a REAL booted handle with an owner policy set and asserts an over-cap / banned op is
dropped on merge — that converts this from "modules green" to "binary green" (the gap the verdict names).
