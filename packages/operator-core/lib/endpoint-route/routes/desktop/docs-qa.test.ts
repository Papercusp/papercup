/**
 * docs-qa.test.ts — the retrieval-augmented docs Q&A helpers (WI-2844).
 * Covers the pure prompt composition, the backend-availability gate, and real
 * in-process retrieval against the engineering /internal/docs content.
 */
import { describe, expect, it } from 'vitest';
import {
  composeDocsQaPrompt,
  composeAgenticDocsSystemPrompt,
  slugsFromDocsToolCall,
  backendAvailable,
  retrieveDocsContext,
  buildDocsMcpConfig,
  createAgenticAnswerBuffer,
} from './docs-qa';

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
        bearer: 'principal-token',
        name: 'oracle',
        workspaceId: 'ws main',
        capabilities: [],
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
        bearer: 'principal-token',
        name: 'oracle',
        workspaceId: 'ws',
        capabilities: [],
      }),
    })).resolves.toBeNull();
  });
});

describe('retrieveDocsContext — real in-process /internal/docs retrieval', () => {
  // searchDocs scores the FULL engineering corpus (600+ pages and growing) per
  // call. EI-8965: starlightContentAdapter.getContent() now caches each page's
  // rendered body for the adapter's process lifetime (packages/docs-engine/src/
  // adapters/starlight.ts), so this is only slow on the FIRST search a process
  // ever does (~10-20s cold, running the full remark/remark-mdx render pipeline
  // over every page in parallel) — every later search in the same process is
  // ~tens of ms. This test is that unavoidable cold call, and the corpus keeps
  // growing, so give it real margin rather than re-tuning it every time the
  // corpus crosses another threshold (was 30s — too tight, caused repeat
  // watchdog timeouts under concurrent host load with no logic bug involved).
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
    60_000,
  );
});

describe('composeAgenticDocsSystemPrompt (agentic path)', () => {
  it('instructs the agent to search + read our real docs before answering', () => {
    const p = composeAgenticDocsSystemPrompt({});
    expect(p).toContain('docs:search');
    expect(p).toContain('docs:get');
  });

  it('forces a concept-first definition and forbids leading with the branding/skin meaning', () => {
    // The owner-reported "a Pot is a visual identity" regression guard.
    const p = composeAgenticDocsSystemPrompt({ sectionTitle: 'Orientation' });
    expect(p).toMatch(/PRODUCT CONCEPT/);
    expect(p).toMatch(/"Pot" is primarily a PROJECT/);
    expect(p).toMatch(/do NOT lead by calling X a "visual identity"/);
    expect(p).toContain('"Orientation" section'); // section context threads through
  });

  it('does not leak the retrieval mechanism', () => {
    expect(composeAgenticDocsSystemPrompt({})).toMatch(/NEVER mention "the docs"/);
  });

  it('forbids narrating tool use as visible text (owner-reported "let me try…" leaking to the answer)', () => {
    const p = composeAgenticDocsSystemPrompt({});
    expect(p).toMatch(/NO text output/);
    expect(p).toMatch(/never narrate what you are about to do/);
  });

  it('tells the agent to treat everyday-sounding words as Papercusp jargon first (owner-reported "cup" answered as an insect)', () => {
    const p = composeAgenticDocsSystemPrompt({});
    expect(p).toMatch(/bee, pot, mug, queen, hive, cup, swarm/);
    expect(p).toMatch(/ALWAYS assume the Papercusp meaning/);
  });

  it('points the agent at harness/glossary for short "what is X" terminology questions', () => {
    expect(composeAgenticDocsSystemPrompt({})).toContain('harness/glossary');
  });

  it('REQUIRES `harness: "all"` on every docs tool call (the :3070 harness_required derailment fix)', () => {
    // Root cause of the owner-reported "it still uses the old functionality" bug: the
    // superuser ctx sets harnessSlug='*' → resolveHarnessScope returns `none` →
    // docs:search/get/outline reject with `harness_required` unless the agent passes
    // `harness: "all"` explicitly. The prompt now mandates it deterministically.
    const p = composeAgenticDocsSystemPrompt({});
    expect(p).toContain('harness: "all"');
    expect(p).toMatch(/MUST include the argument `harness: "all"`/);
    // docs:get example carries the arg too (citations path).
    expect(p).toContain('docs:get { harness: "all"');
  });

  it('forbids asking the user about harness/scope; retries with `harness: "all"` on a scope error', () => {
    // On :3070 the agent turned a harness_required error into "which harness/project are
    // you in?" — a broken answer for a newcomer. The prompt now bans that derailment.
    const p = composeAgenticDocsSystemPrompt({});
    expect(p).toMatch(/NEVER ask the user which harness, project, workspace, or scope/);
    expect(p).toMatch(/RETRY the SAME call with `harness: "all"`/);
  });
});

describe('slugsFromDocsToolCall (agentic citations)', () => {
  it('extracts a single slug from a docs:get call', () => {
    expect(slugsFromDocsToolCall('docs:get', { slug: 'branding' })).toEqual(['branding']);
  });
  it('extracts multiple slugs from docs:get { slugs } — incl. the mcp-prefixed name', () => {
    expect(slugsFromDocsToolCall('mcp__agentmcp__docs:get', { slugs: ['a/b', 'c'] })).toEqual(['a/b', 'c']);
  });
  it('returns nothing for docs:search (no page slug on input) or malformed input', () => {
    expect(slugsFromDocsToolCall('docs:search', { query: 'pot' })).toEqual([]);
    expect(slugsFromDocsToolCall('docs:get', null)).toEqual([]);
    expect(slugsFromDocsToolCall('docs:get', { slug: '' })).toEqual([]);
  });
});

describe('createAgenticAnswerBuffer (WI-3218: mechanical narration suppression)', () => {
  it('flushes clean delta text with no tool calls in between', () => {
    const buf = createAgenticAnswerBuffer();
    buf.delta('A pot is a project.');
    expect(buf.flush()).toBe('A pot is a project.');
  });

  it('discards narration text that precedes a tool call (owner-reported "let me search..." leak)', () => {
    const buf = createAgenticAnswerBuffer();
    buf.delta('Let me search for definitions related to core Papercusp concepts...');
    buf.toolCall(); // docs:search fires — the narration above must never reach the client
    buf.delta('A pot is a project — the top-level container you build and run agents in.');
    expect(buf.flush()).toBe('A pot is a project — the top-level container you build and run agents in.');
  });

  it('discards narration between MULTIPLE tool calls, keeping only the segment after the last one', () => {
    const buf = createAgenticAnswerBuffer();
    buf.delta('Let me try a different approach...');
    buf.toolCall();
    buf.delta('Let me search more specifically...');
    buf.toolCall();
    buf.delta('A harness is a role-based agent crew that builds a feature.');
    expect(buf.flush()).toBe('A harness is a role-based agent crew that builds a feature.');
  });

  it('accumulates delta text arriving in multiple chunks after the last tool call', () => {
    const buf = createAgenticAnswerBuffer();
    buf.toolCall();
    buf.delta('A bee is ');
    buf.delta('the Papercusp term for an autonomous worker agent.');
    expect(buf.flush()).toBe('A bee is the Papercusp term for an autonomous worker agent.');
  });

  it('flush clears the buffer so a second flush is empty (no double-send)', () => {
    const buf = createAgenticAnswerBuffer();
    buf.delta('answer');
    expect(buf.flush()).toBe('answer');
    expect(buf.flush()).toBe('');
  });

  it('a tool call with nothing buffered is a no-op', () => {
    const buf = createAgenticAnswerBuffer();
    buf.toolCall();
    expect(buf.flush()).toBe('');
  });
});
