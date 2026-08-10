import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  applyProjectionBanner,
  bannerLines,
  deriveFrontmatterIndex,
  ingestVerdict,
  PROJECTION_MARKER,
  projectionVerdict,
  sha256,
  splitFrontmatter,
  stripProjectionBanner,
} from './authored-doc-projection';
import { listSectionDocs } from '../../../../../scripts/project-authored-docs';

/**
 * P-008 — PG becomes canonical for authored doc prose, projected back to .mdx.
 *
 * ⚠ NOTHING HERE READS THE LIVE CORPUS OR A DATABASE, for the reason the sibling
 * project-doc-parts.test.ts states: an assertion against the live tree goes red from an
 * ordinary peer edit within minutes. Every fixture is synthetic.
 *
 * THE LOAD-BEARING PROPERTY is the round trip: `strip(apply(c)) === c`, byte for byte.
 * The entire cutover rests on it — it is what lets the banner change without churning
 * 672 content hashes, what makes a freshly-ingested corpus project to zero changes, and
 * what keeps `projectionVerdict` able to tell "our own output" from "somebody edited the
 * prose". If this property breaks, the two directions stop agreeing about what the
 * canonical text IS, and drift becomes indistinguishable from a banner revision.
 */

const doc = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}\n`;
const SAMPLE = doc(
  'title: "A doc"\ndescription: "One line."\ndiscovered: 2026-08-10\ntags: [alpha, beta]\nstatus: active\nsidebar:\n  order: 12',
  '# Heading\n\nSome prose.',
);

describe('authored-doc projection (P-008)', () => {
  describe('the round trip — strip(apply(c)) === c', () => {
    it('is byte-identical for an ordinary doc', () => {
      const projected = applyProjectionBanner(SAMPLE, 'agent-insights/a-doc.mdx');
      expect(projected).not.toEqual(SAMPLE); // the banner really was added
      expect(stripProjectionBanner(projected).content).toEqual(SAMPLE);
    });

    it('is byte-identical for CRLF line endings', () => {
      const crlf = SAMPLE.replace(/\n/g, '\r\n');
      const projected = applyProjectionBanner(crlf, 'agent-insights/a-doc.mdx');
      expect(stripProjectionBanner(projected).content).toEqual(crlf);
    });

    it('is byte-identical for a BOM-prefixed doc', () => {
      const bom = `﻿${SAMPLE}`;
      const projected = applyProjectionBanner(bom, 'agent-insights/a-doc.mdx');
      expect(projected.startsWith('﻿')).toBe(true);
      expect(stripProjectionBanner(projected).content).toEqual(bom);
    });

    it('is IDEMPOTENT — projecting twice does not stack banners', () => {
      const once = applyProjectionBanner(SAMPLE, 'agent-insights/a-doc.mdx');
      const twice = applyProjectionBanner(stripProjectionBanner(once).content, 'agent-insights/a-doc.mdx');
      expect(twice).toEqual(once);
    });

    it('survives a banner WORDING change — the canonical text is unaffected', () => {
      // Simulates a future edit to bannerLines(): an older banner must still strip to
      // exactly the same content, or every doc would read as drifted on the next run.
      const older = SAMPLE.replace('---\n', `---\n# ${PROJECTION_MARKER} (older wording).\n`);
      expect(stripProjectionBanner(older).content).toEqual(SAMPLE);
    });
  });

  describe('stripping is CONSERVATIVE — it must never delete authored text', () => {
    it("keeps an author's own leading frontmatter comment", () => {
      const authored = SAMPLE.replace('---\n', '---\n# a note the author wrote\n');
      expect(stripProjectionBanner(authored).stripped).toBe(false);
      expect(stripProjectionBanner(authored).content).toEqual(authored);
    });

    it('keeps a comment that merely MENTIONS postgres', () => {
      const authored = SAMPLE.replace('---\n', '---\n# we store this in postgres somewhere\n');
      expect(stripProjectionBanner(authored).stripped).toBe(false);
    });

    it('leaves a doc with no frontmatter completely untouched', () => {
      const bare = '# Just a heading\n\nNo frontmatter here.\n';
      expect(applyProjectionBanner(bare, 'agent-insights/x.mdx')).toEqual(bare);
      expect(stripProjectionBanner(bare).content).toEqual(bare);
    });

    it('does not treat a `---` horizontal rule in the BODY as frontmatter', () => {
      const bare = 'Some prose.\n\n---\n\nMore prose.\n';
      expect(splitFrontmatter(bare).present).toBe(false);
      expect(applyProjectionBanner(bare, 'agent-insights/x.mdx')).toEqual(bare);
    });
  });

  describe('the banner is invisible to every consumer that matters', () => {
    it('parses away — frontmatter index is identical with and without it', () => {
      const projected = applyProjectionBanner(SAMPLE, 'agent-insights/a-doc.mdx');
      expect(deriveFrontmatterIndex(projected)).toEqual(deriveFrontmatterIndex(SAMPLE));
    });

    it('preserves every frontmatter key, including ones no writer here generates', () => {
      const rich = doc('title: "T"\ntype: Insight\ngenerated:\n  by: agent\n  at: 2026-07-26\nverified:\n  - at: 2026-08-01', 'body');
      const idx = deriveFrontmatterIndex(rich) as Record<string, unknown>;
      expect(Object.keys(idx).sort()).toEqual(['generated', 'title', 'type', 'verified']);
      // A DATE STAYS A STRING. js-yaml's default schema would hand back a JS Date here,
      // which JSON.stringify widens to "2026-07-26T00:00:00.000Z" — a timezone-bearing
      // instant the file never stated. The index must answer questions about the FILE.
      expect(idx.generated).toEqual({ by: 'agent', at: '2026-07-26' });
      // And the projection must not REWRITE that YAML — the round trip is what proves it.
      expect(stripProjectionBanner(applyProjectionBanner(rich, 'x')).content).toEqual(rich);
    });

    it('is emitted as YAML comments, never as an MDX-illegal HTML comment', () => {
      // MDX v2 has no `<!-- -->` form; emitting one would be a parse error on 672 pages.
      const projected = applyProjectionBanner(SAMPLE, 'agent-insights/a-doc.mdx');
      expect(projected).not.toContain('<!--');
      for (const line of bannerLines('x')) expect(line.startsWith('#')).toBe(true);
    });

    it('returns null (never throws) for frontmatter that does not parse', () => {
      const broken = doc('title: "unterminated\n  bad: [', 'body');
      expect(deriveFrontmatterIndex(broken)).toBeNull();
    });
  });

  describe('projectionVerdict — PG → file may not destroy an edit', () => {
    const content = SAMPLE;
    const contentHash = sha256(content);
    const nextText = applyProjectionBanner(content, 'agent-insights/a-doc.mdx');

    it('writes when the file is absent', () => {
      expect(projectionVerdict({ onDisk: null, contentHash, nextText })).toMatchObject({ ok: true, reason: 'absent' });
    });

    it('recognises its own output', () => {
      expect(projectionVerdict({ onDisk: nextText, contentHash, nextText })).toMatchObject({ ok: true, reason: 'already-current' });
    });

    it('accepts a file that is the canonical text with an OLDER banner', () => {
      const older = content.replace('---\n', `---\n# ${PROJECTION_MARKER} (older wording).\n`);
      expect(projectionVerdict({ onDisk: older, contentHash, nextText })).toMatchObject({ ok: true, reason: 'matches-canonical' });
    });

    it('accepts an un-bannered file that is exactly the canonical text', () => {
      // The state right after --ingest, before the first --write. Must not read as drift.
      expect(projectionVerdict({ onDisk: content, contentHash, nextText })).toMatchObject({ ok: true, reason: 'matches-canonical' });
    });

    it('REFUSES a file whose prose was edited', () => {
      const edited = content.replace('Some prose.', 'Some prose, plus a hand edit.');
      const verdict = projectionVerdict({ onDisk: edited, contentHash, nextText });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('drifted');
    });

    it('REFUSES an edit made inside the frontmatter too', () => {
      const edited = content.replace('status: active', 'status: superseded');
      expect(projectionVerdict({ onDisk: edited, contentHash, nextText }).ok).toBe(false);
    });
  });

  describe('ingestVerdict — file → PG is the guarded direction', () => {
    it('bootstraps a row whose content is empty', () => {
      expect(ingestVerdict({ fileText: SAMPLE, row: { content: '' } })).toMatchObject({ verdict: 'bootstrap' });
    });

    it('reports `create` when there is no row at all', () => {
      expect(ingestVerdict({ fileText: SAMPLE, row: null })).toMatchObject({ verdict: 'create' });
    });

    it('is a no-op when the file already equals canonical content', () => {
      expect(ingestVerdict({ fileText: SAMPLE, row: { content: SAMPLE } })).toMatchObject({ verdict: 'current' });
    });

    it('is a no-op when the file is canonical content PLUS our banner', () => {
      // The steady state on disk. Reading this as drift would make every run refuse.
      const projected = applyProjectionBanner(SAMPLE, 'agent-insights/a-doc.mdx');
      expect(ingestVerdict({ fileText: projected, row: { content: SAMPLE } })).toMatchObject({ verdict: 'current' });
    });

    it('REFUSES to promote a hand-edited file to canonical', () => {
      const edited = SAMPLE.replace('Some prose.', 'edited in the wrong place');
      expect(ingestVerdict({ fileText: edited, row: { content: SAMPLE } })).toMatchObject({ verdict: 'drifted' });
    });

    it('strips the banner before storing — a banner can never enter canonical content', () => {
      const projected = applyProjectionBanner(SAMPLE, 'agent-insights/a-doc.mdx');
      const { content } = ingestVerdict({ fileText: projected, row: { content: '' } });
      expect(content).toEqual(SAMPLE);
      expect(content).not.toContain(PROJECTION_MARKER);
    });
  });

  describe('sha256 is the same primitive the sibling projector uses', () => {
    it('matches node crypto', () => {
      expect(sha256('abc')).toEqual(createHash('sha256').update('abc', 'utf8').digest('hex'));
    });
  });

  describe('listSectionDocs', () => {
    it('returns [] for a missing docs root rather than throwing', () => {
      expect(listSectionDocs('/nonexistent/docs/root')).toEqual([]);
    });
  });
});
