import { describe, expect, it } from 'vitest';
import { encode } from '@papercusp/result-encoding';
import { normalizeResultText } from '../../../scripts/su-mcp';

describe('su-mcp result normalization', () => {
  it('decodes a self-identifying TOON body to compact JSON', () => {
    const value = {
      ok: true,
      rows: [{ id: 'peer-1', count: 3 }],
      nextCursor: null,
    };
    const text = `format: toon\n${encode(value, 'toon')}`;

    expect(normalizeResultText(text)).toBe(JSON.stringify(value));
  });

  it('normalizes an unmarked JSON body through the lossless decoder', () => {
    expect(normalizeResultText('{ "ok": true, "count": 2 }')).toBe('{"ok":true,"count":2}');
  });

  it.each([
    ['csv', 'format: csv\nid,count\npeer-1,3'],
    ['tsv', 'format: tsv\nid\tcount\npeer-1\t3'],
    ['md', 'format: md\n| id | count |\n| --- | --- |\n| peer-1 | 3 |'],
  ])('leaves lossy/display-only %s output raw', (_format, text) => {
    expect(normalizeResultText(text)).toBe(text);
  });

  it('leaves malformed or unknown self-identifying output raw', () => {
    const malformed = 'format: toon\n[2]{id}:\n-';
    const unknown = 'format: yaml\nvalue: 1';

    expect(normalizeResultText(malformed)).toBe(malformed);
    expect(normalizeResultText(unknown)).toBe(unknown);
  });

  it('leaves ordinary non-JSON text raw', () => {
    expect(normalizeResultText('plain summary')).toBe('plain summary');
  });
});
