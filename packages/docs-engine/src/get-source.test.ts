/**
 * getDocs `source: true` — the read that survives a round trip back to the writer.
 *
 * WI-1511581, residue of EI-21940075757786953. `docs:author { overwrite:true }`
 * takes a FULL replacement body, and until now the read that LOOKED like its source
 * — `docs:get` — was a lossy projection of the doc: frontmatter stripped, a
 * `# title` + `URL:` preamble PREPENDED, and `.mdx` flattened through
 * `renderMdxToMarkdown` (195 of 990 authored docs carry `import … from`, 218 carry
 * JSX). None of that is visible in the response, so an agent that read, edited and
 * wrote back corrupted the doc while every call reported success.
 *
 * The load-bearing property here is EXACTNESS, so every assertion below compares
 * against the byte-for-byte fixture rather than probing for a substring: a body that
 * is merely "close" is precisely the failure this mode closes.
 *
 * The falsifiability controls are the paired rendered-mode assertions. A `source`
 * flag that were silently ignored would return the rendered projection and fail
 * them; without the pair, a source mode that quietly aliased `getContent` would
 * look identical to one that works.
 */

import { describe, expect, it } from 'vitest';
import { getDocs } from './get';
import { hasTruncationTail, MAX_PAYLOAD_BYTES } from './shared';
import type { DocPage, DocSource, GetEntry } from './index';

/** The bytes an author edits: frontmatter, an import, and JSX the renderer flattens. */
const RAW = `---
title: Agent E2E
description: Drive the desktop headlessly
tags: [testing]
---

import { Aside } from '@astrojs/starlight/components';

## Attach

<Aside type="caution">Never point verdict at :3055.</Aside>

Body text.
`;

/**
 * What the READ surface serves for the same doc — shaped to match what
 * `renderMdxToMarkdown` + `withPreamble` measurably do (asserted against the real
 * pipeline in `__tests__/starlight-adapter.test.ts`; this file's source is a
 * fixture, so it must not teach a loss the renderer does not actually inflict):
 * frontmatter stripped, a `# title` + `URL:` header prepended, the JSX element
 * rewritten — and the `import` line left behind, now referencing a component that
 * appears nowhere.
 */
const RENDERED = `# Agent E2E
URL: /docs/testing/agent-e2e

Drive the desktop headlessly

import { Aside } from '@astrojs/starlight/components';

## Attach

Never point verdict at :3055.

Body text.
`;

const PAGE: DocPage = {
  slug: 'testing/agent-e2e',
  slugs: ['testing', 'agent-e2e'],
  url: '/docs/testing/agent-e2e',
  title: 'Agent E2E',
  description: 'Drive the desktop headlessly',
  toc: [{ id: 'attach', text: 'Attach', depth: 2 }],
};

interface SourceOpts {
  /** Omit `getSource` entirely — an adapter that cannot serve canonical text. */
  withoutGetSource?: boolean;
  /** `getSource` resolves null — this page has no retrievable source. */
  sourceNull?: boolean;
  raw?: string;
  rendered?: string;
  page?: DocPage;
}

function makeSource(opts: SourceOpts = {}): DocSource {
  const page = opts.page ?? PAGE;
  const base: DocSource = {
    name: 'fixture-source',
    listPages: async () => [page],
    getPage: async (s) => (s === page.slug ? page : null),
    getContent: async () => opts.rendered ?? RENDERED,
  };
  if (opts.withoutGetSource) return base;
  return { ...base, getSource: async () => (opts.sourceNull ? null : (opts.raw ?? RAW)) };
}

/** Narrow to the found variant, failing the test rather than silently skipping. */
function found(entry: GetEntry): Extract<GetEntry, { found: true }> {
  expect(entry.found).toBe(true);
  if (!entry.found) throw new Error('expected a found entry');
  return entry;
}

function missing(entry: GetEntry): Extract<GetEntry, { found: false }> {
  expect(entry.found).toBe(false);
  if (entry.found) throw new Error('expected an error entry');
  return entry;
}

describe('getDocs { source: true }', () => {
  it('returns the canonical bytes VERBATIM — frontmatter, imports and JSX intact', async () => {
    const res = await getDocs(makeSource(), { slugs: [PAGE.slug], source: true });
    const entry = found(res.results[0]);

    expect(entry.content).toBe(RAW);
    expect(entry.source).toBe(true);
    expect(entry.bytes).toBe(RAW.length);
    expect(entry.truncated).toBeUndefined();
  });

  it('CONTROL: the same call without `source` serves the lossy projection', async () => {
    const res = await getDocs(makeSource(), { slugs: [PAGE.slug] });
    const entry = found(res.results[0]);

    // Exactly the three losses that made a round trip destructive.
    expect(entry.content).toBe(RENDERED);
    expect(entry.content).not.toContain('---\ntitle:'); // frontmatter stripped
    expect(entry.content).toContain('URL: '); // read preamble prepended
    expect(entry.content).not.toContain('<Aside'); // JSX component rewritten away
    expect(entry.source).toBeUndefined();
  });

  it('REFUSES with source_unavailable when the source cannot serve canonical text', async () => {
    const res = await getDocs(makeSource({ withoutGetSource: true }), { slugs: [PAGE.slug], source: true });
    const entry = missing(res.results[0]);

    expect(entry.error).toBe('source_unavailable');
    expect(entry.detail).toContain('fixture-source');
    // The whole point: it does NOT quietly hand back the rendered body, which
    // would be indistinguishable from a working source read.
    expect(JSON.stringify(entry)).not.toContain('Body text.');
  });

  it('REFUSES a page whose getSource resolves null, rather than falling back', async () => {
    const res = await getDocs(makeSource({ sourceNull: true }), { slugs: [PAGE.slug], source: true });
    const entry = missing(res.results[0]);

    expect(entry.error).toBe('source_unavailable');
    expect(JSON.stringify(entry)).not.toContain('Body text.');
  });

  it('REFUSES source + heading — a section slice is not the document', async () => {
    const res = await getDocs(makeSource(), { slugs: [PAGE.slug], source: true, heading: 'attach' });
    const entry = missing(res.results[0]);

    expect(entry.error).toBe('heading_unsupported_with_source');
    expect(entry.detail).toContain('not the document');
  });

  it('still reports not_found for an unknown slug', async () => {
    const res = await getDocs(makeSource(), { slugs: ['testing/nope'], source: true });
    const entry = missing(res.results[0]);
    expect(entry.error).toBe('not_found');
  });

  it('does NOT prepend the OKF stale banner — a read annotation must not enter the bytes', async () => {
    const stalePage: DocPage = {
      ...PAGE,
      okf: { staleAfter: '2020-01-01' } as DocPage['okf'],
    };
    const src = makeSource({ page: stalePage });

    const rendered = found((await getDocs(src, { slugs: [PAGE.slug] })).results[0]);
    const source = found((await getDocs(src, { slugs: [PAGE.slug], source: true })).results[0]);

    // Control: the rendered read DOES carry the banner, so its absence below is a
    // deliberate difference and not a fixture that simply never goes stale.
    expect(rendered.content).not.toBe(RENDERED);
    expect(rendered.trust?.stale).toBe(true);

    expect(source.content).toBe(RAW); // byte-identical: no banner spliced in
    expect(source.trust?.stale).toBe(true); // …but the verdict still reaches the caller
  });

  describe('paging', () => {
    /** A body of `n` chars whose every position is identifiable, so a mis-slice cannot hide. */
    const ruler = (n: number): string => {
      let out = '';
      for (let i = 0; out.length < n; i += 1) out += `${i}|`;
      return out.slice(0, n);
    };

    const TOTAL = MAX_PAYLOAD_BYTES * 2 + 977;
    const big = ruler(TOTAL);
    const src = makeSource({ raw: big });

    it('reassembles the whole source byte for byte across windows', async () => {
      let offset = 0;
      let assembled = '';
      let windows = 0;
      for (;;) {
        const entry = found((await getDocs(src, { slugs: [PAGE.slug], source: true, offset })).results[0]);
        windows += 1;
        expect(windows).toBeLessThanOrEqual(10); // a non-advancing offset must fail, not spin
        expect(entry.source).toBe(true);
        expect(entry.bytes).toBe(TOTAL);
        assembled += entry.truncated ? entry.content.slice(0, MAX_PAYLOAD_BYTES) : entry.content;
        if (entry.nextOffset === undefined) break;
        expect(entry.nextOffset).toBeGreaterThan(offset);
        offset = entry.nextOffset;
      }
      expect(windows).toBe(3);
      expect(assembled).toBe(big);
    });

    it('a clipped source window still carries the truncation tail — which is what the WRITER refuses', async () => {
      const entry = found((await getDocs(src, { slugs: [PAGE.slug], source: true })).results[0]);
      expect(entry.truncated).toBe(true);
      // Asserted through the SHARED detector docs:author actually calls, not a
      // hand-copied phrase: a source window that failed this is a partial body that
      // looks whole to both the reader and the write guard.
      expect(entry.content.length).toBeGreaterThan(MAX_PAYLOAD_BYTES);
      expect(hasTruncationTail(entry.content)).toBe(true);
      expect(hasTruncationTail(RAW)).toBe(false); // control: the detector is not vacuous
    });
  });

  it('telemetry omits jsx_literals_present in source mode and says why', async () => {
    const seen: Record<string, unknown>[] = [];
    await getDocs(makeSource(), { slugs: [PAGE.slug], source: true }, { metadata: (d) => seen.push(d) });
    const meta = seen.at(-1) ?? {};

    // Raw MDX is SUPPOSED to contain JSX, so the drift signal that means "the render
    // leaked" on a rendered read would fire on every healthy source read. It is
    // omitted rather than sent as a false `true`, and source_mode explains the gap.
    expect(meta).not.toHaveProperty('jsx_literals_present');
    expect(meta.source_mode).toBe(true);

    const renderedSeen: Record<string, unknown>[] = [];
    await getDocs(makeSource(), { slugs: [PAGE.slug] }, { metadata: (d) => renderedSeen.push(d) });
    expect(renderedSeen.at(-1)).toHaveProperty('jsx_literals_present');
  });
});
