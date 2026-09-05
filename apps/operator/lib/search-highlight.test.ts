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
