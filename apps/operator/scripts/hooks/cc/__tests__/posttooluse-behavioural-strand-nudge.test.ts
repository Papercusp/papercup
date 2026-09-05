/**
 * posttooluse-behavioural-strand-nudge — the recurrence guard for the BEHAVIOURAL
 * cross-workspace strand class (EI-20022235111425919).
 *
 * WHAT THIS FILE IS FOR. The class is invisible to both instruments an author reads as
 * green: `lint:tsc` sees no type change (only a runtime call count moved) and
 * `test:affected` selects by the workspaces the changed PATHS map into, which is the wrong
 * workspace by construction. Measured cost of one instance (WI-37582): ~3 gate reds, ~2h of
 * frozen `main`, three agents diagnosing it in parallel. A detector already exists; the gap
 * the hook closes is KNOWING TO RUN IT. So the assertion that matters is not "the hook is
 * well-formed" but **it FIRES on the real thing** — exercised against the REAL exported
 * `increasedSeams` / `repoForPath` / `submodulePaths` from
 * scripts/check-behavioural-strands.mjs, never a stand-in.
 *
 * THE DEFECT A COPY OF THE SIBLING HOOK WOULD HAVE, asserted here directly: `libs/generic/*`
 * and `libs/papercusp` are SUBMODULES and they are this guard's whole trigger class. A
 * superproject `git show HEAD:<path>` answers "absent" for a file that is committed inside
 * one, and the hook reads that null as "new file — nothing to strand". Such a hook never
 * fires on exactly the files it exists for, while passing any test written on a superproject
 * fixture. The routing tests below are what make that failure impossible to reintroduce
 * silently: they assert WHICH repo the git questions were asked of, not just the output text.
 *
 * The negative cases matter exactly as much: a nudge that fires on ordinary edits is noise
 * agents learn to ignore, which is how a working detector stops working.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-behavioural-strand-nudge.mjs');
const DETECTOR = resolve(ROOT, 'scripts/check-behavioural-strands.mjs');

type Seam = { seam: string; before: number; after: number };
type Detector = {
  increasedSeams: (before: string, after: string, file?: string) => Seam[];
  repoForPath: (rel: string, subs: string[]) => { submodule: string | null; cwd: string; relPath: string };
  submodulePaths: () => string[];
};
type Hook = {
  nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
  isCandidateFile: (p: string) => boolean;
  formatNudge: (rel: string, seams: Seam[], opts?: { baseSha?: string | null; submodule?: string | null }) => string;
  isDirectCliInvocation: (entryPath?: string) => boolean;
};

const loadHook = async (): Promise<Hook> => (await import(`file://${HOOK}`)) as unknown as Hook;
/** The REAL detector — the whole value of this suite is that it is not a fake. */
const loadDetector = async (): Promise<Detector> => (await import(`file://${DETECTOR}`)) as unknown as Detector;

/** A one-call → two-call edit of an injected collaborator: the exact WI-37582 shape. */
const ONE_CALL = 'export function run(source){ return source.lexical(); }';
const TWO_CALLS = 'export function run(source){ source.lexical(); return source.lexical(); }';
/** Same file, edited, but the seam count is unchanged — the calibration control. */
const ONE_CALL_EDITED = 'export function run(source){ /* comment */ return source.lexical(); }';

/**
 * Deps that use the REAL detector but inject file content and git answers, so no tree write
 * is needed. `exists` answers true ONLY for the edited file and the detector, which is what
 * makes findRepoRoot resolve the REAL repo root — and therefore what makes the repo-relative
 * path, and the submodule routing computed from it, genuinely exercised rather than faked.
 */
async function depsFor(
  abs: string,
  before: string | null,
  after: string,
  opts: { baseSha?: string | null } = {},
) {
  const detector = await loadDetector();
  const showAtCalls: Array<{ cwd: string; relPath: string; ref: string }> = [];
  const resolveBaseCalls: string[] = [];
  const baseSha = opts.baseSha === undefined ? 'abc1234def' : opts.baseSha;
  return {
    showAtCalls,
    resolveBaseCalls,
    deps: {
      exists: (p: string) => p === abs || p === DETECTOR,
      sizeOf: () => 100,
      readFile: () => after,
      showAt: (cwd: string, relPath: string, ref: string) => {
        showAtCalls.push({ cwd, relPath, ref });
        return before;
      },
      resolveBase: (cwd: string) => {
        resolveBaseCalls.push(cwd);
        return baseSha;
      },
      loadDetector: async () => detector,
    },
  };
}

describe('behavioural-strand nudge — fires on the real trap', () => {
  it('FIRES when an edit adds a call to an injected seam, naming the seam and both counts', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, TWO_CALLS);
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('SEAM CALL-COUNT INCREASE');
    expect(out).toContain('source.lexical');
    expect(out).toContain('called 1× → 2×');
    // It must point at the detector, since KNOWING TO RUN IT is the entire gap.
    expect(out).toContain('check-behavioural-strands.mjs');
  });

  it('CONTROL: the same file, edited, with the seam count UNCHANGED produces nothing', async () => {
    // Calibrates the assertion above: without this, a hook that fired on every edit would
    // pass the first test just as well.
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, ONE_CALL_EDITED);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });

  it('produces nothing when the file is byte-identical to its base', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, TWO_CALLS, TWO_CALLS);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });

  it('produces nothing for a NEW file (no version at the base to strand against)', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, null, TWO_CALLS);
    expect(await hook.nudgeFor(abs, deps)).toBeNull();
  });
});

describe('behavioural-strand nudge — submodule routing (the sibling-copy defect)', () => {
  it('asks git of the SUBMODULE that owns the file, with the submodule-relative path', async () => {
    // libs/generic/* IS the trigger class. A superproject `git show HEAD:<that path>` answers
    // absent, which a naive hook reads as "new file" and returns null — never firing on the
    // very files it exists for. This asserts the routing, not merely the output.
    const hook = await loadHook();
    const abs = resolve(ROOT, 'libs/generic/search/src/hybrid.ts');
    const { deps, showAtCalls, resolveBaseCalls } = await depsFor(abs, ONE_CALL, TWO_CALLS);
    const out = await hook.nudgeFor(abs, deps);

    expect(out).not.toBeNull();
    expect(showAtCalls).toHaveLength(1);
    expect(showAtCalls[0].cwd).toBe(resolve(ROOT, 'libs/generic/search'));
    expect(showAtCalls[0].relPath).toBe('src/hybrid.ts');
    // The base is pinned ONCE, in the owning repo, and reused for the comparison and the
    // prescribed command — resolving it twice would leave a git-sync window between them.
    expect(resolveBaseCalls).toEqual([resolve(ROOT, 'libs/generic/search')]);
    expect(showAtCalls[0].ref).toBe('abc1234def');
    // The file is still named superproject-relative, because `--files=` is superproject-rooted.
    expect(out).toContain('libs/generic/search/src/hybrid.ts');
    expect(out).toContain('resolved in submodule libs/generic/search');
  });

  it('CONTROL: a superproject file routes to the superproject, with no submodule note', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps, showAtCalls, resolveBaseCalls } = await depsFor(abs, ONE_CALL, TWO_CALLS);
    const out = await hook.nudgeFor(abs, deps);

    expect(out).not.toBeNull();
    expect(showAtCalls[0].cwd).toBe(ROOT);
    expect(showAtCalls[0].relPath).toBe('packages/operator-core/lib/x.ts');
    expect(resolveBaseCalls).toEqual([ROOT]);
    expect(out).not.toContain('resolved in submodule');
  });
});

describe('behavioural-strand nudge — the prescribed command is anchored', () => {
  it('carries BOTH pins so it reproduces this comparison after git-sync sweeps the edit', async () => {
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, TWO_CALLS, { baseSha: 'deadbee' });
    const out = await hook.nudgeFor(abs, deps);
    expect(out).toContain('--base deadbee --files=packages/operator-core/lib/x.ts');
  });

  it('degrades to the --files-only form (still firing) when the base cannot be resolved', async () => {
    // Fails open rather than losing the nudge: a detached/empty repo or no git at all.
    const hook = await loadHook();
    const abs = resolve(ROOT, 'packages/operator-core/lib/x.ts');
    const { deps } = await depsFor(abs, ONE_CALL, TWO_CALLS, { baseSha: null });
    const out = await hook.nudgeFor(abs, deps);
    expect(out).not.toBeNull();
    expect(out).toContain('--files=packages/operator-core/lib/x.ts');
    expect(out).not.toContain('--base');
  });

  it('tells the reader to read the EXIT CODE, and that 2 is not a clean bill', async () => {
    const hook = await loadHook();
    const out = hook.formatNudge('a/b.ts', [{ seam: 's.m', before: 1, after: 2 }], { baseSha: 'abc1234' });
    expect(out).toContain('2 = NOT CHECKED');
    // The narrowing is a RANKING, not a boundary — saying so is what stops a reader treating
    // an empty narrow set as "nothing to check".
    expect(out).toContain('--wide');
    // Adding a call is usually correct; the fix for a stranded assertion is to UPDATE the
    // count, never to delete or loosen the assertion that makes the class detectable.
    expect(out).toContain('do not delete or');
  });
});

describe('behavioural-strand nudge — candidate filter', () => {
  it('accepts an ordinary shared-lib source file', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('libs/generic/search/src/hybrid.ts')).toBe(true);
    expect(hook.isCandidateFile('packages/operator-core/lib/x.ts')).toBe(true);
  });

  it('excludes TEST files on purpose — a test is not something anyone injects', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/x.test.ts')).toBe(false);
    expect(hook.isCandidateFile('packages/operator-core/lib/x.spec.tsx')).toBe(false);
  });

  it('MIRRORS the CLI exactly: the test exclusion is by SUFFIX, so a __tests__/ helper is in scope', async () => {
    // Not an oversight, and deliberately pinned rather than "fixed" in the hook alone. The
    // hook's filter is a copy of the detector's (SOURCE_RE / TEST_RE / EXCLUDED_DIR_RE /
    // EXCLUDED_ROOT_RE in scripts/check-behavioural-strands.mjs) and the hook PRESCRIBES that
    // detector's command — so a hook that narrowed further would nudge on a set the command it
    // hands you does not judge, which is worse than the occasional nudge on a __tests__/
    // helper. If the exclusion should become directory-aware, change it in the DETECTOR and
    // let the hook keep mirroring it; this assertion is what would then fail and point here.
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/__tests__/helpers.ts')).toBe(true);
  });

  it('excludes declarations and build/vendor output', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('packages/operator-core/lib/x.d.ts')).toBe(false);
    expect(hook.isCandidateFile('node_modules/pkg/index.ts')).toBe(false);
    expect(hook.isCandidateFile('packages/operator-core/dist/x.js')).toBe(false);
  });

  it('excludes a non-source file outright', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('README.md')).toBe(false);
    expect(hook.isCandidateFile('package.json')).toBe(false);
  });
});

describe('behavioural-strand nudge — never runs main() on import', () => {
  it('isDirectCliInvocation is TRUE only for this hook’s own basename', async () => {
    // Importing the module must not run main(): main() waits on stdin and then calls
    // process.exit(0), which kills the vitest worker mid-run — the sibling hook's suite
    // caught exactly that (10 passed, run reported FAILED). This whole file is the standing
    // proof that it does not, and these two assertions name the mechanism.
    const hook = await loadHook();
    expect(hook.isDirectCliInvocation('/home/u/.papercusp/hooks/cc/posttooluse-behavioural-strand-nudge.mjs')).toBe(
      true,
    );
    expect(hook.isDirectCliInvocation('/repo/node_modules/vitest/dist/worker.js')).toBe(false);
    expect(hook.isDirectCliInvocation(undefined)).toBe(false);
  });
});
