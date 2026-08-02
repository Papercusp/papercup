/**
 * apply.ts — the fail-OPEN half.
 *
 * Two things are asserted harder than the rest, because they are what makes the
 * stage safe to auto-substitute into (P-021/P-022):
 *   1. operator semantics MATCH the coreutils they stand in for (adjacent-only
 *      uniq, cut's non-delimited passthrough, grep's `--` group separator);
 *   2. a projection that does not fit is LOUD — the reason reaches the in-band
 *      footer, not just _meta, because the footer is what the agent reads.
 */

import { describe, expect, it } from 'vitest';
import { applyPick, applyResultProjection, parsePickPath } from './apply';
import { parseProjection } from './parse';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/** Parse through the real validator so a test can never assert on a spec the parser would reject. */
function spec(raw: unknown) {
  const r = parseProjection(raw);
  if (!r.ok) throw new Error(`fixture spec rejected by parser: ${r.error}`);
  return r.spec;
}

const bodyText = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  (r.content.find((c) => c.type === 'text')?.text ?? '');
const footerOf = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  (r.content[r.content.length - 1]?.text ?? '');
const reportOf = (r: { _meta?: Record<string, unknown> }) =>
  r._meta?.resultProjection as { notes: string[]; linesIn: number; linesOut: number; regexFlavor?: string };

describe('applyResultProjection — line operators', () => {
  const LINES = ['alpha 3', 'beta 1', 'ERROR here', 'gamma 2', 'error again', 'delta 10'].join('\n');

  it('no spec returns the very same object (identity, not a copy)', () => {
    const r = textResult('x');
    expect(applyResultProjection(r, null)).toBe(r);
  });

  it('grep filters, and -i is honored', () => {
    const out = applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'grep', pattern: 'error', ignoreCase: true }] }));
    expect(bodyText(out)).toBe('ERROR here\nerror again');
  });

  it('grep -v inverts', () => {
    // 'alpha 3' and 'gamma 2' are the two lines with no 'e' in them.
    const out = applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'grep', pattern: 'e', invert: true }] }));
    expect(bodyText(out)).toBe('alpha 3\ngamma 2');
  });

  it('grep -F matches a literal that would otherwise be a regex', () => {
    const out = applyResultProjection(
      textResult(['a.c', 'abc'].join('\n')),
      spec({ pipe: [{ op: 'grep', pattern: 'a.c', fixed: true }] }),
    );
    expect(bodyText(out)).toBe('a.c');
  });

  it('grep context emits GNU’s `--` between NON-contiguous groups only', () => {
    const lines = ['1', 'HIT', '3', '4', '5', '6', 'HIT', '8'].join('\n');
    const out = applyResultProjection(textResult(lines), spec({ pipe: [{ op: 'grep', pattern: 'HIT', context: 1 }] }));
    expect(bodyText(out)).toBe(['1', 'HIT', '3', '--', '6', 'HIT', '8'].join('\n'));
  });

  it('grep context does NOT separate groups whose windows touch', () => {
    const lines = ['1', 'HIT', '3', 'HIT', '5'].join('\n');
    const out = applyResultProjection(textResult(lines), spec({ pipe: [{ op: 'grep', pattern: 'HIT', context: 1 }] }));
    expect(bodyText(out)).not.toContain('--');
  });

  it('head/tail slice, and tail 0 is empty (not "the whole thing")', () => {
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'head', n: 2 }] })))).toBe(
      'alpha 3\nbeta 1',
    );
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'tail', n: 2 }] })))).toBe(
      'error again\ndelta 10',
    );
    // `slice(-0)` is `slice(0)` — the whole array. The guard against that is the
    // difference between "no lines" and "every line".
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'tail', n: 0 }] })))).toBe('');
  });

  it('sort -n orders numerically, not lexically', () => {
    const nums = ['10', '9', '100'].join('\n');
    expect(bodyText(applyResultProjection(textResult(nums), spec({ pipe: [{ op: 'sort' }] })))).toBe('10\n100\n9');
    expect(bodyText(applyResultProjection(textResult(nums), spec({ pipe: [{ op: 'sort', numeric: true }] })))).toBe(
      '9\n10\n100',
    );
  });

  it('uniq collapses ADJACENT runs only — exactly like the binary', () => {
    const dup = ['a', 'a', 'b', 'a'].join('\n');
    expect(bodyText(applyResultProjection(textResult(dup), spec({ pipe: [{ op: 'uniq' }] })))).toBe('a\nb\na');
    // sort -u is the one that dedupes globally; conflating them silently drops rows.
    expect(bodyText(applyResultProjection(textResult(dup), spec({ pipe: [{ op: 'sort', unique: true }] })))).toBe('a\nb');
  });

  it('uniq -c uses the %7d column format', () => {
    const out = applyResultProjection(textResult(['a', 'a', 'b'].join('\n')), spec({ pipe: [{ op: 'uniq', count: true }] }));
    expect(bodyText(out)).toBe('      2 a\n      1 b');
  });

  it('cut passes NON-delimited lines through whole, unless -s', () => {
    const rows = ['a\tb\tc', 'nodelim', 'x\ty\tz'].join('\n');
    expect(bodyText(applyResultProjection(textResult(rows), spec({ pipe: [{ op: 'cut', fields: [1, 3] }] })))).toBe(
      'a\tc\nnodelim\nx\tz',
    );
    expect(
      bodyText(applyResultProjection(textResult(rows), spec({ pipe: [{ op: 'cut', fields: [1], onlyDelimited: true }] }))),
    ).toBe('a\nx');
  });

  it('count replaces the body with the line count (wc -l)', () => {
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'count' }] })))).toBe('6');
  });

  it('stages compose in order — the corpus shape grep | sort | uniq -c | head', () => {
    const log = ['e b', 'e a', 'x', 'e b', 'e a', 'e a'].join('\n');
    const out = applyResultProjection(
      textResult(log),
      spec({
        pipe: [
          { op: 'grep', pattern: '^e ' },
          { op: 'sort' },
          { op: 'uniq', count: true },
          { op: 'head', n: 1 },
        ],
      }),
    );
    expect(bodyText(out)).toBe('      3 e a');
  });
});

describe('applyResultProjection — reporting', () => {
  it('the footer states the pipeline, the reduction, and the regex flavor', () => {
    const out = applyResultProjection(
      textResult(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')),
      spec({ pipe: [{ op: 'grep', pattern: 'line 9$' }] }),
      { toolName: 'capability:bash_output' },
    );
    const footer = footerOf(out);
    expect(footer).toContain('grep "line 9$"');
    expect(footer).toContain('of 100 lines');
    // The flavor is DECLARED, never assumed — P-021's replay harness reads this.
    expect(footer).toContain('JavaScript RegExp');
    expect(reportOf(out).regexFlavor).toBe('js-regexp');
  });

  it('a fixed-string grep claims no regex flavor', () => {
    const out = applyResultProjection(textResult('a\nb'), spec({ pipe: [{ op: 'grep', pattern: 'a', fixed: true }] }));
    expect(reportOf(out).regexFlavor).toBeUndefined();
    expect(footerOf(out)).not.toContain('JavaScript RegExp');
  });

  it('counts lines in and out in _meta', () => {
    const out = applyResultProjection(textResult('a\nb\nc'), spec({ pipe: [{ op: 'head', n: 2 }] }));
    expect(reportOf(out)).toMatchObject({ applied: true, linesIn: 3, linesOut: 2 });
  });
});

describe('applyResultProjection — pick (structured, D-041 tier 3)', () => {
  const body = JSON.stringify({
    results: [
      { id: 'WI-1', state: 'open', payload: { big: 'x'.repeat(200) } },
      { id: 'WI-2', state: 'done', payload: { big: 'y'.repeat(200) } },
    ],
    counts: { total: 2 },
  });

  it('selects fields and drops the rest', () => {
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id', 'counts.total'] }));
    const parsed = JSON.parse(bodyText(out));
    expect(parsed).toEqual({ results: [{ id: 'WI-1' }, { id: 'WI-2' }], counts: { total: 2 } });
  });

  it('sibling paths stay CORRELATED on the same element, not two parallel arrays', () => {
    // A flat { path: value } map would return ids and states as separate arrays
    // the caller has to zip by position — and position is exactly the wrong key
    // to correlate a work-item list on (work_items:get says so explicitly).
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id', 'results[].state'] }));
    expect(JSON.parse(bodyText(out))).toEqual({
      results: [
        { id: 'WI-1', state: 'open' },
        { id: 'WI-2', state: 'done' },
      ],
    });
  });

  it('pick composes into pipe — the JSON is re-rendered as greppable lines', () => {
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['results[].id'], pipe: [{ op: 'grep', pattern: 'WI-2' }] }),
    );
    expect(bodyText(out).trim()).toBe('"id": "WI-2"');
  });

  it('a NON-JSON body fails OPEN, and the reason reaches the in-band footer', () => {
    const out = applyResultProjection(textResult('just some log text'), spec({ pick: ['a.b'] }));
    expect(bodyText(out)).toBe('just some log text');
    expect(reportOf(out).notes.join(' ')).toContain('not JSON');
    // _meta alone is not enough — the footer is the copy the agent reads.
    expect(footerOf(out)).toContain('not JSON');
  });

  it('paths that match NOTHING leave the body unprojected rather than returning {}', () => {
    const out = applyResultProjection(textResult(body), spec({ pick: ['nope.missing'] }));
    expect(JSON.parse(bodyText(out))).toHaveProperty('counts');
    expect(footerOf(out)).toContain('matched NOTHING');
  });

  it('a partially-matching pick reports the misses but still projects', () => {
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id', 'nope'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ results: [{ id: 'WI-1' }, { id: 'WI-2' }] });
    expect(footerOf(out)).toContain('nope');
  });
});

describe('parsePickPath / applyPick', () => {
  it('parses key, [] and [n] segments', () => {
    expect(parsePickPath('results[].payload.id')).toEqual([
      { kind: 'key', name: 'results' },
      { kind: 'array' },
      { kind: 'key', name: 'payload' },
      { kind: 'key', name: 'id' },
    ]);
    expect(parsePickPath('rows[0].id')).toEqual([
      { kind: 'key', name: 'rows' },
      { kind: 'index', i: 0 },
      { kind: 'key', name: 'id' },
    ]);
  });

  it('reports unmatched paths without throwing on a shape mismatch', () => {
    const { picked, unmatched } = applyPick({ a: 1 }, ['a', 'b[].c']);
    expect(picked).toEqual({ a: 1 });
    expect(unmatched).toEqual(['b[].c']);
  });
});

describe('applyResultProjection — safety contracts', () => {
  it('SKIPS a delta result: reshaping it would corrupt the client-side parse', () => {
    const delta = { content: [{ type: 'text' as const, text: '{"delta":1}' }], _meta: { delta: { seq: 1 } } };
    const out = applyResultProjection(delta, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.content).toEqual(delta.content); // body untouched — no footer appended
    expect(reportOf(out)).toMatchObject({ applied: false });
    expect(reportOf(out).notes.join(' ')).toContain('delta');
  });

  it('drops structuredContent — and says so in the footer, not only in _meta', () => {
    const withStructured = { ...textResult('a\nb\nc'), structuredContent: { everything: true } };
    const out = applyResultProjection(withStructured, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.structuredContent).toBeUndefined();
    expect(footerOf(out)).toContain('structuredContent dropped');
  });

  it('passes non-text content items through untouched', () => {
    const mixed = {
      content: [
        { type: 'text' as const, text: 'a\nb' },
        { type: 'image', data: 'zz' } as Record<string, unknown>,
      ],
    };
    const out = applyResultProjection(mixed, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.content).toContainEqual({ type: 'image', data: 'zz' });
  });

  it('fail-soft: a malformed result never becomes a failure', () => {
    const broken = { content: 'not-an-array' as unknown as [] };
    expect(applyResultProjection(broken, spec({ pipe: [{ op: 'head', n: 1 }] }))).toBe(broken);
  });

  it('an empty result body projects to empty without throwing', () => {
    const out = applyResultProjection(textResult(''), spec({ pipe: [{ op: 'grep', pattern: 'x' }] }));
    expect(bodyText(out)).toBe('');
    expect(reportOf(out)).toMatchObject({ linesIn: 0, linesOut: 0 });
  });
});
