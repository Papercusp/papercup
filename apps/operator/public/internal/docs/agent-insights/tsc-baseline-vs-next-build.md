# Bare `tsc --noEmit` reports hundreds of errors that next build doesn't
URL: /internal/docs/agent-insights/tsc-baseline-vs-next-build

A direct invocation of `tsc --noEmit` against apps/operator reports ~860 pre-existing errors that `next build` handles correctly. Don't chase them; treat the count as a baseline and verify only that touched files are clean.

## What

Running `tsc --noEmit` directly against `apps/operator/` reports
**\~860 errors** on a clean main checkout. `next build` (which is what
the project actually typechecks with) reports zero. The delta is real
and persistent — `tsc` is not finding regressions, it's missing
context.

Two reasons:

1. **Generated route types.** Next.js generates `.next-prod/types/*`
   files during a build that the type-checker needs to see;
   without them, every Next page/route handler that uses typed
   `params` / `searchParams` flags TS2307. Bare `tsc` doesn't run the
   generator.
2. **Module-resolution scope.** Bare `tsc` walks references that
   `next build` skips (e.g. `@bytecodealliance/jco` inside
   `packages/plugin-loader`), and resolves them differently.

The error count fluctuates by a few as other agents land changes —
don't treat ±5 as a regression in either direction.

## How to verify your work

Always run `tsc` from `apps/operator/`, but **scope your check to the
files you touched**, not the total:

```bash
cd /home/marsh-office/papercupai-workspace/papercup/apps/operator && \
  ../../node_modules/.bin/tsc --noEmit --ignoreDeprecations 6.0 2>&1 | \
  tee /tmp/tsc.log | grep -cE 'error TS'   # capture baseline

# Then per-file:
for f in path/to/your/file1.tsx path/to/your/file2.ts; do
  n=$(grep -cE "^${f//\//\\/}\(" /tmp/tsc.log)
  printf "  %4d  %s\n" "$n" "$f"
done
```

A clean PR has **zero errors in touched files**, regardless of
project total. The flags matter: `--ignoreDeprecations 6.0` is
required because the repo's `tsconfig.json` uses options newer `tsc`
versions deprecated.

## If you must chase the baseline

Don't. Run `cd papercusp-desktop && npm run dev` (or `next build`)
and trust its output. Bare `tsc` is a fast-but-noisy file-level
check, not a project-correctness signal.

## Why this was costly

This session, I twice spent meaningful time investigating "new"
errors in `lib/agent-tools/plans/*` that turned out to be the pre-
existing baseline. Stashing the diff and re-running `tsc` confirmed
they were already there. The diagnosis loop is fast (1–2 minutes
with `git stash push -u <files>` + re-run) but it shouldn't be
necessary — knowing the baseline exists short-circuits the chase.
