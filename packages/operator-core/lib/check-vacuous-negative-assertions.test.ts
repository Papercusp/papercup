/**
 * Unit tests for `scripts/check-vacuous-negative-assertions.mjs` (EI-18765867705399052).
 *
 * The lint judges a NEGATIVE assertion by asking whether the literal it pins exists
 * anywhere the system could emit it. Every discriminator below was a LIVE false positive
 * on the first sweep of this repo, so each one is pinned here rather than described.
 *
 * The load-bearing case is `flags the motivating instance` — replayed from the real
 * pre-fix commit, the judge flags that assertion and only that assertion. A detector for
 * a class that cannot demonstrate it catches the instance the class was named for is
 * exactly the vacuous guard it exists to prevent.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs lint script, no type declarations
import {
  driftFragment,
  extractNegativeLiterals,
  judgeFile,
  proseShaped,
  regexSourceToLiteral,
} from '../../../scripts/check-vacuous-negative-assertions.mjs';

/** A judge bound to a synthetic "source tree". */
const judge = (text: string, corpus: string) =>
  judgeFile({ file: 't.test.ts', text, includes: (s: string) => corpus.includes(s) }).findings;

describe('regexSourceToLiteral — only plain literals are judgeable', () => {
  it('unescapes punctuation escapes into the literal they encode', () => {
    expect(regexSourceToLiteral('a\\.b \\(c\\)')).toBe('a.b (c)');
  });

  it('refuses a pattern with real regex power — a class, a quantifier, alternation', () => {
    // "does this exact string exist" is a meaningless question for these, so they are
    // never judged at all rather than judged wrongly.
    expect(regexSourceToLiteral('EXCLUDED \\d+ commit')).toBeNull();
    expect(regexSourceToLiteral('a|b')).toBeNull();
    expect(regexSourceToLiteral('colou?r')).toBeNull();
    expect(regexSourceToLiteral('[Ww]arn')).toBeNull();
  });
});

describe('extractNegativeLiterals', () => {
  it('reads regex, string and template forms, and skips interpolation', () => {
    const text = [
      `expect(a).not.toMatch(/plain banner text/);`,
      `expect(a).not.toContain('some phrase here');`,
      "expect(a).not.toContain(`a template phrase`);",
      'expect(a).not.toContain(`built ${x} at runtime`);',
    ].join('\n');
    expect(extractNegativeLiterals(text).map((n) => n.lit)).toEqual([
      'plain banner text',
      'some phrase here',
      'a template phrase',
    ]);
  });
});

describe('driftFragment — grows the match so the residue is honest', () => {
  const inc = (corpus: string) => (s: string) => corpus.includes(s);

  it('returns the MAXIMAL contiguous fragment, not the threshold-length window', () => {
    // Un-grown, the residue would falsely include characters the source does have.
    const r = driftFragment('⚠ quiet-cut EXCLUDED', inc('note += " quiet-cut EXCLUDED now";'));
    expect(r?.fragment).toBe(' quiet-cut EXCLUDED');
    expect(r?.residue).toEqual(['⚠', '']);
  });

  it('is null when nothing substantial of the literal survives in the source', () => {
    expect(driftFragment('a totally removed phrase', inc('unrelated source text'))).toBeNull();
  });
});

describe('proseShaped — what the GATE is narrowed to', () => {
  it('accepts multi-word wording that interpolation cannot produce', () => {
    expect(proseShaped('⚠ quiet-cut EXCLUDED')).toBe(true);
    expect(proseShaped('the old deflecting note')).toBe(true);
  });

  it('rejects values, single tokens and punctuation-heavy shapes', () => {
    expect(proseShaped('SKIP_FROMREPO="${SKIP_FROMREPO:-0}"')).toBe(false); // a value pin
    expect(proseShaped('pc-advconv__viewtabs')).toBe(false); // one token
    expect(proseShaped('(subpath "/p")')).toBe(false); // fixture-composed
    expect(proseShaped('two words')).toBe(false); // too short / too few words
  });
});

describe('judgeFile — the motivating instance', () => {
  // Verbatim from the pre-fix `checkpoint-run.test.ts`, with the source reworded exactly
  // as it was: the banner lost its `⚠` decoration, so the regex could no longer match
  // anything the tool was capable of emitting — and the test still went green.
  const text = [
    `it('no exclusion warning when the quiet-cut judged the tip directly', () => {`,
    `  expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);`,
    `});`,
  ].join('\n');

  it('flags it as DRIFTED and names the wording the source actually has', () => {
    const found = judge(text, 'const note = `quiet-cut EXCLUDED ${n} commit(s) … they get the NEXT run`;');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      line: 2,
      verdict: 'DRIFTED',
      lit: '⚠ quiet-cut EXCLUDED',
      fragment: 'quiet-cut EXCLUDED',
    });
  });

  it('stays silent once the assertion is re-pointed at the current wording', () => {
    const fixed = text.replace('⚠ quiet-cut EXCLUDED', 'quiet-cut EXCLUDED');
    expect(judge(fixed, 'const note = `quiet-cut EXCLUDED ${n} commit(s)`;')).toEqual([]);
  });
});

describe('judgeFile — the false positives that must stay silent', () => {
  const wrap = (assertion: string, extra = '') => `it('x', () => {\n  ${assertion}\n${extra}\n});`;

  it('the literal is in the source — the guard can still fail', () => {
    expect(judge(wrap(`expect(a).not.toContain('the old deflecting note');`), 'x = "the old deflecting note";')).toEqual([]);
  });

  it('the TEST builds the string as a fixture — nothing in the source needs it', () => {
    const text = wrap(
      `expect(out).not.toContain('old state line here');`,
      `  const body = 'old state line here';`,
    );
    expect(judge(text, 'unrelated source')).toEqual([]);
  });

  it('a "no extra suffix" guard over a string the same file asserts POSITIVELY', () => {
    const text = wrap(
      `expect(out).toContain('title → First title (scoper)');`,
      `  expect(out).not.toContain('title → First title (scoper) →');`,
    );
    expect(judge(text, 'unrelated source')).toEqual([]);
  });

  it('a runtime-COMPOSED string: the template is in the source, the value in the test', () => {
    // `--workspace=` + an interpolated value. The residue (`null`) is supplied by the
    // test, which is the signature of composition — and a perfectly falsifiable guard.
    const text = wrap(
      `expect(argv).not.toContain('--workspace=null');`,
      `  const ws = null;`,
    );
    expect(judge(text, 'argv.push(`--workspace=${workspace}`);')).toEqual([]);
  });

  it('a literal shorter than the floor is never judged — absence proves nothing', () => {
    expect(judge(wrap(`expect(a).not.toContain('nope');`), 'unrelated')).toEqual([]);
  });
});

describe('judgeFile — ORPHANED does not gate', () => {
  it('a deliberate "this phrasing is gone for good" ratchet is reported, not failed', () => {
    // Nothing resembling it survives anywhere, so it is a stable historical ratchet
    // rather than a guard pinned to a string that drifted.
    const found = judge(`it('x', () => {\n  expect(p).not.toContain('the old deflecting note');\n});`, 'entirely unrelated source');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ verdict: 'ORPHANED', fragment: null });
  });

  it('a VALUE pin lands in the non-gating bucket even when the source has the template', () => {
    const found = judge(
      `it('x', () => {\n  expect(s).not.toMatch(/PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=9900/);\n});`,
      'export const FLAG = `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=${mb}`;',
    );
    expect(found.map((f) => f.verdict)).toEqual(['ORPHANED']);
  });
});

describe('judgeFile — suppression', () => {
  const corpus = 'const note = `quiet-cut EXCLUDED ${n} commits`;';
  const assertion = `  expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);`;

  it('honours the pragma on the assertion line', () => {
    const text = `it('x', () => {\n${assertion} // vacuous-negative-ok: deliberate\n});`;
    expect(judge(text, corpus)).toEqual([]);
  });

  it('honours the pragma anywhere in the comment block directly above', () => {
    // A real exemption needs a real reason, and a real reason runs to several lines —
    // requiring the token on exactly the preceding line punishes writing one.
    const text = [
      `it('x', () => {`,
      `  // The banner was removed deliberately in WI-1234 and must never return.`,
      `  // vacuous-negative-ok: historical ratchet, the wording is gone for good`,
      assertion,
      `});`,
    ].join('\n');
    expect(judge(text, corpus)).toEqual([]);
  });

  it('does NOT let a pragma leak across a blank line or a statement', () => {
    const text = [
      `it('x', () => {`,
      `  // vacuous-negative-ok: this comment belongs to the line below it`,
      `  const unrelated = 1;`,
      assertion,
      `});`,
    ].join('\n');
    expect(judge(text, corpus)).toHaveLength(1);
  });
});
