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

/**
 * The verdict block (stats + notes) is identified by its `[projection:` stats
 * marker, NOT by position: a DEGRADED verdict renders as a HEADER (first item,
 * so head-keeping truncation downstream cannot silence it) while a clean one
 * stays a tail footer — EI-20720054720826414. Position-blind helpers are what
 * let these tests assert content without hard-coding either placement; the
 * placement itself is asserted explicitly in its own describe block below.
 */
const textsOf = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
const isVerdictText = (t: string) => t.includes('[projection:');
const bodyText = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  textsOf(r).find((t) => !isVerdictText(t)) ?? '';
const footerOf = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  textsOf(r).find(isVerdictText) ?? '';
const reportOf = (r: { content?: unknown; _meta?: Record<string, unknown> }) =>
  r._meta?.resultProjection as {
    applied: boolean;
    notes: string[];
    linesIn: number;
    linesOut: number;
    regexFlavor?: string;
  };

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

  it('finds the JSON PAYLOAD item when advisory prose follows it (the live work_items:list shape)', () => {
    // Structured results are routinely two text items: the payload, then a
    // "See also:" routing hint. Joining them makes the whole thing unparseable,
    // so a naive parse reports "not JSON" against a body that visibly starts
    // `[{"id":…`. This is the shape that broke it live.
    const multi = {
      content: [
        { type: 'text' as const, text: JSON.stringify([{ id: 'WI-1', state: 'open', bulk: 'x'.repeat(500) }]) },
        { type: 'text' as const, text: 'See also: work_items:claimable (…routing hint…)' },
      ],
    };
    const out = applyResultProjection(multi, spec({ pick: ['[].id'] }));
    expect(JSON.parse(bodyText(out))).toEqual([{ id: 'WI-1' }]);
    expect(footerOf(out)).toContain('advisory text item(s)');
    expect(bodyText(out)).not.toContain('See also');
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
  it('SKIPS a genuine delta ENVELOPE: reshaping it would corrupt the client-side parse', () => {
    const delta = {
      content: [{ type: 'text' as const, text: '{"delta":1}' }],
      _meta: { delta: { mode: 'delta', seq: 1 } },
    };
    const out = applyResultProjection(delta, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.content).toEqual(delta.content); // body untouched — no footer appended
    expect(reportOf(out)).toMatchObject({ applied: false });
    expect(reportOf(out).notes.join(' ')).toContain('delta');
  });

  it('still PROJECTS a delta-CAPABLE result whose body is normal (mode:"full")', () => {
    // Regression guard for the bug that live verification caught and every unit
    // test missed: every delta-capable tool stamps `_meta.delta` on ORDINARY
    // responses to advertise the capability and carry a cursor. Skipping on the
    // block's mere presence silently disabled the whole stage for every list
    // tool in the catalog. `mode` is the discriminator, not presence.
    const capable = {
      content: [{ type: 'text' as const, text: 'a\nb\nc' }],
      _meta: { delta: { mode: 'full', reason: 'no_request', itemKeyField: 'id' } },
    };
    const out = applyResultProjection(capable, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(bodyText(out)).toBe('a');
    expect(reportOf(out)).toMatchObject({ applied: true });
  });

  it('projects a proxy-RECONSTRUCTED full body too — it is plain JSON rows, not a patch', () => {
    const reconstructed = {
      content: [{ type: 'text' as const, text: '[{"id":"a"},{"id":"b"}]' }],
      _meta: { delta: { mode: 'full', reason: 'proxy_reconstructed' }, deltaProxy: { reconstructedFull: true } },
    };
    const out = applyResultProjection(reconstructed, spec({ pick: ['[].id'] }));
    expect(JSON.parse(bodyText(out))).toEqual([{ id: 'a' }, { id: 'b' }]);
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

  // EI-19944567995100280: a grep-shaped projection against an ERROR envelope used
  // to run normally, reducing a real `invalid_input` failure to 0 lines / 0 chars
  // — reported by the door footer as "(100% saved)", indistinguishable from a
  // successful filter that matched nothing. The caller read the empty body as
  // "no results" three times before discovering the call had failed all along.
  it('BYPASSES projection entirely on an isError result — the error text survives untouched', () => {
    const errorResult = {
      isError: true,
      content: [
        { type: 'text' as const, text: 'invalid_input: invalid_args: order: Invalid option: expected one of "updated"|"created"|"slug"' },
      ],
    };
    const out = applyResultProjection(
      errorResult,
      spec({ pipe: [{ op: 'grep', pattern: 'gate|ownership|red|condition' }, { op: 'head', n: 25 }] }),
    );
    // Untouched: no footer appended, no lines dropped, the original error text intact.
    expect(out.content).toEqual(errorResult.content);
    expect(bodyText(out)).toContain('invalid_input');
    expect(reportOf(out)).toMatchObject({ applied: false, linesIn: 0, linesOut: 0 });
    expect(reportOf(out).notes.join(' ')).toMatch(/error/i);
  });

  it('still bypasses on isError even when a `pick` would have matched nothing (not just non-JSON text)', () => {
    const errorResult = {
      isError: true,
      content: [{ type: 'text' as const, text: '{"error":"not_found","id":"WI-1"}' }],
    };
    const out = applyResultProjection(errorResult, spec({ pick: ['results[].id'] }));
    expect(out.content).toEqual(errorResult.content);
    expect(reportOf(out).applied).toBe(false);
  });

  it('retains a semantic write failure outcome when pick names only success fields', () => {
    const failedWrite = { ok: false, id: 'WI-1', error: 'not_found' };
    const out = applyResultProjection(
      textResult(JSON.stringify(failedWrite)),
      spec({ pick: ['id'] }),
      { effect: 'write' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ id: 'WI-1', ok: false, error: 'not_found' });
    expect(footerOf(out)).toContain('write outcome retained implicitly');
  });

  it('retains top-level and per-row failure signals in a partial bulk write', () => {
    const partialWrite = {
      ok: true,
      results: [{ ok: false, id: 'WI-1', error: 'not_found' }],
      counts: { ok: 0, failed: 1 },
    };
    const out = applyResultProjection(
      textResult(JSON.stringify(partialWrite)),
      spec({ pick: ['results[].id'] }),
      { effect: 'write' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({
      ok: true,
      results: [{ id: 'WI-1', ok: false, error: 'not_found' }],
      counts: { ok: 0, failed: 1 },
    });
  });

  it('does not change read projection semantics', () => {
    const result = { ok: false, id: 'WI-1', error: 'not_found' };
    const out = applyResultProjection(
      textResult(JSON.stringify(result)),
      spec({ pick: ['id'] }),
      { effect: 'read' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ id: 'WI-1' });
  });
});

/**
 * EI-19361771982678588 — a filter must be honest about what it was ALLOWED to search.
 *
 * This stage runs after the tool's own payload-tier bounding, and the result-door's
 * upstream-truncation warning is only reached when the result still exceeds the door
 * budget (result-door.ts:160). So a projection that shrinks the body under that budget
 * suppresses the sole notice that the corpus was partial — and a zero-hit grep then
 * reads as "no such value exists". Live cost: a `grep` over a facts:list trimmed from
 * 40 rows to 4 reported `0 of 3 lines`; four matching rows existed.
 */
describe('applyResultProjection — upstream truncation is disclosed (EI-19361771982678588)', () => {
  const truncated = (text: string, omittedCount = 69) => ({
    content: [{ type: 'text' as const, text }],
    _meta: { payloadProjection: { truncated: true, tier: 'trimmed', omittedCount } },
  });

  it('a ZERO-hit filter over a truncated corpus says it is NOT evidence of absence', () => {
    const out = applyResultProjection(
      truncated('alpha\nbeta\ngamma'),
      spec({ pipe: [{ op: 'grep', pattern: 'p011' }] }),
      { toolName: 'facts:list' },
    );
    const footer = footerOf(out);
    // The footer is the copy the agent reads — _meta alone would not have stopped this.
    expect(footer).toContain('NOT evidence of absence');
    expect(footer).toContain('ALREADY TRUNCATED');
    expect(footer).toContain('69');
    expect(footer).toContain('tier=trimmed');
    expect(footer).toContain("payloadTier:'full'");
    expect(footer).toContain('facts:list');
    expect(reportOf(out).linesOut).toBe(0);
  });

  it('a NON-empty projection over a truncated corpus still warns, but more weakly', () => {
    const out = applyResultProjection(
      truncated('alpha\nbeta p011\ngamma'),
      spec({ pipe: [{ op: 'grep', pattern: 'p011' }] }),
      { toolName: 'facts:list' },
    );
    const footer = footerOf(out);
    expect(footer).toContain('RETAINED portion only');
    expect(footer).toContain('ALREADY TRUNCATED');
    // The strong absence claim belongs ONLY to the zero-hit case.
    expect(footer).not.toContain('NOT evidence of absence');
  });

  it('the warning fires for ANY projection, not just grep — head hides the tail the same way', () => {
    const out = applyResultProjection(
      truncated('a\nb\nc\nd'),
      spec({ pipe: [{ op: 'head', n: 1 }] }),
      { toolName: 'work_items:list' },
    );
    expect(footerOf(out)).toContain('ALREADY TRUNCATED');
  });

  it('NO warning when the payload was never tier-truncated (no crying wolf)', () => {
    const out = applyResultProjection(
      textResult('alpha\nbeta'),
      spec({ pipe: [{ op: 'grep', pattern: 'nope' }] }),
      { toolName: 'facts:list' },
    );
    expect(footerOf(out)).not.toContain('ALREADY TRUNCATED');
    expect(reportOf(out).notes).toEqual([]);
  });

  it('NO warning when the marker is present but truncated is falsy', () => {
    const out = applyResultProjection(
      {
        content: [{ type: 'text' as const, text: 'alpha\nbeta' }],
        _meta: { payloadProjection: { truncated: false, tier: 'full', omittedCount: 0 } },
      },
      spec({ pipe: [{ op: 'grep', pattern: 'nope' }] }),
      { toolName: 'facts:list' },
    );
    expect(footerOf(out)).not.toContain('ALREADY TRUNCATED');
  });

  it('degrades gracefully when the marker omits its optional fields', () => {
    const out = applyResultProjection(
      { content: [{ type: 'text' as const, text: 'a' }], _meta: { payloadProjection: { truncated: true } } },
      spec({ pipe: [{ op: 'grep', pattern: 'zzz' }] }),
      {},
    );
    const footer = footerOf(out);
    expect(footer).toContain('NOT evidence of absence');
    expect(footer).toContain('tier=unknown');
    // No toolName supplied — the advice must still be actionable, never "undefined".
    expect(footer).not.toContain('undefined');
  });
});

/**
 * P-015 — the footer's ORDER, not its numbers.
 *
 * The defect: the footer led with "(97% saved)" and put every caveat behind it,
 * so a `pick` that silently dropped the field the caller came for was headlined
 * by a success statistic. These assert the caveat comes FIRST, and that the
 * statistic stops calling itself a saving when the body cannot be trusted.
 *
 * The CONTROLs are the load-bearing half: an honest reduction must still render
 * the plain "saved" wording, or this fix would just be a louder footer on every
 * result — which trains the same ignoring it set out to cure.
 */
describe('applyResultProjection — degraded results lead with the caveat (P-015)', () => {
  const JSON_BODY = JSON.stringify({
    results: [
      { id: 'a', state: 'open' },
      { id: 'b', state: 'shut' },
    ],
  });

  it('CONTROL: an honest pick — every path matched — keeps "saved" and leads with the stats', () => {
    const out = applyResultProjection(textResult(JSON_BODY), spec({ pick: ['results[].id'] }));
    const footer = footerOf(out);
    expect(footer).toContain('saved)');
    expect(footer).not.toContain('of the body removed');
    // Nothing precedes the stats block: the footer opens with it.
    expect(footer.trimStart().startsWith('[projection:')).toBe(true);
    expect(reportOf(out).notes).toEqual([]);
  });

  it('a PARTIAL pick miss puts the warning ahead of the statistic', () => {
    const out = applyResultProjection(
      textResult(JSON_BODY),
      spec({ pick: ['results[].id', 'results[].nosuchfield'] }),
    );
    const footer = footerOf(out);
    const warnAt = footer.indexOf('matched nothing');
    const statAt = footer.indexOf('[projection:');
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(statAt).toBeGreaterThanOrEqual(0);
    // THE ASSERTION THIS FIX EXISTS FOR: caveat before number, not after.
    expect(warnAt).toBeLessThan(statAt);
    expect(footer).toContain('results[].nosuchfield');
    expect(footer).toContain('ABSENT');
  });

  it('a degraded result never calls its reduction a "saving"', () => {
    const footer = footerOf(
      applyResultProjection(
        textResult(JSON_BODY),
        spec({ pick: ['results[].id', 'results[].nosuchfield'] }),
      ),
    );
    expect(footer).toContain('of the body removed');
    expect(footer).not.toContain('saved)');
  });

  it('an EMPTY body says so before anything else — it is not an absence', () => {
    const out = applyResultProjection(
      textResult(['alpha', 'beta', 'gamma'].join('\n')),
      spec({ pipe: [{ op: 'grep', pattern: 'nomatch-zzq' }] }),
    );
    const footer = footerOf(out);
    expect(footer.trimStart().startsWith('⚠ THIS PROJECTION REMOVED EVERYTHING')).toBe(true);
    expect(footer).toContain('Do not read it as an absence');
    expect(footer).toContain('of the body removed');
  });

  it('CONTROL: a genuinely empty INPUT is not accused of being a filter artifact', () => {
    // linesIn === 0, so there was nothing to remove — the empty-lead must stay silent.
    const footer = footerOf(
      applyResultProjection(textResult(''), spec({ pipe: [{ op: 'head', n: 5 }] })),
    );
    expect(footer).not.toContain('REMOVED EVERYTHING');
  });

  it('a non-degrading note (structuredContent dropped) stays BELOW the statistic', () => {
    const out = applyResultProjection(
      { content: [{ type: 'text' as const, text: JSON_BODY }], structuredContent: { big: true } },
      spec({ pick: ['results[].id'] }),
    );
    const footer = footerOf(out);
    const noteAt = footer.indexOf('structuredContent dropped');
    const statAt = footer.indexOf('[projection:');
    expect(noteAt).toBeGreaterThan(statAt);
    // It is not a trust warning, so the saving is still a saving.
    expect(footer).toContain('saved)');
  });

  it('_meta.notes still carries every note as flat strings (the report shape is unchanged)', () => {
    const out = applyResultProjection(
      { content: [{ type: 'text' as const, text: JSON_BODY }], structuredContent: { big: true } },
      spec({ pick: ['results[].id', 'results[].nope'] }),
    );
    const notes = reportOf(out).notes;
    expect(notes.every((n) => typeof n === 'string')).toBe(true);
    expect(notes.some((n) => n.includes('matched nothing'))).toBe(true);
    expect(notes.some((n) => n.includes('structuredContent dropped'))).toBe(true);
  });
});

/**
 * EI-20720054720826414 — the array-root miss, and its two teeth.
 *
 * The single most common pick failure is a bare `key` path against an ARRAY-root
 * body (the playbook's own examples were object-root only). Before this fix the
 * all-miss fail-open left the FULL promoted body in place — LARGER than the
 * un-projected default — which then overflowed the door and spilled, and the
 * miss warning lived in a tail footer that the door's head-keeping truncation
 * deleted. So: (1) a provably-matching `[].key` respelling is applied instead of
 * failing, and (2) a degraded verdict leads the content where truncation cannot
 * reach it. The CONTROLS pin the negative space: object-root picks are never
 * reinterpreted, and a clean reduction keeps its tail footer.
 */
describe('applyResultProjection — array-root pick repair (EI-20720054720826414)', () => {
  const ARRAY_BODY = JSON.stringify([
    { id: 'WI-1', title: 't1', noise: 'x'.repeat(100) },
    { id: 'WI-2', title: 't2', noise: 'y'.repeat(100) },
  ]);

  it('auto-adjusts a bare key to [].key when the body is an array — and says so', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['id', 'title'] }));
    expect(JSON.parse(bodyText(out))).toEqual([
      { id: 'WI-1', title: 't1' },
      { id: 'WI-2', title: 't2' },
    ]);
    const footer = footerOf(out);
    expect(footer).toContain('auto-adjusted');
    expect(footer).toContain('id → [].id');
    // The selection succeeded — a courtesy note, not a trust warning.
    expect(footer).toContain('saved)');
  });

  it('a repaired selection is NOT degraded: the verdict stays a tail footer', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['id'] }));
    const texts = textsOf(out);
    expect(isVerdictText(texts[texts.length - 1])).toBe(true);
    expect(isVerdictText(texts[0])).toBe(false);
  });

  it('does NOT repair a path that would still miss — the miss stays loud, and names the shape', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['zzz'] }));
    expect(JSON.parse(bodyText(out))).toHaveLength(2); // body left unprojected
    const footer = footerOf(out);
    expect(footer).toContain('matched NOTHING');
    expect(footer).toContain('an ARRAY of 2 element(s)');
    expect(footer).toContain('[].key');
  });

  it('CONTROL: never reinterprets a working path — an object-root pick is untouched by repair', () => {
    const objBody = JSON.stringify({ id: 'top', rows: [{ id: 'r1' }] });
    const out = applyResultProjection(textResult(objBody), spec({ pick: ['id'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ id: 'top' });
    expect(footerOf(out)).not.toContain('auto-adjusted');
  });

  it('mixed: repairs the missed spelling and keeps the already-correct one, correlated', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['[].id', 'title'] }));
    expect(JSON.parse(bodyText(out))).toEqual([
      { id: 'WI-1', title: 't1' },
      { id: 'WI-2', title: 't2' },
    ]);
    expect(footerOf(out)).toContain('title → [].title');
  });

  it('an all-miss on an OBJECT root names the object keys — the corrective hint, no repair', () => {
    const out = applyResultProjection(
      textResult(JSON.stringify({ results: [{ id: 'a' }], counts: { total: 1 } })),
      spec({ pick: ['nope.missing'] }),
    );
    const footer = footerOf(out);
    expect(footer).toContain('an OBJECT with key(s): results, counts');
  });
});

describe('applyResultProjection — a degraded verdict LEADS the content (EI-20720054720826414)', () => {
  it('degraded ⇒ the verdict is the FIRST content item, ahead of the body it warns about', () => {
    // The delivery guarantee this fix exists for: downstream doors keep the HEAD
    // of an oversized serialized result, so a warning behind the body is deleted
    // exactly when the body is oversized — the all-miss fail-open case.
    const out = applyResultProjection(textResult(JSON.stringify({ a: 1 })), spec({ pick: ['nope'] }));
    const texts = textsOf(out);
    expect(texts[0]).toContain('matched NOTHING');
    expect(isVerdictText(texts[0])).toBe(true);
  });

  it('CONTROL: a clean reduction keeps the verdict as the LAST item', () => {
    const out = applyResultProjection(
      textResult(JSON.stringify({ rows: [{ id: 'x' }] })),
      spec({ pick: ['rows[].id'] }),
    );
    const texts = textsOf(out);
    expect(isVerdictText(texts[0])).toBe(false);
    expect(isVerdictText(texts[texts.length - 1])).toBe(true);
  });
});
