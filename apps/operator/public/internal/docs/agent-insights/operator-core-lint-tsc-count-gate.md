# operator-core `lint:tsc` is a COUNT gate — vitest-green != tsc-clean
URL: /internal/docs/agent-insights/operator-core-lint-tsc-count-gate

npm run lint:tsc gates packages/operator-core on a TOTAL tsc-error count vs .tsc-baseline.json, hard-fails TS1xxx syntax errors, and hard-blocks green-checkpoint when it rises. vitest (esbuild) does NOT typecheck, so a vitest-green test edit can add tsc errors that tip the count over baseline. Run lint:tsc after operator-core edits — not just test:affected.

## What

`npm run lint:tsc` (`scripts/lint-tsc.mjs`) runs
`tsc -p packages/operator-core/tsconfig.json --noEmit` and compares the
**total parsed error count** against
`packages/operator-core/.tsc-baseline.json` (a single number,
`operatorCoreErrorCount`). Don't trust any literal value cited here as current —
run `npm run lint:tsc` for the live count vs baseline. As of this writing
(2026-07-03) the baseline is **PINNED at `224`** (deliberately the *higher* of a
known `223`/`224` flap — see below), ratcheted down repeatedly since the `262`
figure this doc originally cited — but the baseline file's own change history
shows the true count **flapping between `223` and `224` within the same day**
under unrelated concurrent-edit noise (a pre-existing deep-instantiation/test-
fixture ripple, e.g. `inference-gateway/observability.test.ts`'s `GatewayStats`),
not a real regression each time. Pinning the higher value makes the gate pass at
both 223 and 224 instead of false-redding the fleet every time it shuffles back
up. If you see a lone ±1 shift with no attributable new error, that's the known
flap — verify across a few clean runs on a quiet tree before treating it as
either a real improvement or a real regression, and **don't** bare-run-ratchet a
transient dip (that happened twice on 2026-07-03 and had to be manually
re-restored to 224 — see the baseline file's own `note` field). The gate:

* **count > baseline ⇒ HARD FAIL** — and it runs in green-checkpoint, so a
  single net-new error **blocks the whole fleet's deploy**, not just yours.
* **count \< baseline ⇒ ratchets down, but ONLY on an explicit `npm run lint:tsc -- --update`** (audit P-073 / EI-104, fixed 2026-07-03 — this reverses the
  prior "auto-ratchet on every bare run" behavior). A **bare** run (CI, or a
  peer's plain `npm run lint:tsc`) never rewrites the baseline file — it only
  checks and hard-fails above baseline; auto-ratcheting on every bare run
  turned out to lock in transient dips in this shared, concurrently-edited tree
  and then false-red the gate for the whole fleet the next time the count
  shuffled back up. `--update` still only ever *lowers* the baseline (or
  no-ops at parity) — raising it remains a deliberate human JSON edit, never
  automatic. This `--update`-only policy now lives in the **pure `decide()`**
  function (a bare run below baseline returns `ok-below` and `main()` never
  writes; only `--update` yields `ok-ratchet`) and is locked by
  `lint-tsc.test.ts` — so a `main()` refactor can't silently reintroduce the
  auto-ratchet flap. (EI-104 shipped in `main()` first but left the invariant in
  untested imperative code while `decide()` + its test still encoded the old
  auto-ratchet; WI-1822 folded the policy into `decide()` and added the guard.)
* **any TS1xxx parse error ⇒ HARD FAIL** — syntax-broken files fail regardless
  of the total count because `tsc` under-reports the errors behind a parse
  failure.
* It is **position-independent**: only the count matters. Adding lines above a
  pre-existing baselined error doesn't "create" it, but any *net-new* error
  (yours, or one a refactor newly exposes) tips the total over.

This is a different mechanism from the apps/operator "scope to touched files"
baseline (\[\[tsc-baseline-vs-next-build]]) — there the move is per-file; here
it's a hard count gate on one package.

## The trap: vitest is green, lint:tsc is red

`npm run test:affected` runs **vitest**, which transforms with **esbuild** and
does **NOT typecheck**. So a test file can be fully vitest-green while carrying
tsc errors that only `lint:tsc` sees. You commit, vitest passes, and a peer (or
green-checkpoint) finds the count over baseline minutes later — now everyone's
deploy is blocked.

The recurring test-specific cause: a `vi.fn(async () => …)` mock infers a
**zero-parameter** call signature, so `mock.calls[0]` is the empty tuple `[]`.
`mock.calls[0][0]` then trips **TS2493** ("Tuple type '\[]' has no element at
index '0'"), and the `as {…}` cast on the resulting `undefined` trips
**TS2352**. Give the mock a typed parameter (`vi.fn(async (spec: CardSpec) =>
…)`), or read the first arg through a typed accessor.

Concrete (B-10, 2026-06-13): a new describe block in `ask_choice.test.ts` was
15/15 vitest-green, but six existing `vi.fn(async () => …)` mocks' `mock.calls [0][0]` casts tipped operator-core 455 → 466 and blocked green-checkpoint. Fix
was a one-helper `firstSpec(askUser)` typed accessor → 0 errors in the file →
count back to baseline.

## How to verify

After **any** edit under `packages/operator-core` (source *or* test):

```bash
npm run lint:tsc        # the authoritative gate — count vs baseline
```

* If it prints `> baseline`, your touched files added tsc errors — fix them.
  **Do not** raise the baseline to absorb your own new errors (the script only
  ratchets *down*; raising is a reviewed human act with a justification).
* If it reports TS1xxx syntax-broken files, fix those files first. The count is
  intentionally ignored for this verdict.
* To see *which* of your files contribute, grep the tsc output:
  `npx tsc -p packages/operator-core/tsconfig.json --noEmit 2>&1 | grep '<your-file>'`
  — a clean file is **zero** lines there.
* `test:affected` (vitest) is necessary but **not sufficient** — it proves
  behavior, not types. Run both.
