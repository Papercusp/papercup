# Seed-bundle runbook — cut/restore model, the flag, failure modes + the cold-join canary
URL: /internal/docs/agent-insights/hive-seed-bundle-runbook

The AS-BUILT operational runbook for the installer-shipped seed-bundle: how a seed is cut and restored, the restore-before-join state machine, the HIVE_SEED_BUNDLE kill-switch, the encrypted-git deferral, every failure mode and its cold-path fallback, and the cold-join canary + E2E acceptance that keep the cold path proven.

> **Status: AS-BUILT (plan `hive-seed-bundle-2026-07-04`, P-001…P-011 landed).** This
> is the operational companion to the
> [design memo](/internal/docs/agent-insights/hive-seed-bundle-design) (the *why* +
> the interface/manifest/state-machine spec). Read the memo first for the model; read
> this to **cut a seed, debug a restore, or reason about a failure mode.**

## One-paragraph model

The installer ships a **seed**: a checkpoint of the two replicated stores that back
the dogfood hive — a set of **git bundles** (superproject + 37 submodules) and a
**corestore snapshot** (every author core at its cut length, carrying the federated
hive state: plans, work-items, features, issues, coordination, settings/members).
On first boot the operator **restores the seed BEFORE the (unmodified) shared-hive
join runs**, so the join transfers only the **delta** on top of the checkpoint
instead of the whole history. The seed pre-positions **bytes**; the join still does
all the **trust** (admission, epoch keys, delta replication) and every store
**re-verifies natively** (git object hashes; corestore per-block merkle + author
signatures). Nothing about the join changes — a build with no bundled seed, or with
the feature flag off, takes the identical **cold** path.

## The pieces (as built)

| Concern            | Module                                                        | Notes                                                                                                                                        |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic core       | `libs/generic/seed-bundle`                                    | manifest types + validation, pack/unpack, hashing, the `SeedProvider` registry — behind a `configure*()` seam (generic-first, `BORROWABLE`). |
| Corestore provider | `sync/hyperbee/seed-provider-corestore.ts`                    | cut = copy each author core at its current length; restore = drop-in before boot. Blocks stay **epoch-ciphertext**.                          |
| Git provider       | `sync/hyperbee/seed-provider-git.ts`                          | cut = a `git bundle` set; restore = clone-from-bundle, re-point origin to GitHub, wire submodules; a later `fetch` = delta only.             |
| Cut CLI            | `apps/operator/lib/release/cut-seed-cli.ts`                   | `pickGitEncryption()` selects the git-seal key (below). Run at release-build time **on the owner box**.                                      |
| Restore entry      | `sync/hyperbee/restore-hive-seed.ts`                          | `resolveSeedDir()` (escape hatch / override / autodetect) + `onlyKinds` scoped restore.                                                      |
| Deferred git       | `sync/hyperbee/deferred-git-restore.ts`                       | resolves the epoch key **post-admission** and re-restores the encrypted git store.                                                           |
| Boot wiring        | `harness/bootstrap-papercusp-hive.ts`                         | `seedBundleEnabled()` gate → `defaultRestoreHiveSeed` (pre-join) → join → `defaultRestoreDeferredGitSeed` (post-admission).                  |
| Cold-path guard    | `sync/hyperbee/cold-join-canary.ts` + `cold-join-executor.ts` | forces a periodic REAL cold join so the seeded path never lets the cold path bit-rot.                                                        |
| E2E acceptance     | `sync/hyperbee/seed-e2e-measurement.ts`                       | pure cold-vs-seeded verdict (usable / join-exercised / delta-only / faster).                                                                 |

## Restore-before-join state machine

1. **`seedBundleEnabled()`** — the `FLAGS.HIVE_SEED_BUNDLE` master gate (below). OFF ⇒
   skip everything, pure cold join.
2. **`resolveSeedDir()`** — resolves the bundled seed dir: `PAPERCUSP_NO_SEED` escape
   hatch → `PAPERCUSP_SEED_DIR` override → Tauri bundled-resource autodetect
   (`<resourceRoot>/seed`, accepted only if `manifest.json` exists). No seed ⇒ `null`
   ⇒ cold join. (The Tauri sidecar sets `PAPERCUSP_SEED_DIR` to `<sidecar_dir>/seed`.)
3. **Corestore restore (pre-join).** The corestore snapshot restores into the hive
   store dir now — its blocks are epoch-ciphertext, so no key is needed to place the
   bytes; they become readable once the join delivers the epoch keys.
4. **Git restore split by encryption.** A **plaintext** git seed restores now. An
   **encrypted-at-rest** git seed (the shipping default for the PRIVATE repo, D-004)
   **DEFERS** — its key is the hive epoch key, which a fresh member only holds
   *after* admission.
5. **The unmodified join runs** — invite subscribe → owner announce → admission →
   epoch keys → swarm delta replication. Only the delta transfers.
6. **`triggerDeferredGitRestore` (post-admission).** Once join reaches `joined` and a
   git store was deferred, `buildMemberEpochKeyProvider` unwraps the epoch key at
   `cutAtEpoch` (a fresh member holds it — Q-4 / `grantEpochKeysToMembers [0..current]`)
   and re-restores just the git store. If it can't (no device identity yet), the
   store stays deferred and the join's normal cold clone back-fills the repo.

## Cutting a seed — the key selection (`pickGitEncryption`)

The encrypted git seed must be decryptable by a **freshly-admitted member**, so the
seal key is delivered by the **existing epoch-key path** — not a bespoke channel:

* **`--workspace-id …` or explicit `--epoch …`** ⇒ `keyRef = { via: 'epoch', hiveId, epoch: cutAtEpoch }`,
  sealed with the **owner** epoch key `deriveEpochKey(hive, cutAtEpoch)`. **This is the
  shipping path.** A joiner unwraps the same epoch key post-admission (step 6).
* **`--key-hex …`** ⇒ `keyRef = { via: 'seed-key-op', hiveId }` with that raw 32-byte
  key. **Fixture / manual only** — there is no joiner delivery path for a seed-key-op,
  so a member can't unwrap it; it degrades to a cold clone. Use for tests, never a ship.
* **neither** ⇒ **PLAINTEXT** git seed (a warning is logged). Guarded so a bare
  `cutAtEpoch=0` **never** silently mints a divergent key.

> ⚠️ **The cut MUST run on the owner box with the live epoch keychain.**
> `deriveEpochKey` is **get-or-CREATE**: on a keychain miss it MINTS a fresh random
> key. Cutting in the wrong keychain context seals the seed under a key **no member
> can unwrap**. Verify `accounts:status` / the epoch keychain before a release cut.

### Corestore completeness refresh

With `--workspace-id`, `cut-seed-cli` now refreshes the corestore source **before**
snapshotting it: it force-runs `backfillLocalState(..., { force:true,
maxOpsPerAuthor:0 })`, then drains the queued rows with `drainOutboxOnce()` until
the outbox is empty. This is release-only repair for long-lived dogfood hives whose
runtime `backfill_done` marker predates later local rows: without it, the seed can
ship a large corestore that still materializes only a small subset of work-items on
an offline install. The escape hatch is `--skip-corestore-refresh`, for diagnostic
cuts only; release builds should leave the refresh on.

## The kill-switch — `FLAGS.HIVE_SEED_BUNDLE`

* Key `papercusp-hive-seed-bundle`, **DEFAULT ON** (not in `KNOWN_DARK_FLAGS` —
  finished work never ships dark). Flip at `/admin/features`.
* Read once at each restore call site via `seedBundleEnabled()` (fail-**open** to ON:
  a flag-read hiccup must not silently force cold, and the restore is
  safe-by-construction anyway).
* **OFF ⇒ pure cold path, byte-identical to a no-seed build.** The runtime escape
  hatch if a seed restore ever misbehaves in the field — no redeploy needed.
* **Inert** on any build with no bundled seed (`resolveSeedDir → null`), flag or not.

## Failure modes → every one degrades to the cold path

The seed is a **pure optimization**; a fresh install is **never bricked** by a bad
seed. Each failure resolves to the unchanged cold join:

| Failure                            | Detection                            | Fallback                                           |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------- |
| No seed bundled                    | `resolveSeedDir → null`              | cold join (today's behavior)                       |
| Flag OFF                           | `seedBundleEnabled() === false`      | cold join                                          |
| `--no-seed` set                    | `resolveSeedDir().disabled`          | cold join (operator opt-out)                       |
| Corrupt / hash-mismatch bundle     | provider `restore` throws → caught   | cold join, warned                                  |
| Encrypted git, no epoch key yet    | `buildMemberEpochKeyProvider → null` | git stays deferred; join's cold clone back-fills   |
| Git sealed `via: 'seed-key-op'`    | no joiner delivery path              | deferral never resolves → cold clone               |
| Wrong-keychain cut (divergent key) | member `epoch_decrypt_fail`          | deferral fails → cold clone (data-safe, just slow) |

## Keeping the cold path honest — the cold-join canary (D-007)

Because a seeded install stops exercising the full cold join on every boot, the cold
path can silently bit-rot. The **cold-join canary** (`cold-join-canary.ts` +
`cold-join-executor.ts`, wired fail-soft into `routinesTick`) periodically forces a
**REAL cold join** (`PAPERCUSP_NO_SEED`) and probes for a **usable hive** (plans +
work-items visible, repo usable), recording pass/fail to the shared
`hive_watchdog_fires` ledger (debounced) and alerting on a failure.

* **DEFAULT DISABLED** (`intervalSec <= 0`) — a cold join is heavy. A canary/release
  env opts in via `PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC` (e.g. `86400` = daily).
* The heavy cold-join spawn genuinely needs a **packaged / rig** environment, so it
  is an injected seam: `setColdJoinSpawnObserve(fn)` registers a rig's real
  forced-cold-join+observe; the default throws `COLD_JOIN_RIG_REQUIRED` (an honest
  alert, **never a fake pass**). The pure decision (`evaluateColdJoinProbe`) is fully
  unit-tested headless.

## E2E acceptance (build-dependent)

`seed-e2e-measurement.ts` turns the P-010 acceptance into a structured verdict:
`evaluateSeedE2E(cold, seeded)` asserts the seeded install (a) reaches a **usable
hive**, (b) still **exercised the real join** (the seed didn't bypass federation), (c)
transferred **delta-only** (≤ 25 % of cold's bytes by default), and (d) booted
**faster**. The pure verdict is unit-tested; the two-install **measurement** seam
(`PackagedInstallMeasure`) needs a fresh **packaged build** to run and is
honestly-gated (`PACKAGED_MEASURE_BUILD_REQUIRED`) — it executes only from a rig with
a build (deploys are frozen while green-checkpoint is stalled on an internal
reference harness; no numbers are fabricated in-process).

## Quick reference — env + flags

| Knob                                          | Effect                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| `FLAGS.HIVE_SEED_BUNDLE` (default ON)         | master kill-switch; OFF ⇒ cold path                  |
| `PAPERCUSP_NO_SEED=1`                         | per-launch escape hatch ⇒ cold path                  |
| `PAPERCUSP_SEED_DIR=<dir>`                    | override the seed dir (must contain `manifest.json`) |
| `PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC=<n>` | opt into the cold-join canary (default 0 = off)      |
