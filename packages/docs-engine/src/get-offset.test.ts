/**
 * getDocs paging — reading a doc that is LARGER than the payload cap.
 *
 * EI-21940075757786953. `docs:get` clips a page at MAX_PAYLOAD_BYTES while still
 * returning `found:true`, and `docs:author` takes a FULL replacement body — so the
 * documented read→edit→write pipeline deleted 63% of `testing/agent-e2e` (50,141
 * of 137,030 chars). The write side now REFUSES such a body; this file covers the
 * other half, without which that refusal would be a dead end: `offset` +
 * `nextOffset` are the supported way to read a large page whole.
 *
 * The load-bearing assertion is the round trip — paging must reassemble the doc
 * BYTE FOR BYTE. It is also the falsifiability control: an `offset` that were
 * silently ignored would return window 1 three times and fail here, rather than
 * looking like a short document.
 */

import { describe, expect, it } from 'vitest';
import { getDocs } from './get';
import { MAX_PAYLOAD_BYTES } from './shared';
import type { DocPage, DocSource } from './index';

/** A doc source with one page whose body is exactly `body`. */
function oneDoc(slug: string, body: string): DocSource {
  const page: DocPage = { slug, slugs: slug.split('/'), url: `/${slug}`, title: slug, toc: [] };
  return {
    name: 'test-source',
    listPages: async () => [page],
    getPage: async (s) => (s === slug ? page : null),
    getContent: async () => body,
  };
}

/** A body of `n` chars whose every position is identifiable, so a mis-slice cannot hide. */
const rulerBody = (n: number): string => {
  let out = '';
  for (let i = 0; out.length < n; i += 1) out += `${i}|`;
  return out.slice(0, n);
};

/** Strip the truncation tail the engine appends to a clipped window. */
const windowContent = (content: string, clipped: boolean): string =>
  clipped ? content.slice(0, MAX_PAYLOAD_BYTES) : content;

describe('getDocs offset paging', () => {
  const TOTAL = MAX_PAYLOAD_BYTES * 2 + 1_234;
  const body = rulerBody(TOTAL);
  const src = oneDoc('big/page', body);

  it('reassembles the WHOLE document byte for byte across windows', async () => {
    let offset = 0;
    let assembled = '';
    let windows = 0;
    for (;;) {
      const res = await getDocs(src, { slugs: ['big/page'], offset });
      const entry = res.results[0];
      expect(entry.found).toBe(true);
      if (!entry.found) return;
      windows += 1;
      expect(windows).toBeLessThanOrEqual(10); // a non-advancing offset must fail, not spin
      assembled += windowContent(entry.content, entry.truncated === true);
      if (entry.nextOffset === undefined) break;
      expect(entry.nextOffset).toBeGreaterThan(offset);
      offset = entry.nextOffset;
    }
    expect(windows).toBe(3);
    expect(assembled).toBe(body);
    expect(assembled.length).toBe(TOTAL);
  });

  it('a single unpaged read gets only the first window — the failure this closes', async () => {
    // Calibration: without it, a paging implementation that returned the whole doc
    // in one shot would pass the round trip above and hide that the cap still bites.
    const res = await getDocs(src, { slugs: ['big/page'] });
    const entry = res.results[0];
    if (!entry.found) throw new Error('expected found');
    expect(entry.truncated).toBe(true);
    expect(entry.nextOffset).toBe(MAX_PAYLOAD_BYTES);
    expect(windowContent(entry.content, true).length).toBe(MAX_PAYLOAD_BYTES);
    expect(windowContent(entry.content, true)).not.toBe(body);
  });

  it('reports total `bytes` on every window, not the window size', async () => {
    for (const offset of [0, MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES * 2]) {
      const res = await getDocs(src, { slugs: ['big/page'], offset });
      const entry = res.results[0];
      if (!entry.found) throw new Error('expected found');
      expect(entry.bytes).toBe(TOTAL);
    }
  });

  it('omits nextOffset on the LAST window — absence is the end-of-document signal', async () => {
    const res = await getDocs(src, { slugs: ['big/page'], offset: MAX_PAYLOAD_BYTES * 2 });
    const entry = res.results[0];
    if (!entry.found) throw new Error('expected found');
    expect(entry.truncated).toBeUndefined();
    expect(entry.nextOffset).toBeUndefined();
    expect(entry.offset).toBe(MAX_PAYLOAD_BYTES * 2);
    expect(entry.content).toBe(body.slice(MAX_PAYLOAD_BYTES * 2));
  });

  it('an offset past the end returns empty, never a wrap-around', async () => {
    const res = await getDocs(src, { slugs: ['big/page'], offset: TOTAL + 5_000 });
    const entry = res.results[0];
    if (!entry.found) throw new Error('expected found');
    expect(entry.content).toBe('');
    expect(entry.nextOffset).toBeUndefined();
    expect(entry.bytes).toBe(TOTAL);
  });

  it('leaves an unpaged read shape untouched (no offset/nextOffset keys)', async () => {
    const small = oneDoc('small/page', '# Small\n\nbody');
    const res = await getDocs(small, { slugs: ['small/page'] });
    const entry = res.results[0];
    if (!entry.found) throw new Error('expected found');
    expect(entry).not.toHaveProperty('offset');
    expect(entry).not.toHaveProperty('nextOffset');
    expect(entry.content).toBe('# Small\n\nbody');
  });

  it('ignores offset on a BATCH — a batch has no single stream to be an offset into', async () => {
    // The tool schema refuses this outright; the engine must still not mis-slice
    // one member of the batch if a direct caller passes it.
    const two: DocSource = {
      name: 'two',
      listPages: async () => [
        { slug: 'a', slugs: ['a'], url: '/a', title: 'a', toc: [] },
        { slug: 'b', slugs: ['b'], url: '/b', title: 'b', toc: [] },
      ],
      getPage: async (s) => ({ slug: s, slugs: [s], url: `/${s}`, title: s, toc: [] }),
      getContent: async (p) => `body-${p.slug}`,
    };
    const res = await getDocs(two, { slugs: ['a', 'b'], offset: 3 });
    for (const entry of res.results) {
      if (!entry.found) throw new Error('expected found');
      expect(entry.content).toBe(`body-${entry.slug}`);
      expect(entry).not.toHaveProperty('offset');
    }
  });

  it('treats a negative or non-finite offset as no offset', async () => {
    for (const offset of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await getDocs(src, { slugs: ['big/page'], offset });
      const entry = res.results[0];
      if (!entry.found) throw new Error('expected found');
      expect(entry.offset).toBeUndefined();
      expect(entry.nextOffset).toBe(MAX_PAYLOAD_BYTES);
    }
  });

  it('names the resume offset in the truncation tail, so the exit is in the payload', async () => {
    const res = await getDocs(src, { slugs: ['big/page'] });
    const entry = res.results[0];
    if (!entry.found) throw new Error('expected found');
    expect(entry.content).toContain(`offset=${MAX_PAYLOAD_BYTES}`);
  });
});
