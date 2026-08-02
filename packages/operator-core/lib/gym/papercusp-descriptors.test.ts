/**
 * papercusp-descriptors.test.ts — probe results → task descriptors.
 *
 * The rule under test is that NOTHING here invents a requirement (D-008). The
 * spec must come from the oracle's own words or the task must be dropped; a
 * paraphrase would turn the corpus back into D-003's extraction, where the task
 * measures the quality of the prose someone wrote about the code.
 */
import { describe, expect, it } from 'vitest';
import { buildDescriptorsFromProbe, extractTestOutline, taskIdForImpl, type ProbeResultRow } from './papercusp-descriptors';

const PIN = '38ae7fafe0aeb59527af7419e64d4c50b30ee2c6';

const row = (over: Partial<ProbeResultRow> = {}): ProbeResultRow => ({
  implPath: 'packages/operator-core/lib/events/await/pattern.ts',
  testPath: 'packages/operator-core/lib/events/await/pattern.test.ts',
  joint: '479d660f127b616011465b52a17b81c96c6f05b6',
  parent: '6210dde2e31e276d7fe9ce764aca4b72780f7cd6',
  verdict: 'admitted',
  ...over,
});

const SRC = `
  describe('expandPatternMacro', () => {
    it('@fleet:<slug> → fleet:*:<slug>', () => {});
    it("throws loudly on an unknown macro (a typo must not store a dead key)", () => {});
  });
`;

describe('extractTestOutline', () => {
  it('separates describe titles from the it titles that state the requirements', () => {
    const o = extractTestOutline(SRC);
    expect(o.describes).toEqual(['expandPatternMacro']);
    expect(o.its).toEqual([
      '@fleet:<slug> → fleet:*:<slug>',
      'throws loudly on an unknown macro (a typo must not store a dead key)',
    ]);
  });

  it('handles an apostrophe inside a double-quoted title without truncating it', () => {
    expect(extractTestOutline(`it("fills from the agent's plan", () => {})`).its).toEqual(["fills from the agent's plan"]);
  });

  it('unescapes an escaped quote rather than leaking the backslash into the spec', () => {
    expect(extractTestOutline(`it('the agent\\'s claim', () => {})`).its).toEqual(["the agent's claim"]);
  });

  it('returns empty outlines instead of throwing on source it cannot make sense of', () => {
    expect(extractTestOutline('this is not typescript at all {{{')).toEqual({ describes: [], its: [] });
  });
});

describe('taskIdForImpl', () => {
  it('is stable, filesystem-safe, and traceable back to the file', () => {
    expect(taskIdForImpl('packages/operator-core/lib/events/await/pattern.ts')).toBe('real-operator-core-lib-events-await-pattern');
  });
});

describe('buildDescriptorsFromProbe', () => {
  const FAILING = ['throws loudly on an unknown macro (a typo must not store a dead key)'];
  const build = (rows: ProbeResultRow[], src: string | null = SRC, failing: readonly string[] = FAILING) =>
    buildDescriptorsFromProbe({
      rows,
      pinCommit: PIN,
      readTestSource: () => src,
      failingIts: new Map(rows.map((r) => [r.implPath, failing])),
    });

  it('takes the spec VERBATIM from the oracle — no paraphrase, no invented prose', () => {
    const [d] = build([row()]);
    expect(d.spec).toContain('throws loudly on an unknown macro (a typo must not store a dead key)');
    expect(d.spec).toContain(row().testPath);
    expect(d.intent).toContain('expandPatternMacro');
  });

  /**
   * The haystack regression. Measured: the worst admitted candidate's oracle
   * carries 232 titles while its rewind breaks a handful, and the verified
   * sample broke 6 of 26. Listing all of them measures needle-finding, not
   * implementation — and at ~19.5KB crowds out the agent's context.
   */
  it('lists ONLY the requirements the rewind actually breaks, not every title in the file', () => {
    const [d] = build([row()]);
    // present in the source outline, but NOT in the failing set
    expect(d.spec).not.toContain('@fleet:<slug>');
    expect(d.spec).toContain('currently FAILS');
  });

  it('DROPS a candidate whose breaking requirements were never measured, rather than listing them all', () => {
    expect(build([row()], SRC, [])).toEqual([]);
  });

  it('pins every oracle at pinCommit and rewinds only to the joint commit’s parent', () => {
    const [d] = build([row()]);
    expect(d.pinCommit).toBe(PIN);
    expect(d.revertToCommit).toBe(row().parent);
    expect(d.sourceRef).toContain('479d660f127b');
  });

  /** The discrimination gate is the only admission path (D-006). */
  it('skips a rejected row even if the caller forgot to filter', () => {
    expect(build([row({ verdict: 'rejected', reason: 'no-oracle' })])).toEqual([]);
  });

  it('DROPS a task whose oracle source cannot be read rather than writing one for it', () => {
    expect(build([row()], null)).toEqual([]);
  });

  /**
   * real-anchor is scored but never optimized — it is the falsifiability check.
   * Filling pools in blocks would hand it whatever sorted last, i.e. a
   * systematically different population, which cannot answer "did this
   * generalise?".
   */
  it('assigns pools round-robin so real-anchor is not systematically the leftovers', () => {
    const rows = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => row({ implPath: `packages/x/${p}` }));
    expect(build(rows).map((d) => d.pool)).toEqual(['train', 'dev-anchor', 'real-anchor', 'train']);
  });

  it('advances the pool rotation only for tasks it actually admits', () => {
    const rows = [row({ implPath: 'packages/x/a.ts' }), row({ implPath: 'packages/x/b.ts', verdict: 'rejected' }), row({ implPath: 'packages/x/c.ts' })];
    expect(build(rows).map((d) => d.pool)).toEqual(['train', 'dev-anchor']);
  });
});
