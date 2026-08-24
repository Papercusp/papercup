/**
 * WI-6814 — the required-field trap detector.
 *
 * The case that motivated it (EI-19304433184633406, the 5th occurrence): `remoteOrigin`
 * became required on `IssueClaimExclusionBreakdown.excluded`, which is NESTED one level
 * inside the interface. That nesting is the whole difficulty — a top-level-only scan
 * reports nothing and reads exactly like "no trap here", which is the false-clean failure
 * this guard exists to prevent. Several tests below pin the nested case specifically.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { collectExportedRequiredProps, collectExportedTypeNames, diffRequiredAdditions, exitForNoFindings, formatNoFindings, formatScopedTypecheckWarning, submoduleFor, submoduleRevisionAt } from '../../../../scripts/check-required-field-strands.mjs';

const ROOT = resolve(__dirname, '../../../..');

const BEFORE = `
export interface IssueClaimExclusionBreakdown {
  matchedByFilter: number;
  claimable: number;
  excluded: {
    taken: number;
    cooldown: number;
  };
}
`;

const AFTER = `
export interface IssueClaimExclusionBreakdown {
  matchedByFilter: number;
  claimable: number;
  excluded: {
    taken: number;
    cooldown: number;
    remoteOrigin: number;
  };
}
`;

describe('collectExportedRequiredProps', () => {
  it('records NESTED object-literal members under a dotted path, not just top-level ones', () => {
    const props = collectExportedRequiredProps(AFTER);
    expect(props.has('IssueClaimExclusionBreakdown.excluded.remoteOrigin')).toBe(true);
    expect(props.has('IssueClaimExclusionBreakdown.matchedByFilter')).toBe(true);
  });

  it('marks optional members optional so they are never reported as stranding anything', () => {
    const props = collectExportedRequiredProps(`
      export interface A { req: number; opt?: string; }
    `);
    expect(props.get('A.req')).toEqual({ optional: false });
    expect(props.get('A.opt')).toEqual({ optional: true });
  });

  it('ignores NON-exported types — they have no cross-file construction sites to strand', () => {
    const props = collectExportedRequiredProps(`
      interface Private { a: number; }
      export interface Public { b: number; }
    `);
    expect([...props.keys()]).toEqual(['Public.b']);
  });

  it('covers exported object-type ALIASES, not only interfaces', () => {
    const props = collectExportedRequiredProps(`export type Stamp = { harness: string; };`);
    expect(props.has('Stamp.harness')).toBe(true);
  });
});

describe('diffRequiredAdditions', () => {
  it('flags the real EI-19304433184633406 case: a required field added to a NESTED literal', () => {
    const added = diffRequiredAdditions(BEFORE, AFTER);
    expect(added).toEqual([
      { path: 'IssueClaimExclusionBreakdown.excluded.remoteOrigin', reason: 'added-required' },
    ]);
  });

  it('flags a field TIGHTENED from optional to required — it strands sites just as hard', () => {
    const added = diffRequiredAdditions(
      `export interface A { x?: number; }`,
      `export interface A { x: number; }`,
    );
    expect(added).toEqual([{ path: 'A.x', reason: 'optional-to-required' }]);
  });

  it('stays SILENT on an added OPTIONAL field — the safe way to extend a shared type', () => {
    const added = diffRequiredAdditions(
      `export interface A { x: number; }`,
      `export interface A { x: number; y?: string; }`,
    );
    expect(added).toEqual([]);
  });

  it('stays silent when nothing about the type changed (no false positive on unrelated edits)', () => {
    expect(diffRequiredAdditions(AFTER, AFTER)).toEqual([]);
  });

  it('stays silent on a REMOVED field — that breaks nothing that constructs the type', () => {
    const added = diffRequiredAdditions(
      `export interface A { x: number; y: string; }`,
      `export interface A { x: number; }`,
    );
    expect(added).toEqual([]);
  });

  it('does not flag a required field added to a NON-exported type', () => {
    const added = diffRequiredAdditions(
      `interface A { x: number; }`,
      `interface A { x: number; y: string; }`,
    );
    expect(added).toEqual([]);
  });

  it('reports every addition across several types in one file, not just the first', () => {
    const added = diffRequiredAdditions(
      `export interface A { x: number; }\nexport interface B { y: number; }`,
      `export interface A { x: number; a2: string; }\nexport interface B { y: number; b2: string; }`,
    );
    expect(added.map((a: { path: string }) => a.path).sort()).toEqual(['A.a2', 'B.b2']);
  });

  it('recurses through an OPTIONAL wrapper: a required field inside it still strands every site that supplies the wrapper', () => {
    const added = diffRequiredAdditions(
      `export interface A { w?: { p: number; }; }`,
      `export interface A { w?: { p: number; q: number; }; }`,
    );
    expect(added).toEqual([{ path: 'A.w.q', reason: 'added-required' }]);
  });
});

/**
 * EI-19422135158287319 — a type INTRODUCED in the same diff cannot strand anything.
 *
 * main() already skipped a brand-new FILE for exactly this reason ("a brand-new exported
 * interface has no pre-existing construction sites, so it cannot strand anything"), but
 * applied that reasoning only at FILE granularity. A new type added to an EXISTING file
 * therefore reported every one of its fields as newly-required — and re-fired on every
 * later edit to that file, so one new type produced a run of identical warnings in a
 * single session (measured: 3 fires across 3 edits).
 *
 * The cost is not noise, it is CREDIBILITY: this guard's value depends on agents still
 * reading it, and a warning that is provably impossible is how a good advisory gets tuned
 * out — paid later by whoever hits a real strand.
 */
describe('diffRequiredAdditions — a type NEW in this diff strands nothing by construction', () => {
  it('stays SILENT on a brand-new exported interface added to an existing file', () => {
    const added = diffRequiredAdditions(
      `export interface Existing { a: number; }`,
      `export interface Existing { a: number; }\nexport interface RegistryBehaviour { readonly name: string; readonly seeAlso?: unknown; }`,
    );
    expect(added).toEqual([]);
  });

  it('stays SILENT on a brand-new exported TYPE ALIAS, including its nested literals', () => {
    const added = diffRequiredAdditions(
      `export interface Existing { a: number; }`,
      `export interface Existing { a: number; }\nexport type NewShape = { top: string; nested: { deep: number; }; };`,
    );
    expect(added).toEqual([]);
  });

  it('STILL FIRES for a pre-existing type in the same diff — the guard is narrowed, not blunted', () => {
    // The discriminating case: one new type (silent) + one real addition (flagged), together.
    const added = diffRequiredAdditions(
      `export interface Existing { a: number; }`,
      `export interface Existing { a: number; b: string; }\nexport interface BrandNew { c: number; }`,
    );
    expect(added).toEqual([{ path: 'Existing.b', reason: 'added-required' }]);
  });

  it('FIRES on the first required field added to a pre-existing EMPTY interface', () => {
    // The edge case that decides the implementation: an `export interface Foo {}` contributes
    // ZERO property paths, so a type-name set inferred from those paths would not contain Foo
    // and this genuine stranding would be suppressed as "new type". Names are collected from
    // declarations directly precisely so this cannot happen.
    const added = diffRequiredAdditions(
      `export interface Foo {}`,
      `export interface Foo { x: number; }`,
    );
    expect(added).toEqual([{ path: 'Foo.x', reason: 'added-required' }]);
  });

  it('still flags optional → required on a pre-existing type (the tightening path is unaffected)', () => {
    const added = diffRequiredAdditions(
      `export interface A { x?: number; }`,
      `export interface A { x: number; }\nexport interface AlsoNew { y: string; }`,
    );
    expect(added).toEqual([{ path: 'A.x', reason: 'optional-to-required' }]);
  });
});

describe('collectExportedTypeNames', () => {
  it('collects exported interfaces and type aliases, and ignores non-exported ones', () => {
    const names = collectExportedTypeNames(
      `export interface A { x: number; }
       export type B = { y: number; };
       interface Hidden { z: number; }
       type AlsoHidden = { w: number; };`,
    );
    expect([...names].sort()).toEqual(['A', 'B']);
  });

  it('includes a MEMBERLESS exported interface — the case a property-derived set would miss', () => {
    expect([...collectExportedTypeNames(`export interface Empty {}`)]).toEqual(['Empty']);
  });

  it('includes a non-object type alias (never under-reports what already existed)', () => {
    // `export type U = 'a' | 'b'` has no properties to scan, but it DID exist — and being
    // conservative here only ever means reporting, never wrongly suppressing.
    expect([...collectExportedTypeNames(`export type U = 'a' | 'b';`)]).toEqual(['U']);
  });
});

/**
 * The check is only as good as its NEGATIVE verdict, and on this tree that verdict
 * used to be unfalsifiable. git-sync commits the whole shared tree on a schedule, so
 * minutes after you edit, working-tree == HEAD and the default `--base HEAD` diff is
 * EMPTY — the scan then examines zero files and printed the same green as a real pass.
 *
 * Measured 2026-08-02: `npm run lint:required-field-strands` reported "no required
 * fields added" for a change that HAD added required field `ServeProgress.bytesIn`
 * (serve-wiring.ts). Re-running with `--base <introducing-commit>^` flagged it
 * correctly. Same "checked nothing, rendered as clean" class as the `tsc -p .`
 * zero-file trap.
 */
/**
 * EI-20020054576584970 — the blindness that let the 2026-08-12 incident through.
 *
 * To the superproject a submodule is a GITLINK, so `git show HEAD:<submodule path>` fails
 * and `git diff` names only the gitlink. Both of this guard's entry points therefore saw
 * NOTHING for any file inside libs/*, and the run degraded to NOT CHECKED while blaming the
 * git-sync race. That is how `ActiveLockRow.lock_id` (libs/papercusp/packages/locks/src/
 * su-lock-store.ts) stranded a mock fixture and froze `main` for ~14h.
 *
 * Verified end-to-end after the fix: the same command that used to print
 * "fatal ... → ZERO files examined" now reports `ActiveLockRow.lock_id (new required field)`.
 * These cases pin the path-ownership rule that makes that possible.
 */
describe('submoduleFor — ask the repository that actually tracks the file', () => {
  // Real prefixes from this repo's .gitmodules, longest-first as submodulePrefixes() sorts them.
  const prefixes = ['libs/generic/papergrid', 'libs/papercusp-db', 'libs/papercusp', 'libs/agent-chat'];

  it('resolves a file inside a submodule to that submodule', () => {
    expect(submoduleFor('libs/papercusp/packages/locks/src/su-lock-store.ts', prefixes)).toBe('libs/papercusp');
  });

  it('returns null for a superproject file, so the normal path is untouched', () => {
    expect(submoduleFor('packages/operator-core/lib/git-pipeline-position.ts', prefixes)).toBeNull();
  });

  it('does NOT let a submodule swallow a SIBLING whose name it prefixes', () => {
    // libs/papercusp and libs/papercusp-db both exist here. A bare startsWith(prefix) would
    // route every libs/papercusp-db file into the wrong repository, where its path does not
    // exist — reproducing the exact "cannot see your file" failure this fix removes.
    expect(submoduleFor('libs/papercusp-db/src/index.ts', prefixes)).toBe('libs/papercusp-db');
  });

  it('prefers the NESTED submodule over its parent (prefixes are longest-first)', () => {
    expect(submoduleFor('libs/generic/papergrid/src/grid.ts', ['libs/generic/papergrid', 'libs/generic'])).toBe(
      'libs/generic/papergrid',
    );
  });

  it('matches the submodule root path itself, not only paths beneath it', () => {
    expect(submoduleFor('libs/papercusp', prefixes)).toBe('libs/papercusp');
  });
});

describe('submoduleRevisionAt — follow the superproject gitlink before querying a submodule', () => {
  const submodulePrefix = 'libs/generic/memory';
  const submoduleFile = `${submodulePrefix}/src/backend.ts`;

  it('resolves a superproject base to the submodule commit recorded at that base', () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const expected = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${base}:${submodulePrefix}`],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();

    expect(submoduleRevisionAt(base, submodulePrefix)).toBe(expected);
  });

  it('examines a declared submodule file instead of treating the superproject SHA as its base', () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const result = spawnSync(
      'node',
      ['scripts/check-required-field-strands.mjs', '--base', base, `--files=${submoduleFile}`, '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    const report = JSON.parse(result.stdout);

    expect(result.stderr).not.toMatch(/fatal: (?:bad revision|path .* exists on disk)/);
    expect(report.examined).toContain(submoduleFile);
  }, 120_000);
});

/**
 * EI-18717671811306780. The guard's detection was already sound; what was missing sat one
 * step later, at the moment the author decides HOW to confirm. The prescribed command is
 * project-wide and under fleet load it queues behind pc-heavy for minutes, so the tempting
 * move is the fastest green thing available — a SCOPED typecheck. That substitution reports
 * GREEN on exactly this class, because the stranded sites are DEPENDENTS of the changed file
 * and a scoped run only compiles the file plus what it imports. These cases pin the warning
 * to the remediation text so it cannot be quietly dropped from the one place it is read.
 */
describe('formatScopedTypecheckWarning — the fast substitute is blind to this class', () => {
  it('names the scoped typecheck explicitly, so the reader recognises the shortcut they were about to take', () => {
    const msg = formatScopedTypecheckWarning();
    expect(msg).toContain('scopeToFiles');
    expect(msg).toMatch(/scoped tsc/i);
  });

  it('gives the MECHANISM (dependents are not in the import graph), not just a prohibition', () => {
    const msg = formatScopedTypecheckWarning();
    // Without the reason, a hurried reader treats it as ceremony and overrides it.
    expect(msg).toContain('DEPENDENTS');
    expect(msg).toMatch(/import/i);
  });

  it('warns that a scoped run goes GREEN — an absent error, not a visible failure', () => {
    const msg = formatScopedTypecheckWarning();
    expect(msg).toContain('GREEN');
  });

  it('names the pc-heavy queue as expected behaviour, so a wait is not misread as a hang', () => {
    const msg = formatScopedTypecheckWarning();
    expect(msg).toContain('pc-heavy');
    expect(msg).toMatch(/not a hang/i);
  });
});

describe('formatNoFindings — "examined nothing" must never read as "clean"', () => {
  it('does NOT claim a clean bill when zero files were examined', () => {
    const msg = formatNoFindings([], 'HEAD');
    expect(msg).toContain('NOT CHECKED');
    expect(msg).toContain('ZERO files');
    // The specific misreading this exists to prevent.
    expect(msg).not.toMatch(/^✓/m);
  });

  it('names git-sync as the likely cause and gives a runnable recovery', () => {
    const msg = formatNoFindings([], 'HEAD');
    expect(msg).toContain('git-sync');
    expect(msg).toContain('--base');
  });

  it('passes cleanly when files WERE examined, and says how many', () => {
    const msg = formatNoFindings(['a.ts', 'b.ts', 'c.ts'], 'HEAD~1');
    expect(msg).toMatch(/^✓/);
    expect(msg).toContain('3 file(s) examined');
    expect(msg).toContain('HEAD~1');
    expect(msg).not.toContain('NOT CHECKED');
  });

  it('reports the base it actually used, so a wrong --base is visible in the verdict', () => {
    expect(formatNoFindings(['a.ts', 'b.ts'], 'abc123^')).toContain('abc123^');
  });

  /**
   * EI-19377892307939503. The zero-file branch above is real but UNREACHABLE on this
   * tree: `git diff` returns every agent's uncommitted edits, so peers keep the count
   * non-zero indefinitely while git-sync quietly drops YOUR file out of the diff within
   * minutes. Measured live — the check reported "3 changed file(s) examined" for a run
   * whose three files (checkpoint-run.ts, checkpoint-run.test.ts, fleet-scope-admission.
   * test.ts) belonged to a peer, while the file carrying the required-field addition had
   * already been committed. A count alone cannot expose that; the file list can.
   */
  it('NAMES the files examined, so an author sees their own file is absent', () => {
    const msg = formatNoFindings(['peer/one.ts', 'peer/two.ts'], 'HEAD');
    expect(msg).toContain('peer/one.ts');
    expect(msg).toContain('peer/two.ts');
  });

  it('warns that an INFERRED set is the whole fleet’s edits, not yours', () => {
    const msg = formatNoFindings(['peer/one.ts'], 'HEAD');
    expect(msg).toContain('INFERRED');
    // The actionable escape: declare the set instead of inferring it.
    expect(msg).toContain('--files=');
  });

  it('drops that warning for a DECLARED set, whose attribution IS trustworthy', () => {
    // A declared set is exactly what the caveat tells you to switch to, so repeating it
    // there would train readers to ignore it.
    const msg = formatNoFindings(['mine.ts'], 'HEAD', { declared: true });
    expect(msg).toMatch(/^✓/);
    expect(msg).toContain('mine.ts');
    expect(msg).not.toContain('INFERRED');
  });

  /**
   * EI-19396116936287206. `--files=` fixes attribution (WHICH files) but not vacuity
   * (WHETHER the diff was real): "examined" only ever meant "a before/after pair was
   * diffed", not "the two texts actually differed". On this tree git-sync commits within
   * minutes, so a NAMED file is frequently byte-identical to `base` by the time you check
   * it — measured live: `--files=` named the exact file carrying a real required-field
   * addition, examined it, found before===after (git-sync had already swept the edit into
   * HEAD), and printed a plain green with no hint the comparison was vacuous.
   */
  it('warns when a DECLARED file is byte-identical to base — the comparison proved nothing', () => {
    const msg = formatNoFindings(['mine.ts'], 'HEAD', {
      declared: true,
      identicalFiles: ['mine.ts'],
    });
    // EI-20097325488507587: this assertion used to require `/^✓/` here, on the rationale
    // that "other declared files may be genuinely examined" — true of the MIXED case
    // below, but not of this one, where EVERY named file was identical and the run
    // therefore compared nothing at all. exitForNoFindings already returned
    // EXIT_NOT_CHECKED for this exact input, so the ✓ headline contradicted the tool's
    // own exit status, and the invalidation sat four lines below it reading as a caveat
    // on a pass. The headline is what a reader acts on, so it has to carry the verdict.
    expect(msg).toMatch(/^⚠ NOT CHECKED/);
    expect(msg).not.toMatch(/^✓/);
    expect(msg).toContain('NOT CHECKED');
    expect(msg).toContain('BYTE-IDENTICAL');
    expect(msg).toContain('mine.ts');
    expect(msg).toContain('git-sync');
    expect(msg).toContain('--base');
  });

  it('says nothing extra when a DECLARED set has no identical files', () => {
    const msg = formatNoFindings(['mine.ts'], 'HEAD', { declared: true, identicalFiles: [] });
    expect(msg).not.toContain('BYTE-IDENTICAL');
    expect(msg).not.toContain('NOT CHECKED');
  });

  it('names only the identical files, not every declared file, when the set is mixed', () => {
    const msg = formatNoFindings(['mine.ts', 'also-mine.ts'], 'HEAD', {
      declared: true,
      identicalFiles: ['also-mine.ts'],
    });
    expect(msg).toContain('1 of 2 named file(s)');
    expect(msg).toContain('also-mine.ts');
    // A PARTIAL run did verify something, so it keeps the ✓ headline — the distinction
    // the invariant below polices, and the reason this is not simply "warn whenever any
    // file is identical".
    expect(msg).toMatch(/^✓/);
  });

  /**
   * THE INVARIANT, not another example: the headline a human acts on and the exit status
   * a script acts on must never disagree.
   *
   * They are separate code paths that happened to agree until they didn't — the text said
   * ✓ while the status said EXIT_NOT_CHECKED for an all-identical declared run. Pinning
   * the pair across the whole input matrix is what makes that unrepresentable; asserting
   * the two known cases individually is what let the third one drift.
   */
  it.each([
    { name: 'zero files examined', files: [] as string[], identical: [] as string[], declared: false },
    { name: 'inferred set, files examined', files: ['peer.ts'], identical: [], declared: false },
    { name: 'declared, none identical', files: ['mine.ts'], identical: [], declared: true },
    { name: 'declared, all identical', files: ['mine.ts'], identical: ['mine.ts'], declared: true },
    {
      name: 'declared, partially identical',
      files: ['mine.ts', 'also.ts'],
      identical: ['also.ts'],
      declared: true,
    },
  ])('headline and exit status agree: $name', ({ files, identical, declared }) => {
    const msg = formatNoFindings(files, 'HEAD', { declared, identicalFiles: identical });
    const code = exitForNoFindings({ examinedFiles: files, identicalFiles: identical, declared });
    expect(msg.startsWith('⚠ NOT CHECKED')).toBe(code !== 0);
    expect(msg.startsWith('✓')).toBe(code === 0);
  });
});

/**
 * EI-20095543794921181 — the warning above was already correct and already
 * printed; the run still EXITED 0. Prose does not reach `&& echo PASS`,
 * `grep -c "error TS"`, or a CI step's exit status, which are the readers that
 * actually decide. Measured: the default invocation reported exit 0 having
 * examined ZERO files (git-sync had already committed the edit, so nothing
 * differed from HEAD), while the same tree checked against the carrying commit
 * had 30 real errors — 5 in a file `test:affected` does not select.
 */
describe('exitForNoFindings — "no findings" is not a clean bill unless something was diffed', () => {
  it('is NOT 0 when zero files were examined — the false clean this exists to kill', () => {
    expect(exitForNoFindings({ examinedFiles: [], identicalFiles: [], declared: false })).not.toBe(0);
  });

  it('is NOT 0 when every DECLARED file was byte-identical to the base', () => {
    expect(
      exitForNoFindings({
        examinedFiles: ['mine.ts', 'also-mine.ts'],
        identicalFiles: ['mine.ts', 'also-mine.ts'],
        declared: true,
      }),
    ).not.toBe(0);
  });

  it('distinguishes "not checked" from "checked, strands found" (1) so a caller can tell them apart', () => {
    // The whole point of a third code: 0 and 1 are both claims about a run that
    // LOOKED, and neither is honest about a run that did not.
    const notChecked = exitForNoFindings({ examinedFiles: [], declared: false });
    expect(notChecked).not.toBe(0);
    expect(notChecked, 'must not collide with the strands-found status').not.toBe(1);
  });

  it('IS 0 when files were genuinely diffed and nothing was stranded', () => {
    expect(exitForNoFindings({ examinedFiles: ['mine.ts'], identicalFiles: [], declared: true })).toBe(0);
    expect(exitForNoFindings({ examinedFiles: ['a.ts', 'b.ts'], identicalFiles: [], declared: false })).toBe(0);
  });

  it('IS 0 for a PARTIAL declared run — it verified what it could, and the message names the rest', () => {
    // Deliberate: failing this case would fail runs that did real work. Tightening
    // it is a defensible future choice, but an intentional one, not a side effect.
    expect(
      exitForNoFindings({ examinedFiles: ['mine.ts', 'also-mine.ts'], identicalFiles: ['also-mine.ts'], declared: true }),
    ).toBe(0);
  });

  it('ignores identicalFiles when the set was INFERRED, not declared (identical tracking is a declared-mode signal)', () => {
    expect(exitForNoFindings({ examinedFiles: ['a.ts'], identicalFiles: ['a.ts'], declared: false })).toBe(0);
  });
});

describe('invalid base revisions — never reinterpret a bad revision as a clean diff', () => {
  it('fails closed with EXIT_NOT_CHECKED instead of printing a false-green headline', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'required-field-strands-invalid-base-'));
    try {
      cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
      symlinkSync(join(ROOT, 'node_modules'), join(tmp, 'node_modules'));
      mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });
      const file = join(tmp, 'packages/operator-core/lib/a.ts');
      writeFileSync(file, 'export interface A { id: string; }\n');

      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      git('init', '-q', '.');
      git('config', 'user.email', 'required-field-strands@test.invalid');
      git('config', 'user.name', 'required-field-strands');
      git('add', '-A');
      git('commit', '-qm', 'base');
      writeFileSync(file, 'export interface A { id: string; required: number; }\n');

      const result = spawnSync('node', ['scripts/check-required-field-strands.mjs', '--base', 'not-a-real-revision'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).toBe(2);
      expect(output).toContain('cannot resolve base revision');
      expect(output).not.toContain('✓');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
