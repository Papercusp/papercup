import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
import {
  BACKFILL_RETIRE_REASON,
  GENERATOR_OWNED_DOCS,
  listCorpusDocs,
  listSectionDocs,
  parseExactDocSelection,
  readAuthoredRows,
  retireOrphansRefusal,
  writeContent,
} from '../../../../../scripts/project-authored-docs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('authored-doc projection (P-008)', () => {
  describe('ESM entrypoint (EI-20185101375739809)', () => {
    it('exposes projector helpers as static named imports under tsx', () => {
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          "import { listCorpusDocs, resolveDocsRoot } from './scripts/project-authored-docs.mts'; console.log(typeof listCorpusDocs, typeof resolveDocsRoot)",
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
      );
      expect(output.trim()).toBe('function function');
    });
  });

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

  describe('reconcile writes — optimistic concurrency', () => {
    it('reads updated_at as exact text so microseconds survive the CAS round trip', async () => {
      let statement = '';
      const client = {
        query: async (sql: string) => {
          statement = sql;
          return {
            rows: [{
              doc_id: 'testing/agent-e2e.mdx',
              content: SAMPLE,
              content_hash: sha256(SAMPLE),
              updated_at: '2026-08-22 03:41:17.089338+00',
              content_mode: 'authored',
              retired_at: null,
            }],
          };
        },
      };

      const rows = await readAuthoredRows(client, null);

      expect(statement).toContain('updated_at::text AS updated_at');
      expect(rows.get('testing/agent-e2e.mdx')?.updated_at).toBe('2026-08-22 03:41:17.089338+00');
    });

    it('refuses a stale file when PG changed after the read snapshot', async () => {
      const canonical = SAMPLE;
      const newer = SAMPLE.replace('Some prose.', 'A newer canonical edit.');
      let current = {
        content: newer,
        contentHash: sha256(newer),
        updatedAt: '2026-08-21T17:00:00.000Z',
      };
      let statement = '';
      let parameters: unknown[] = [];
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          statement = sql;
          parameters = values ?? [];
          const expectedHash = parameters[6];
          const expectedUpdatedAt = parameters[7];
          if (current.contentHash !== expectedHash || current.updatedAt !== expectedUpdatedAt) {
            return { rows: [], rowCount: 0 };
          }
          current = {
            content: String(parameters[3]),
            contentHash: String(parameters[4]),
            updatedAt: '2026-08-21T17:01:00.000Z',
          };
          return { rows: [{ doc_id: 'agent-insights/a-doc.mdx' }], rowCount: 1 };
        },
      };

      const accepted = await writeContent(client, 'agent-insights/a-doc.mdx', canonical, {
        contentHash: sha256(canonical),
        updatedAt: '2026-08-21T16:59:00.000Z',
      });

      expect(accepted).toBe(false);
      expect(current.content).toBe(newer);
      expect(statement).toContain('AND content_hash = $7 AND updated_at = $8');
      // parameters[5] is the derived frontmatter bind ($6::jsonb) — it must be sent as the
      // JSON-stringified index derived from the CONTENT BEING WRITTEN (`canonical`), not left
      // out of the values array (the bug this test guards: frontmatter was computed and then
      // silently dropped, shifting every CAS parameter one slot to the left).
      expect(parameters[5]).toEqual(JSON.stringify(deriveFrontmatterIndex(canonical)));
      expect(parameters.slice(6)).toEqual([sha256(canonical), '2026-08-21T16:59:00.000Z']);
    });
  });

  describe('parseExactDocSelection — narrow reconcile scopes', () => {
    it('accepts repeated doc/files flags and de-duplicates exact paths', () => {
      expect(
        parseExactDocSelection([
          '--ingest',
          '--reconcile',
          '--doc=agent-insights/a-doc.mdx',
          '--files',
          'reference/a.md,agent-insights/a-doc.mdx',
        ]),
      ).toEqual({
        docIds: ['agent-insights/a-doc.mdx', 'reference/a.md'],
        errors: [],
      });
    });

    it('rejects absolute and traversal paths', () => {
      expect(parseExactDocSelection(['--doc=/tmp/a.mdx', '--files=../b.md'])).toMatchObject({
        docIds: [],
        errors: ['invalid exact doc path: /tmp/a.mdx', 'invalid exact doc path: ../b.md'],
      });
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

  describe('listCorpusDocs — the whole corpus, not one section (WI-37747)', () => {
    // Synthetic tree, per this file's no-live-corpus rule. The shapes below are the ones
    // the section-scoped walk could not see, and each is REAL in the corpus: 4 loose files
    // at the docs root, and 6 `.md` files. Both were invisible to a `<root>/<section>` walk.
    let root = '';
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'corpus-docs-'));
      mkdirSync(join(root, 'spec'), { recursive: true });
      mkdirSync(join(root, 'reference'), { recursive: true });
      mkdirSync(join(root, '.papercusp', 'memory'), { recursive: true });
      writeFileSync(join(root, 'index.mdx'), SAMPLE);
      writeFileSync(join(root, 'branding.mdx'), SAMPLE);
      writeFileSync(join(root, 'spec', 'a.mdx'), SAMPLE);
      writeFileSync(join(root, 'reference', 'b.md'), SAMPLE);
      writeFileSync(join(root, 'spec', 'notes.txt'), 'not a doc');
      writeFileSync(join(root, '.papercusp', 'memory', 'raw.md'), SAMPLE);
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('returns [] for a missing docs root rather than throwing', () => {
      expect(listCorpusDocs('/nonexistent/docs/root')).toEqual([]);
    });

    it('includes the loose root-level files a section walk drops', () => {
      expect(listCorpusDocs(root)).toContain('index.mdx');
      expect(listCorpusDocs(root)).toContain('branding.mdx');
      // The section-scoped walk cannot see them — that gap is the whole reason this exists.
      expect(listSectionDocs(root, 'spec')).not.toContain('index.mdx');
    });

    it('includes .md as well as .mdx, and still ignores non-docs and dot-paths', () => {
      const got = listCorpusDocs(root);
      expect(got).toContain('reference/b.md');
      expect(got).toContain('spec/a.mdx');
      expect(got).not.toContain('spec/notes.txt');
      // Agent scratch under a dot-path must never be minted as a canonical doc.
      expect(got.some((d) => d.includes('.papercusp'))).toBe(false);
    });

    describe('docs another generator owns are excluded (WI-37747 regression)', () => {
      // WHY: `npm run gen:doc-projections` rewrites these five from LIVE sources (the
      // defineTool registry, the PG plan store, the blueprint/role registries). PG cannot be
      // canonical for them — a row is only ever a stale snapshot. When this projector was
      // widened from `agent-insights` to the whole corpus it began claiming them, and
      // `gen:authored-docs:check` (a GATE) went red the next time either generator ran.
      beforeEach(() => {
        writeFileSync(join(root, 'reference', 'tool-catalog.md'), SAMPLE);
        writeFileSync(join(root, 'reference', 'plans-index.md'), SAMPLE);
        writeFileSync(join(root, 'reference', 'generated-api-and-lib-reference.mdx'), SAMPLE);
      });

      it('excludes generator-owned docs from the corpus walk', () => {
        const got = listCorpusDocs(root);
        expect(got).not.toContain('reference/tool-catalog.md');
        expect(got).not.toContain('reference/plans-index.md');
      });

      it('excludes them BY DOC, not by banning the reference/ directory', () => {
        // The falsifier that separates the real rule from a lazy `reference/` blanket ban:
        // `generated-api-and-lib-reference.mdx` carries THIS projector's own banner and is
        // genuinely PG-canonical, so it must survive — as must any ordinary doc filed there.
        const got = listCorpusDocs(root);
        expect(got).toContain('reference/generated-api-and-lib-reference.mdx');
        expect(got).toContain('reference/b.md');
      });

      it('every excluded doc_id is one the projector would otherwise have walked', () => {
        // Guards the set against rot: an entry naming a path that no longer exists (renamed,
        // deleted, or typo'd) silently protects nothing, and the gate it guards would red
        // without anything pointing here.
        for (const docId of GENERATOR_OWNED_DOCS) {
          expect(docId).toMatch(/^[^.].*\.mdx?$/);
        }
      });
    });
  });

  describe('the round trip holds for the shapes the corpus widening added', () => {
    // Same load-bearing property as above, exercised on doc_ids that only exist now that
    // the projector is corpus-wide: a `.md` file, and a root-level id with NO section
    // prefix (the banner embeds the doc_id, so a slash-less id is a distinct code path).
    it.each(['index.mdx', 'branding.mdx', 'reference/okf.md', 'testing/agent-e2e.md'])(
      '%s: strip(apply(c)) === c',
      (docId) => {
        expect(stripProjectionBanner(applyProjectionBanner(SAMPLE, docId)).content).toEqual(SAMPLE);
      },
    );

    it('a root-level doc_id still names itself in the banner', () => {
      expect(applyProjectionBanner(SAMPLE, 'index.mdx')).toContain('index.mdx');
    });
  });

  /**
   * P-009 — the liveness backfill's safety rails (migration 814).
   *
   * `--retire-orphans` reads FILE ABSENCE as proof a doc is dead. That inference is sound
   * only while the corpus is still committed AND the checkout is complete. The two inputs
   * that break it are indistinguishable from a genuine mass deletion by counts alone, so
   * the mode must REFUSE rather than guess — a wrong verdict here silently retires docs,
   * and a retired doc stops being materialized onto the site.
   *
   * These assert the refusal DIRECTION in both senses: that it fires on the dangerous
   * inputs, and that it does NOT fire on the ordinary one. A rail that always refuses
   * protects nothing, so the negative case is the load-bearing half.
   */
  describe('retireOrphansRefusal — the liveness backfill cannot run on an untrustworthy tree', () => {
    it('REFUSES an empty tree — the state P-009 itself creates by untracking the corpus', () => {
      const refusal = retireOrphansRefusal({ fileCount: 0, orphanCount: 928, rowCount: 928 });
      expect(refusal).not.toBeNull();
      // It must name the blast radius, not just decline: the whole corpus is at stake.
      expect(refusal).toContain('928');
      expect(refusal).toContain('whole corpus');
    });

    it('REFUSES a partial checkout — more orphans than files means the tree is not the oracle', () => {
      expect(retireOrphansRefusal({ fileCount: 10, orphanCount: 918, rowCount: 928 })).toContain(
        'not a complete checkout',
      );
    });

    it('ALLOWS the real measured shape — 874 files, 54 orphans of 928 rows', () => {
      // The actual 2026-08-12 corpus. If this ever starts refusing, the rails have become
      // over-tight and the backfill silently stops working rather than failing loudly.
      expect(retireOrphansRefusal({ fileCount: 874, orphanCount: 54, rowCount: 928 })).toBeNull();
    });

    it('ALLOWS a corpus with no orphans at all', () => {
      expect(retireOrphansRefusal({ fileCount: 874, orphanCount: 0, rowCount: 874 })).toBeNull();
    });

    it('sits exactly at the boundary: orphans == files is allowed, one more is not', () => {
      // The rail is `orphanCount > fileCount`. Pinning both sides stops a later refactor
      // from flipping it to >= (which would refuse a legitimate 50/50 corpus) unnoticed.
      expect(retireOrphansRefusal({ fileCount: 50, orphanCount: 50, rowCount: 100 })).toBeNull();
      expect(retireOrphansRefusal({ fileCount: 50, orphanCount: 51, rowCount: 101 })).not.toBeNull();
    });

    it('records a reason that identifies THIS backfill, so it can be reversed selectively', () => {
      // retired_at alone cannot distinguish a backfilled retirement from a deliberate one
      // made later. The reason string is what makes `UPDATE ... SET retired_at = NULL
      // WHERE retired_reason = <this>` a safe, surgical undo.
      expect(BACKFILL_RETIRE_REASON).toContain('814');
      expect(BACKFILL_RETIRE_REASON).toContain('no file on disk');
    });
  });
});
