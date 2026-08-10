/**
 * WI-37717 — the agent-facing "run this SQL" guard (lint:sql-guidance-justified).
 * See scripts/check-sql-guidance-justified.mjs's header for the rule itself; this
 * file pins the MASKING, which was wrong in both directions until 2026-08-10.
 *
 * `guidanceRegions()` walks braces and quotes to find the agent-facing text. It
 * used to walk RAW source, so ordinary comment prose steered it:
 *   - an apostrophe in a comment ("a peer's") opens a string the walker never
 *     closes → the region runs to EOF and the tool's OWN implementation SQL is
 *     reported as agent-facing guidance (measured: work_items/claim_next.ts, the
 *     whole 22KB file);
 *   - a comment between `description:` and its literal makes the walker see `/`
 *     instead of a quote → the region is skipped entirely and never linted
 *     (measured: 3 live regions, all prompt-weight annotations).
 *
 * Two kinds of case below, both required:
 *   FALSIFIES — gives the WRONG answer against the pre-fix unmasked walker.
 *   ANCHOR    — passes before AND after, pinning the three ways this fix could
 *               have gone wrong: making the guard inert, blanking the
 *               comment-borne justification markers, or running a TypeScript
 *               parser over prose surfaces.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its pure detector. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { classifyHit, detectionText, guidanceRegions } from '../../../../scripts/check-sql-guidance-justified.mjs';

const SQL = `SELECT id FROM harness_shared.work_items WHERE state = 'open'`;
const TS = 'packages/operator-core/lib/agent-tools/x/tool.ts';
const MDX = 'apps/operator-docs/src/content/docs/agent-insights/x.mdx';

/** Call the guard's real decision the way the scan does: line N of `rawSrc`. */
const classify = (file: string, rawSrc: string, lineno: number) =>
  classifyHit({ file, lineno, content: rawSrc.split('\n')[lineno - 1] ?? '', rawSrc });

describe('classifyHit — comment text must not steer the region walker', () => {
  it('FALSIFIES: an apostrophe in a guidance comment must not run the region to EOF over implementation SQL', () => {
    const src = [
      'export const tool = {',
      '  guidance: {',
      "    // a peer's takeover — this apostrophe opened a fake string",
      "    when: 'claim the next item',",
      '  },',
      '  handler: async () => {',
      `    const rows = await sql(\`${SQL}\`);`,
      '  },',
      '};',
    ].join('\n');
    // The SQL is implementation, OUTSIDE the guidance object — encapsulation working.
    expect(classify(TS, src, 7)).toBeNull();
  });

  it('FALSIFIES: a comment between `description:` and its literal must not drop the region', () => {
    const src = [
      'export const tool = {',
      '  description:',
      '    // PROMPT-WEIGHT: trimmed from 1180 chars',
      `    'To find open items run ${SQL}',`,
      '};',
    ].join('\n');
    expect(classify(TS, src, 4)).toEqual({ table: 'work_items' });
  });

  it('FALSIFIES: SQL inside a plain comment is not agent-facing and must not report', () => {
    const src = [
      'export const tool = {',
      '  guidance: {',
      `    // historically we told agents to ${SQL}`,
      "    when: 'x',",
      '  },',
      '};',
    ].join('\n');
    expect(classify(TS, src, 3)).toBeNull();
  });

  it('ANCHOR: a genuine violation in a plain description still reports (the mask did not make it inert)', () => {
    const src = ['export const tool = {', `  description: 'To find open items run ${SQL}',`, '};'].join('\n');
    expect(classify(TS, src, 2)).toEqual({ table: 'work_items' });
  });

  it('ANCHOR: a justification written AS a comment still silences the site (marker is read from RAW)', () => {
    const src = [
      'export const tool = {',
      '  // sql-snippet-justified: the counter-example the description is about',
      `  description: 'never run ${SQL}',`,
      '};',
    ].join('\n');
    expect(classify(TS, src, 3)).toBeNull();
  });

  it('ANCHOR: prose surfaces are never masked — an .mdx snippet still reports', () => {
    const src = ['Run this to see the queue:', '', '```sql', SQL, '```'].join('\n');
    expect(classify(MDX, src, 4)).toEqual({ table: 'work_items' });
  });

  it('a bare marker with no reason does not count as a justification', () => {
    const src = [
      'export const tool = {',
      '  // sql-snippet-justified:',
      `  description: 'run ${SQL}',`,
      '};',
    ].join('\n');
    expect(classify(TS, src, 3)).toEqual({ table: 'work_items' });
  });
});

describe('detectionText', () => {
  it('masks comments for .ts, LENGTH-PRESERVING so every offset addresses raw and masked alike', () => {
    const src = "const a = 1; // don't\nconst b = 'keep me';\n";
    const out = detectionText('x/y.ts', src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain("don't");
    // Strings survive: the token this guard reads IS a string literal, so a
    // string-masking stripper would take the whole guard silently inert.
    expect(out).toContain('keep me');
  });

  it('leaves prose surfaces untouched — a TS parser would blank the tail of a URL', () => {
    const src = 'See https://example.com/x for the queue query.\n';
    expect(detectionText('docs/x.mdx', src)).toBe(src);
    expect(detectionText('prompts/x.md', src)).toBe(src);
  });
});

describe('guidanceRegions', () => {
  it('finds both a description literal and a guidance object', () => {
    const src = ["export const t = {", "  description: 'blurb',", '  guidance: { when: 1 },', '};'].join('\n');
    expect(guidanceRegions(src)).toHaveLength(2);
  });
});

describe('import safety', () => {
  it('importing the guard does not run the scan (the module has a RUN_AS_MAIN guard)', () => {
    // Reaching this assertion at all IS the test: without the entrypoint guard the
    // import would shell out to `git grep` and call process.exit(), killing the worker.
    expect(typeof classifyHit).toBe('function');
  });
});
