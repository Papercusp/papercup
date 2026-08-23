/**
 * `htmlToText` / `decodeHtmlEntities`.
 *
 * The interesting content here is the entity decoder, and specifically that it
 * decodes in ONE pass. The successive-replacement implementation this replaced
 * is kept below as a permanent control: it is not a hypothetical bug, it is the
 * code that shipped, and the control exists so that "we decode entities once"
 * stays a proven property rather than a comment.
 *
 * A control is only a control while the broken version and the real one still
 * DISAGREE about its subject. If `legacySuccessiveDecode` ever starts agreeing
 * with `decodeHtmlEntities` on these inputs, that means the inputs stopped
 * exercising the property — fix the inputs, do not delete the control.
 */
import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, htmlToText } from './html-to-text';

/**
 * The previous implementation, verbatim in shape: numeric entities first, then
 * each named entity in turn, each pass re-scanning the previous pass's output.
 */
function legacySuccessiveDecode(input: string): string {
  const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  let s = input;
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
  return s;
}

describe('decodeHtmlEntities — one pass, never successive replacement', () => {
  it('decodes each entity exactly once', () => {
    expect(decodeHtmlEntities('&lt;b&gt; &amp; &quot;q&quot; &apos;a&apos;')).toBe(`<b> & "q" 'a'`);
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an ALREADY-ESCAPED entity as literal text instead of inventing markup', () => {
    // Someone writing ABOUT a script tag escapes the ampersand, so the wire
    // carries `&amp;lt;`. Decoded once that is the four characters `&lt;`.
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    // The same trap through the numeric door — which is why reordering the
    // named entities would not have been a fix.
    expect(decodeHtmlEntities('&#38;lt;script&#38;gt;')).toBe('&lt;script&gt;');
  });

  it('CONTROL: the successive-replacement implementation invents markup on both inputs', () => {
    // If either of these ever equals the escaped form, the control has gone
    // stale and is no longer testing anything.
    expect(legacySuccessiveDecode('&amp;lt;script&amp;gt;')).toBe('<script>');
    expect(legacySuccessiveDecode('&#38;lt;script&#38;gt;')).toBe('<script>');
    expect(legacySuccessiveDecode('&amp;lt;script&amp;gt;')).not.toBe(
      decodeHtmlEntities('&amp;lt;script&amp;gt;'),
    );
  });

  it('CALIBRATION: the two implementations agree on entities that are not doubly-escaped', () => {
    // Without this, the controls above would also pass if `decodeHtmlEntities`
    // were broken in some entirely different way (say, decoding nothing).
    for (const input of ['&lt;b&gt;', '&#65;&#66;', 'plain text', 'a &amp; b']) {
      expect(decodeHtmlEntities(input)).toBe(legacySuccessiveDecode(input));
    }
  });

  it('leaves an unrecognized or malformed entity verbatim rather than dropping it', () => {
    expect(decodeHtmlEntities('&zzz; &notanentity AT&T; 100&#x110000;')).toBe(
      '&zzz; &notanentity AT&T; 100&#x110000;',
    );
  });
});

describe('htmlToText — reduction, not sanitization', () => {
  it('drops script/style bodies and turns block structure into newlines', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToText('a<br>b')).toBe('a\nb');
    expect(htmlToText('<style>.x{}</style><p>visible</p>')).toBe('visible');
  });

  it('reduces a Mastodon-shaped status body', () => {
    const content = '<p>hello <a href="https://example.test">world</a> &amp; goodbye</p>';
    expect(htmlToText(content)).toBe('hello world & goodbye');
  });

  it('does not re-decode an escaped entity in a status body', () => {
    expect(htmlToText('<p>the &amp;lt;b&amp;gt; tag</p>')).toBe('the &lt;b&gt; tag');
  });
});
