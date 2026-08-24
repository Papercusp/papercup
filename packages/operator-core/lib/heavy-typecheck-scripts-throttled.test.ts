import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every typecheck npm script must be admitted to a pc-heavy slot EXACTLY ONCE.
 *
 * ── WHERE ADMISSION LIVES, AND WHY IT MOVED (EI-21311288080670514) ──────────
 *
 * This guard originally read "every typecheck script must carry a
 * `bash scripts/pc-heavy.sh` prefix", because typechecks were then the one heavy
 * command running bare. Admission has since moved INWARD, and the prefix is now
 * WRONG on the runner form:
 *
 *   - runner form (`node …/lint-tsc*.mjs`) — the runner reserves the slot itself,
 *     around the COMPILE ONLY (`scripts/lib/tsc-baseline-gate.mjs`, the
 *     `existsSync(pcHeavyPath)` branch). An outer prefix here is a SECOND, nested
 *     reservation: the outer holder waits on a nested child that is waiting for a
 *     slot, which deadlocks under the two-slot clamp. It also broke pc-heavy's
 *     coalescing, because `--files=a.ts` and `--files=b.ts` present different argv
 *     so the `(cwd, argv, tree-token)` key never matched and N identical full
 *     compiles ran where one would do. Outer wrapper must be ABSENT.
 *   - bare `tsc --noEmit` — reserves nothing on its own. Wrapper still REQUIRED.
 *
 * So the invariant is two-sided: under-admission starves the box (the original
 * finding below), over-admission deadlocks it. Checking only one side is what let
 * this guard contradict `lint-tsc.test.ts`'s "must not nest pc-heavy" assertion
 * and pin the release gate red — each "fix" simply flipped which one failed.
 *
 * `admissionSite()` decides which side applies, and `runnerReachesSharedGate()`
 * verifies the runner really does delegate, so 'internal' stays a fact about the
 * file rather than a naming convention.
 *
 * ── WHY THIS GUARD EXISTS (EI-19480850505352533) ────────────────────────────
 *
 * `scripts/pc-heavy.sh` is a host-wide counting semaphore whose own header says
 * it exists so "N agents' vitest / tsc / test:affected runs stagger instead of
 * all landing on the shared 128-core box at once", and whose coalescing note
 * names this exact command: "many agents each running `npm run lint:tsc` to
 * confirm the same gate ... which is exactly how '~19 typecheck jobs queued'
 * became a fleet-wide chokepoint".
 *
 * It was nonetheless wired into the TEST scripts only. `lint:tsc` — the command
 * CLAUDE.md instructs every agent to run after every edit — invoked
 * `scripts/lint-tsc.mjs` directly, so typechecks were the one heavy command
 * with no admission control at all. Measured on this box 2026-08-12: ~14
 * concurrent `lint-tsc.mjs` processes, load1 213-220 on 128 cores, and a
 * two-sample cgroup delta showing a single typecheck starved to 0.10 cores. It
 * produced no output for 19 minutes and then completed clean once load fell.
 *
 * The failure SCALES WITH COMPLIANCE: the more agents follow the documented
 * post-edit discipline, the worse it gets. And a starved typecheck is
 * indistinguishable from a hung one — an empty log, no error — which invites
 * both "assume it passed" and "kill it and relaunch", the second of which adds
 * another unthrottled process.
 *
 * ── WHY IT DERIVES BOTH POPULATIONS (WI-38277) ──────────────────────────────
 *
 * The first version of this guard derived the SCRIPT population from the
 * scripts themselves — "any script that shells out to a `lint-tsc*.mjs` runner
 * is in scope", so a seventh script could not slip past a pinned list of six —
 * but then pinned the MANIFEST population to exactly two files (root and
 * packages/operator-core). That is the same defect one level up, and it was not
 * hypothetical: `apps/operator-vite`'s `typecheck` ran
 * `node ../../scripts/lint-tsc-operator-vite.mjs` unthrottled, a string the
 * guard's own regex matches. It was invisible for one reason only — nobody
 * scans that manifest. Four more (`apps/operator-public`,
 * `apps/papercusp-publish`, `packages/omp-plugin`,
 * `libs/papercusp/packages/orchestrator`) were unthrottled beside it.
 *
 * So BOTH populations are now derived:
 *  - MANIFESTS come from the root package.json `workspaces` globs, so a new
 *    workspace is scanned the day it is added.
 *  - SCRIPTS are anything that runs a `lint-tsc*.mjs` runner OR invokes `tsc`
 *    with `--noEmit`. The second form is the majority shape in the workspaces
 *    the old guard could not see, and it matched nothing in its detector.
 *
 * ── WHAT IS OUT OF SCOPE, AND WHY ───────────────────────────────────────────
 *
 *  - STANDALONE-BUILDABLE trees: git submodules (`.gitmodules`) and the
 *    domain-free `libs/generic/*` borrowables. Both are meant to build when
 *    checked out on their own, where `scripts/pc-heavy.sh` does not exist, so
 *    wrapping them would trade a throttling gap for a broken standalone build.
 *    ONE exception, and it costs nothing: a script that ALREADY reaches up into
 *    the superproject's `scripts/` directory has that coupling today, so it is
 *    held to the rule (this is how `libs/papercusp/packages/orchestrator` is in
 *    scope). Note the fail direction: if `.gitmodules` ever became unreadable
 *    the exemption set would be EMPTY and this test would fail loudly on every
 *    submodule, never pass silently.
 *  - EMITTING builds (`tsc -p tsconfig.build.json`, no `--noEmit`). They are
 *    heavy too, but they are not the post-edit command every agent runs on
 *    every change, which is the pile-up this guard exists to prevent.
 *  - Scripts that DELEGATE via `npm --workspace ... run typecheck` — they reach
 *    a wrapped script, and wrapping both would hold two slots for one job.
 *  - The release gate. green-checkpoint sets `PC_HEAVY_RELEASE_GATE=1`, which
 *    pc-heavy honours by exec'ing immediately (WI-6140), so the gate is exempt
 *    from ADMISSION at the wrapper, not by omission here.
 *  - Nested invocations. pc-heavy exports `PC_HEAVY_BYPASS=1` to its child, so a
 *    wrapped sweep spawning wrapped children cannot self-deadlock on slots.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A script that shells out to one of the tsc-baseline runners. */
const INVOKES_TSC_RUNNER = /lint-tsc[\w-]*\.mjs/;
/** A direct `tsc` invocation — the majority form outside the root manifest. */
const INVOKES_TSC_BINARY = /(?:^|[\s;&|(])tsc(?:\s|$)/;
/** Checking, not emitting: what makes a `tsc` call the post-edit command. */
const CHECKS_ONLY = /--noEmit\b/;
const ROUTES_THROUGH_PC_HEAVY = /pc-heavy\.sh/;
/** Already reaches out of its own tree into the superproject's scripts/ dir. */
const ESCAPES_INTO_SUPERPROJECT = /\.\.\/[\w./-]*scripts\//;

/**
 * Deliberate exemptions keyed `<workspace-dir>:<script-name>`, each with a
 * reason. EMPTY on purpose: there is no known typecheck entrypoint that should
 * bypass the semaphore. Adding an entry here is a decision to let one heavy
 * command run unadmitted — say why.
 */
const ALLOW: Record<string, string> = {};

const readJson = (file: string): { scripts?: Record<string, string>; workspaces?: string[] } =>
  JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string>; workspaces?: string[] };

const scriptsOf = (workspaceDir: string): Record<string, string> => {
  const file = path.join(REPO_ROOT, workspaceDir, 'package.json');
  if (!existsSync(file)) return {};
  return readJson(file).scripts ?? {};
};

/** Workspace dirs (repo-relative, '.' for the root), expanded from the globs. */
export const workspaceDirs = (): string[] => {
  const patterns = readJson(path.join(REPO_ROOT, 'package.json')).workspaces ?? [];
  const dirs: string[] = ['.'];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    let entries: string[] = [];
    try {
      entries = readdirSync(path.join(REPO_ROOT, base), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      entries = [];
    }
    for (const name of entries) dirs.push(`${base}/${name}`);
  }
  return dirs.filter((dir) => existsSync(path.join(REPO_ROOT, dir, 'package.json')));
};

/** Submodule paths, read from .gitmodules — see the fail-direction note above. */
export const submodulePaths = (): string[] => {
  const file = path.join(REPO_ROOT, '.gitmodules');
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) => m[1].trim());
};

/** A tree that must still build when checked out on its own. */
export const isStandaloneBuildable = (workspaceDir: string, submodules: string[]): boolean => {
  if (workspaceDir.startsWith('libs/generic/')) return true;
  return submodules.some((p) => workspaceDir === p || workspaceDir.startsWith(`${p}/`));
};

/** Is this command the post-edit typecheck this guard governs? */
export const isHeavyTypecheck = (cmd: string): boolean =>
  INVOKES_TSC_RUNNER.test(cmd) || (INVOKES_TSC_BINARY.test(cmd) && CHECKS_ONLY.test(cmd));

/**
 * WHERE a command's slot reservation lives.
 *
 * 'internal' — it shells out to a `lint-tsc*.mjs` runner, and the runner reserves
 *   the slot itself, around the COMPILE ONLY
 *   (`scripts/lib/tsc-baseline-gate.mjs`, the `existsSync(pcHeavyPath)` branch).
 * 'external' — it calls `tsc` directly, reserves nothing, and therefore still
 *   needs the `pc-heavy.sh` prefix in the npm script.
 *
 * The two forms are disjoint in practice: `INVOKES_TSC_BINARY` needs `tsc`
 * delimited by whitespace, and in `lint-tsc-operator.mjs` it is bounded by `-`.
 */
export type AdmissionSite = 'internal' | 'external';
export const admissionSite = (cmd: string): AdmissionSite =>
  INVOKES_TSC_RUNNER.test(cmd) ? 'internal' : 'external';

/** The shared module that owns the compile-scoped reservation. */
const SHARED_GATE = 'tsc-baseline-gate';

/** The runner path a command shells out to, as written in the script. */
export const runnerPath = (cmd: string): string | null =>
  /(\S*lint-tsc[\w-]*\.mjs)/.exec(cmd)?.[1] ?? null;

/**
 * Does this runner ACTUALLY reach the shared gate?
 *
 * Without this, 'internal' would be a naming convention rather than a fact, and a
 * new `scripts/lint-tsc-whatever.mjs` that never imports the shared gate would be
 * waved through as "admitted internally" while running wholly unadmitted — the
 * precise hole that trusting the filename would open.
 */
export const runnerReachesSharedGate = (workspaceDir: string, cmd: string): boolean => {
  const rel = runnerPath(cmd);
  if (rel === null) return false;
  const resolved = path.resolve(REPO_ROOT, workspaceDir, rel);
  if (!existsSync(resolved)) return false;
  return readFileSync(resolved, 'utf8').includes(SHARED_GATE);
};

/** Is this workspace's command held to the rule? */
export const inScope = (workspaceDir: string, cmd: string, submodules: string[]): boolean =>
  !isStandaloneBuildable(workspaceDir, submodules) || ESCAPES_INTO_SUPERPROJECT.test(cmd);

/**
 * The invariant is ADMITTED EXACTLY ONCE — not "carries a wrapper".
 * Under-admission starves the box; over-admission deadlocks it.
 */
export const offenders = (): string[] => {
  const submodules = submodulePaths();
  const found: string[] = [];
  for (const dir of workspaceDirs()) {
    for (const [name, cmd] of Object.entries(scriptsOf(dir))) {
      if (!isHeavyTypecheck(cmd)) continue;
      if (!inScope(dir, cmd, submodules)) continue;
      if (`${dir}:${name}` in ALLOW) continue;
      const wrapped = ROUTES_THROUGH_PC_HEAVY.test(cmd);
      if (admissionSite(cmd) === 'internal') {
        if (wrapped) {
          found.push(`${dir} :: ${name} :: DOUBLE-ADMITTED (outer wrapper nests a second slot) :: ${cmd}`);
        } else if (!runnerReachesSharedGate(dir, cmd)) {
          found.push(`${dir} :: ${name} :: RUNNER NEVER REACHES ${SHARED_GATE} :: ${cmd}`);
        }
      } else if (!wrapped) {
        found.push(`${dir} :: ${name} :: UNADMITTED (bare tsc, no wrapper) :: ${cmd}`);
      }
    }
  }
  return found;
};

const governedScripts = (): string[] => {
  const submodules = submodulePaths();
  const found: string[] = [];
  for (const dir of workspaceDirs()) {
    for (const [name, cmd] of Object.entries(scriptsOf(dir))) {
      if (isHeavyTypecheck(cmd) && inScope(dir, cmd, submodules)) found.push(`${dir} :: ${name}`);
    }
  }
  return found;
};

describe('typecheck scripts are admission-controlled', () => {
  it('every in-scope typecheck script is admitted exactly once', () => {
    expect(offenders()).toEqual([]);
  });

  it('classifies the runner form as internally admitted, not as an offender', () => {
    // The root `typecheck` line, verbatim. Before EI-21311288080670514 this guard
    // demanded an outer wrapper here; the runner now reserves its own compile slot,
    // so demanding one again is what NESTS the deadlocking second reservation.
    const cmd = 'node scripts/lint-tsc.mjs';
    expect(isHeavyTypecheck(cmd)).toBe(true);
    expect(admissionSite(cmd)).toBe('internal');
    expect(ROUTES_THROUGH_PC_HEAVY.test(cmd)).toBe(false);
  });

  it('flags a runner that carries an outer wrapper — the nested-slot regression', () => {
    // The pre-EI-21311288080670514 line, verbatim. If anyone "restores" it,
    // this guard is what says no.
    const cmd = 'bash ../../scripts/pc-heavy.sh node ../../scripts/lint-tsc-operator.mjs';
    expect(isHeavyTypecheck(cmd)).toBe(true);
    expect(admissionSite(cmd)).toBe('internal');
    expect(ROUTES_THROUGH_PC_HEAVY.test(cmd)).toBe(true);
  });

  it('treats internal admission as a fact about the runner, not about its name', () => {
    // A real runner reaches the shared gate...
    expect(runnerReachesSharedGate('apps/operator', 'node ../../scripts/lint-tsc-operator.mjs')).toBe(true);
    expect(runnerReachesSharedGate('.', 'node scripts/lint-tsc.mjs')).toBe(true);
    // ...one that does not exist cannot, so a plausible-looking name is never
    // enough to be waved through as admitted.
    expect(runnerReachesSharedGate('.', 'node scripts/lint-tsc-does-not-exist.mjs')).toBe(false);
    expect(runnerPath('node ../../scripts/lint-tsc-operator.mjs')).toBe('../../scripts/lint-tsc-operator.mjs');
  });

  it('detects the bare-tsc form the first version of this guard was blind to', () => {
    // apps/operator-public's line, verbatim — matched nothing in the old
    // detector, which is why four workspaces read as clean.
    expect(isHeavyTypecheck('tsc --noEmit')).toBe(true);
    expect(isHeavyTypecheck('tsc -p tsconfig.json --noEmit')).toBe(true);
  });

  it('does not flag an emitting build, or a name merely containing tsc', () => {
    expect(isHeavyTypecheck('tsc -p tsconfig.build.json')).toBe(false);
    expect(isHeavyTypecheck('node scripts/gen-tsconfig.mjs --noEmit')).toBe(false);
  });

  it('does not flag a delegating script — it reaches an already-wrapped one', () => {
    expect(isHeavyTypecheck('npm --workspace @papercusp/operator-core run typecheck --')).toBe(false);
  });

  it('exempts a standalone-buildable tree, but not one already coupled to scripts/', () => {
    const submodules = ['libs/papercusp'];
    // A domain-free borrowable: pc-heavy.sh does not exist standalone.
    expect(inScope('libs/generic/rerank', 'tsc --noEmit', submodules)).toBe(false);
    // A submodule package that already reaches into the superproject's
    // scripts/ dir has that coupling today, so wrapping adds nothing new.
    expect(inScope('libs/papercusp/packages/orchestrator', 'node ../../../../scripts/lint-tsc-orchestrator.mjs', submodules)).toBe(
      true,
    );
    // A plain submodule package that does not reach out stays exempt.
    expect(inScope('libs/papercusp/packages/locks', 'tsc --noEmit -p tsconfig.json', submodules)).toBe(false);
  });

  it('scans a real, non-vacuous population — an empty result means clean, not absent', () => {
    // A scan-based guard that finds NOTHING to scan passes vacuously forever.
    const dirs = workspaceDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(40);
    expect(dirs).toContain('.');
    expect(submodulePaths().length).toBeGreaterThanOrEqual(10);

    const governed = governedScripts();
    expect(governed.length).toBeGreaterThanOrEqual(8);
    // …and specifically NOT only the root manifest, which is the exact blind
    // spot that let five unthrottled entrypoints sit unnoticed.
    expect(governed.filter((entry) => !entry.startsWith('. ::')).length).toBeGreaterThanOrEqual(3);
  });
});
