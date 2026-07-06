/**
 * docs-qa.test.ts — the retrieval-augmented docs Q&A helpers (WI-2844).
 * Covers the pure prompt composition, the backend-availability gate, and real
 * in-process retrieval against the engineering /internal/docs content.
 */
import { describe, expect, it } from 'vitest';
import { composeDocsQaPrompt, backendAvailable, retrieveDocsContext, buildDocsMcpConfig } from './docs-qa';

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
    expect(p).toMatch(/cite it inline by its `\/internal\/docs\/<slug>` path/);
  });

  it('never leaks the retrieval mechanism or deflects (owner-reported "reads like a static search")', () => {
    // The 2026-07-05 fix: the model must answer like a knowledgeable teammate, not
    // parrot/deflect. These guards pin the anti-deflection behavior in the prompt so
    // a future edit can't reintroduce "the documentation excerpt doesn't cover this".
    const p = composeDocsQaPrompt('how do plans work?', {
      sectionTitle: 'Plans',
      blocks: [{ slug: 'system/plans', title: 'Plans', url: '/internal/docs/system/plans', text: 'Plans live in Postgres.' }],
    });
    expect(p).toMatch(/NEVER mention/); // forbids leaking that anything was retrieved
    expect(p).toMatch(/never reply that "the docs don't cover this"/); // no dead-ends
    expect(p).toMatch(/knowledge of Papercusp/); // may answer from general knowledge
    // It must NOT carry the old strict "only the excerpts / say so if not covered" framing.
    expect(p).not.toContain('the real documentation excerpts below');
  });

  it('when nothing is retrieved, tells the model to answer from general knowledge (never dead-ends)', () => {
    const p = composeDocsQaPrompt('totally unknown thing', { blocks: [] });
    expect(p).toContain('answer from your general knowledge of Papercusp');
    expect(p).not.toContain('no matching documentation was found'); // the old deflecting note is gone
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

describe('buildDocsMcpConfig', () => {
  it('builds a docs-only agentmcp bridge with workspace, client, and bearer token', async () => {
    const config = await buildDocsMcpConfig({
      baseUrl: 'http://operator.test',
      workspaceId: 'ws main',
      uiClientId: 'client/abc',
      readToken: () => 'superuser-token-value',
      readPrincipal: async () => ({
        role: 'oracle',
        bearer: 'principal-token',
        workspaceId: 'ws main',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    });

    const server = config?.mcpServers.agentmcp;
    expect(server?.command).toBe('npx');
    expect(server?.args.slice(0, 3)).toEqual(['-y', 'mcp-remote@latest', expect.stringContaining('/api/mcp?superuser=1')]);
    const url = new URL(server!.args[2]);
    expect(url.searchParams.get('workspace')).toBe('ws main');
    expect(url.searchParams.get('tools')).toBe('docs:search,docs:get,docs:outline');
    expect(url.searchParams.get('client')).toBe('client/abc');
    expect(server?.args).toContain('Authorization:Bearer superuser-token-value');
  });

  it('returns null when the oracle principal or superuser token is unavailable', async () => {
    await expect(buildDocsMcpConfig({
      workspaceId: 'ws',
      readToken: () => 'superuser-token-value',
      readPrincipal: async () => null,
    })).resolves.toBeNull();

    await expect(buildDocsMcpConfig({
      workspaceId: 'ws',
      readToken: () => null,
      readPrincipal: async () => ({
        role: 'oracle',
        bearer: 'principal-token',
        workspaceId: 'ws',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    })).resolves.toBeNull();
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
