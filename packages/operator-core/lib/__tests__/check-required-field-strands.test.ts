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
import { collectExportedRequiredProps, diffRequiredAdditions, formatNoFindings } from '../../../../scripts/check-required-field-strands.mjs';

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
});
