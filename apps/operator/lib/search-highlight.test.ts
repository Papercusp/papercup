/**
 * `@/lib/search-highlight` — the one safe `ts_headline` renderer shared by the
 * agents-pill session search, the plan-session transcript results, and the
 * workspace search page (security-boundary-remediation-and-usability-2026-09-04
 * P-003).
 *
 * The first two cases moved here verbatim from `AgentsPillSessions.test.tsx`
 * when the function was extracted, so the mechanism's original guarantees are
 * still pinned by their original assertions rather than by a re-derivation.
 *
 * D-001 requires each item to show the hostile path failing AND the legitimate
 * path still working, so both halves are asserted throughout: markup is inert,
 * and `<mark>` highlighting survives.
 */
import { describe, expect, it } from 'vitest';
import { headlineToSafeHtml, hitDisplayHtml } from './search-highlight';

describe('headlineToSafeHtml', () => {
  it('escapes transcript HTML but restores the engine <mark> tags', () => {
    expect(headlineToSafeHtml('run <mark>deploy</mark> & <script>alert(1)</script>')).toBe(
      'run <mark>deploy</mark> &amp; &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('does not let a transcript smuggle a fake mark attribute through', () => {
    // Only the engine's bare `<mark>` survives; `<mark onx=...>` stays escaped.
    expect(headlineToSafeHtml('<mark onmouseover=alert(1)>x</mark>')).toBe(
      '&lt;mark onmouseover=alert(1)&gt;x</mark>',
    );
  });

  it('neutralises the injection vectors that do not need a <script> tag', () => {
    // The realistic hostile payload in a transcript corpus is an event handler
    // on an element that loads something, not a literal <script> — those are
    // the ones a naive "strip <script>" filter misses.
    for (const payload of [
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<a href="javascript:alert(1)">click</a>',
      '<body onpageshow=alert(1)>',
    ]) {
      const out = headlineToSafeHtml(payload);
      // No tag survives at all: every `<` became `&lt;`, so nothing can parse
      // as an element and no attribute can become a handler.
      expect(out).not.toMatch(/<(?!\/?mark>)/);
      expect(out.startsWith('&lt;')).toBe(true);
    }
  });

  it('escapes ampersands BEFORE angle brackets, so an entity cannot be re-formed', () => {
    // Order matters: if `<` were escaped first, the `&` in the resulting
    // `&lt;` would then be escaped again and the output would double-encode.
    // Conversely a corpus string that already reads `&lt;script&gt;` must stay
    // literal text rather than decoding into a live tag in the browser.
    expect(headlineToSafeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
    expect(headlineToSafeHtml('a & b')).toBe('a &amp; b');
  });

  it('keeps code and markup a user actually wants to READ visible as text', () => {
    // The capability D-001 says must survive: this surface exists to show
    // people their own transcripts, which are full of code.
    // Quotes are deliberately NOT escaped: this output only ever lands in an
    // element's child position, never inside an attribute value, so `"` cannot
    // break out of anything. Escaping it would just make quoted code ugly.
    expect(headlineToSafeHtml('const el = <Foo bar="1" />;')).toBe(
      'const el = &lt;Foo bar="1" /&gt;;',
    );
  });

  it('highlights every occurrence, not just the first', () => {
    // `replaceAll`, not `replace` — a headline with MaxFragments=2 routinely
    // carries several marked terms.
    expect(headlineToSafeHtml('<mark>a</mark> and <mark>b</mark>')).toBe(
      '<mark>a</mark> and <mark>b</mark>',
    );
  });

  it('is a no-op on text with nothing to escape or restore', () => {
    expect(headlineToSafeHtml('plain words')).toBe('plain words');
    expect(headlineToSafeHtml('')).toBe('');
  });
});

describe('hitDisplayHtml', () => {
  it('prefers the highlight and keeps its marks', () => {
    expect(hitDisplayHtml({ highlight: 'hel<mark>lo</mark>', excerpt: 'hello there' })).toBe(
      'hel<mark>lo</mark>',
    );
  });

  it('falls back to the excerpt when the highlight is empty — and escapes it too', () => {
    // A semantic-only hit has no marked term, and a hit whose source deferred
    // highlight hydration (WI-4734) can arrive with ''. The fallback arm is
    // raw document head with no engine post-processing, so it needs the
    // escaper at least as much as the highlight arm does.
    expect(hitDisplayHtml({ highlight: '', excerpt: '<img src=x onerror=alert(1)>' })).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('tolerates missing/null fields rather than rendering "undefined"', () => {
    expect(hitDisplayHtml({})).toBe('');
    expect(hitDisplayHtml({ highlight: null, excerpt: null })).toBe('');
    expect(hitDisplayHtml({ highlight: null, excerpt: 'only excerpt' })).toBe('only excerpt');
  });
});

/**
 * FALSIFIABILITY CONTROLS — proof that the assertions above have teeth against
 * the SHIPPED `headlineToSafeHtml`, not merely against themselves.
 *
 * WHY THIS BLOCK EXISTS. The original falsifiability evidence for this
 * mechanism was an out-of-tree probe (`/tmp/wi2144848-probe/probe.mjs`) that
 * hand-copied the escaper inline — `const escape = (h) => h.replaceAll(...)` —
 * and labelled it "the shipped escaper". It never imported this module, so
 * mutating it proved a COPY was falsifiable and established nothing about
 * `headlineToSafeHtml`. Grading audit EI-22385441244195816 rated that binding
 * `re-runnable-evidence = FAIL`, and it was right. The probe was also
 * session-local: a `/tmp` path that dies with the box and carries no
 * fingerprint of its own.
 *
 * WHY THE CONTROLS LIVE HERE rather than in a mutation probe. `CLAUDE.md`
 * ("Proving a guard is falsifiable") routes a MODULE you `import` to a
 * deliberately-wrong implementation kept permanently in the test file, never to
 * mutating production code. The repo's copy-out tier needs the subject path to
 * be injectable (`--test '… {}'`); these cases import `./search-highlight` by
 * relative specifier, so there is no path to substitute and copy-out cannot
 * reach them.
 *
 * Each control is a plausible-but-wrong escaper — the two ways this actually
 * gets written by hand — and each must FAIL a vector the shipped function
 * neutralises. The CALIBRATION case asserts the shipped function PASSES that
 * same battery, so the controls cannot be passing merely because the property
 * itself is broken.
 */
describe('headlineToSafeHtml falsifiability controls', () => {
  const IMG_VECTOR = 'the <mark>deploy</mark> ran <img src=x onerror="alert(1)">';
  const FAKE_MARK_VECTOR = 'a <mark onmouseover="alert(1)">hostile</mark> mark';

  const hasLiveImgTag = (html: string) => /<img/i.test(html);
  const hasLiveMarkWithAttribute = (html: string) => /<mark\s+[^>]/i.test(html);
  const openMarkCount = (html: string) => (html.match(/<mark>/g) ?? []).length;

  /** CONTROL A — the classic naive filter: strip `<script>`, pass everything else. */
  const stripScriptOnly = (headline: string): string =>
    headline.replace(/<script[\s\S]*?<\/script>/gi, '');

  /**
   * CONTROL B — right pieces, WRONG ORDER: hold the engine's `<mark>` tags out
   * of the escape pass and restore them verbatim. This is the inversion
   * `search-highlight.ts` warns about in its own header: the regex meant to
   * protect the delimiter also matches the attacker's tag, so a hostile
   * `<mark onmouseover=…>` is preserved instead of escaped.
   */
  const permissiveMarkRestore = (headline: string): string =>
    headline
      .split(/(<\/?mark[^>]*>)/gi)
      .map((piece, index) =>
        index % 2 === 1
          ? piece
          : piece.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      )
      .join('');

  it('CALIBRATION: the shipped escaper passes the whole battery the controls must fail', () => {
    const img = headlineToSafeHtml(IMG_VECTOR);
    expect(hasLiveImgTag(img)).toBe(false);
    expect(openMarkCount(img)).toBe(1);

    const fakeMark = headlineToSafeHtml(FAKE_MARK_VECTOR);
    expect(hasLiveMarkWithAttribute(fakeMark)).toBe(false);
  });

  it('CONTROL A (strip-<script>-only) lets through the img vector the shipped escaper kills', () => {
    expect(hasLiveImgTag(stripScriptOnly(IMG_VECTOR))).toBe(true);
    expect(hasLiveImgTag(headlineToSafeHtml(IMG_VECTOR))).toBe(false);
  });

  it('CONTROL B (restore-marks-by-regex) lets through the attribute vector the shipped escaper kills', () => {
    expect(hasLiveMarkWithAttribute(permissiveMarkRestore(FAKE_MARK_VECTOR))).toBe(true);
    expect(hasLiveMarkWithAttribute(headlineToSafeHtml(FAKE_MARK_VECTOR))).toBe(false);
  });
});
