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
// @ts-expect-error — .mjs guard script, no type declarations by design
import { collectExportedRequiredProps, collectExportedTypeNames, diffRequiredAdditions, formatNoFindings } from '../../../../scripts/check-required-field-strands.mjs';

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
    // Still reports the clean-bill count/list (other declared files may be genuinely
    // examined) but must not read as an unqualified clean bill for the identical one.
    expect(msg).toMatch(/^✓/);
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
  });
});
