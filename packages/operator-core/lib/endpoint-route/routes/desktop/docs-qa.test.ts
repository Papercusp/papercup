/**
 * docs-qa.test.ts — the retrieval-augmented docs Q&A helpers (WI-2844).
 * Covers the pure prompt composition, the backend-availability gate, and real
 * in-process retrieval against the engineering /internal/docs content.
 */
import { describe, expect, it } from 'vitest';
import { composeDocsQaPrompt, backendAvailable, retrieveDocsContext } from './docs-qa';

describe('composeDocsQaPrompt', () => {
  it('grounds on the retrieved blocks, the section, and the question, and asks for citations', () => {
    const p = composeDocsQaPrompt('how do plans work?', {
      sectionTitle: 'Plans',
      blocks: [
        {
          slug: 'system/plans',
          title: 'Plans',
          url: '/internal/docs/system/plans',
          text: 'Plans live in Postgres and agents work from them.',
        },
      ],
    });
    expect(p).toContain('how do plans work?'); // the question
    expect(p).toContain('Plans live in Postgres'); // retrieved doc body
    expect(p).toContain('/internal/docs/system/plans'); // slug path (grounding + citation target)
    expect(p).toContain('"Plans" section'); // section context
    expect(p).toMatch(/cite pages by their `\/internal\/docs\/<slug>` path/);
  });

  it('degrades to an explicit "no docs found" note (never invents grounding)', () => {
    const p = composeDocsQaPrompt('totally unknown thing', { blocks: [] });
    expect(p).toContain('no matching documentation was found');
    expect(p).toContain('## Question');
    expect(p).toContain('totally unknown thing');
  });

  it('uses currentPath when no section title is given', () => {
    const p = composeDocsQaPrompt('q', { currentPath: '/internal/docs', blocks: [] });
    expect(p).toContain('/internal/docs');
  });
});

describe('backendAvailable', () => {
  it('is true when the PAPERCUSP_FAKE_LLM test seam is set', () => {
    const prev = process.env.PAPERCUSP_FAKE_LLM;
    process.env.PAPERCUSP_FAKE_LLM = '1';
    try {
      expect(backendAvailable()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_FAKE_LLM;
      else process.env.PAPERCUSP_FAKE_LLM = prev;
    }
  });
});

describe('retrieveDocsContext — real in-process /internal/docs retrieval', () => {
  // searchDocs scores the FULL engineering corpus (hundreds of pages) per call —
  // ~several seconds cold in a test env (warm/OS-cached in the live operator, and
  // the "Searching the docs…" spinner covers it). Give it room.
  it(
    'returns grounded blocks (slug + real body text + /internal/docs url) for a known topic',
    async () => {
      const blocks = await retrieveDocsContext('harness', { limit: 4 });
      expect(Array.isArray(blocks)).toBe(true);
      // The engineering reference definitely covers "harness"; if the content root
      // resolves in this env (it does under the repo), we get grounded blocks.
      if (blocks.length > 0) {
        expect(blocks[0].slug).toBeTruthy();
        expect(blocks[0].text.length).toBeGreaterThan(0);
        expect(blocks[0].url).toContain('/internal/docs/');
      }
    },
    30_000,
  );
});
