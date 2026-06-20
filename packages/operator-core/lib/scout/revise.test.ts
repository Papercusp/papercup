import { describe, it, expect } from 'vitest';
import {
  runScoutRevisionCycle,
  looksLikePlanMarkdown,
  revisionUserPrompt,
  DEFAULT_REVISION_MODEL,
  type ScoutReviseDeps,
} from './revise';
import type { QueenFeedbackItem } from './scheduler';
import { withPlanLock as realWithPlanLock } from '../agent-tools/plans/with-plan-lock';

/** A fake withPlanLock over an in-memory plan store (no PG). */
function fakePlanStore(initial: Record<string, string | null>) {
  const store = new Map<string, string | null>(Object.entries(initial));
  const writes: Array<{ slug: string; body: string }> = [];
  const withPlanLock = (async (_ctx: unknown, opts: { slug: string }, mutator: (c: string | null, m: null) => Promise<{ newBody: string | null; value: unknown }>) => {
    const current = store.has(opts.slug) ? (store.get(opts.slug) ?? null) : null;
    const { newBody, value } = await mutator(current, null);
    if (newBody !== null) {
      store.set(opts.slug, newBody);
      writes.push({ slug: opts.slug, body: newBody });
    }
    return { kind: 'applied', value };
  }) as unknown as typeof realWithPlanLock;
  return { withPlanLock, store, writes };
}

const planBody = (slug: string, marker = 'original') =>
  `---\ntitle: A draft\nslug: ${slug}\nstatus: draft\norigin: scout\ncreated: 2026-06-20\nupdated: 2026-06-20\n---\n\n# A draft\n\n## Now\n\n**State:** ${marker}\n\n## Background\n\nx\n\n## Decisions\n`;

const fb = (planSlug: string, body = 'tighten the Now block'): QueenFeedbackItem => ({
  planSlug,
  body,
  fromOwnerId: 'queen-owner-1',
  msgId: `m-${planSlug}`,
  ts: '2026-06-20T11:00:00.000Z',
});

function fakeLlm(text: string, costUsd = 0.01): ScoutReviseDeps['llmCall'] {
  return async () => ({ text, costUsd, inputTokens: 10, outputTokens: 20 });
}

describe('runScoutRevisionCycle (P-001 targeted revision)', () => {
  it('revises an existing draft: writes the revised body, sums cost, returns revised outcome', async () => {
    const slug = 'scout-x-2026-06-20';
    const { withPlanLock, store } = fakePlanStore({ [slug]: planBody(slug, 'original') });
    const revised = planBody(slug, 'REVISED per feedback');
    const res = await runScoutRevisionCycle([fb(slug)], {
      llmCall: fakeLlm(revised, 0.05),
      withPlanLock,
      planWorkspaceId: 'default',
      harnessSlug: 'papercusp',
    });
    expect(res.revisions).toHaveLength(1);
    expect(res.revisions[0]).toMatchObject({ planSlug: slug, status: 'revised', costUsd: 0.05, fromOwnerId: 'queen-owner-1', msgId: `m-${slug}` });
    expect(store.get(slug)).toBe(revised);
    expect(res.costUsd).toBe(0.05);
    // cycle-shaped: routes nothing new
    expect(res.provenance).toEqual([]);
    expect(res.stop).toBe('completed');
  });

  it('missing draft → no LLM call, status missing, nothing written', async () => {
    const slug = 'scout-gone-2026-06-20';
    const { withPlanLock, writes } = fakePlanStore({ [slug]: null });
    let llmCalls = 0;
    const res = await runScoutRevisionCycle([fb(slug)], {
      llmCall: async () => {
        llmCalls += 1;
        return { text: 'x', costUsd: 1, inputTokens: 0, outputTokens: 0 };
      },
      withPlanLock,
      planWorkspaceId: 'default',
      harnessSlug: 'papercusp',
    });
    expect(llmCalls).toBe(0);
    expect(res.revisions[0].status).toBe('missing');
    expect(writes).toHaveLength(0);
  });

  it('refuses to overwrite a draft with a non-plan LLM response (status error, not written)', async () => {
    const slug = 'scout-y-2026-06-20';
    const { withPlanLock, store } = fakePlanStore({ [slug]: planBody(slug) });
    const res = await runScoutRevisionCycle([fb(slug)], {
      llmCall: fakeLlm("I'm sorry, I can't do that.", 0.02),
      withPlanLock,
      planWorkspaceId: 'default',
      harnessSlug: 'papercusp',
    });
    expect(res.revisions[0].status).toBe('rejected');
    expect(res.revisions[0].note).toMatch(/plan shape/);
    expect(store.get(slug)).toBe(planBody(slug)); // untouched
  });

  it('unchanged when the LLM returns the same body / empty', async () => {
    const slug = 'scout-z-2026-06-20';
    const body = planBody(slug);
    const { withPlanLock } = fakePlanStore({ [slug]: body });
    const res = await runScoutRevisionCycle([fb(slug)], {
      llmCall: fakeLlm(body, 0.0),
      withPlanLock,
      planWorkspaceId: 'default',
      harnessSlug: 'papercusp',
    });
    expect(res.revisions[0].status).toBe('unchanged');
  });

  it('one failure does not abort the batch; partial progress returns normally', async () => {
    const ok = 'scout-ok-2026-06-20';
    const bad = 'scout-bad-2026-06-20';
    const { withPlanLock, store } = fakePlanStore({ [ok]: planBody(ok), [bad]: planBody(bad) });
    const revisedOk = planBody(ok, 'REVISED');
    let n = 0;
    const res = await runScoutRevisionCycle([fb(ok), fb(bad)], {
      llmCall: async () => {
        n += 1;
        if (n === 2) throw new Error('boom');
        return { text: revisedOk, costUsd: 0.03, inputTokens: 0, outputTokens: 0 };
      },
      withPlanLock,
      planWorkspaceId: 'default',
      harnessSlug: 'papercusp',
    });
    expect(res.revisions.map((r) => r.status).sort()).toEqual(['error', 'revised']);
    expect(store.get(ok)).toBe(revisedOk);
  });

  it('throws when EVERY item errors (total failure → tick retries, no ack)', async () => {
    const slug = 'scout-fail-2026-06-20';
    const { withPlanLock } = fakePlanStore({ [slug]: planBody(slug) });
    await expect(
      runScoutRevisionCycle([fb(slug)], {
        llmCall: async () => {
          throw new Error('llm down');
        },
        withPlanLock,
        planWorkspaceId: 'default',
        harnessSlug: 'papercusp',
      }),
    ).rejects.toThrow(/all 1 draft/);
  });

  it('empty feedback → empty result, no throw', async () => {
    const { withPlanLock } = fakePlanStore({});
    const res = await runScoutRevisionCycle([], {
      llmCall: fakeLlm('x'),
      withPlanLock,
      planWorkspaceId: 'default',
      harnessSlug: 'papercusp',
    });
    expect(res.revisions).toEqual([]);
    expect(res.costUsd).toBe(0);
  });
});

describe('revise helpers', () => {
  it('DEFAULT_REVISION_MODEL is the synthesis-tier model', () => {
    expect(DEFAULT_REVISION_MODEL).toBe('claude-sonnet-4-6');
  });

  it('looksLikePlanMarkdown requires frontmatter + the slug', () => {
    const slug = 'scout-a-2026-06-20';
    expect(looksLikePlanMarkdown(planBody(slug), slug)).toBe(true);
    expect(looksLikePlanMarkdown('no frontmatter here ' + slug, slug)).toBe(false); // no ---
    expect(looksLikePlanMarkdown(planBody('other-slug'), slug)).toBe(false); // slug missing
    expect(looksLikePlanMarkdown('---\n', slug)).toBe(false); // too short
  });

  it('revisionUserPrompt embeds the current plan + the feedback', () => {
    const p = revisionUserPrompt('PLANBODY', 'FEEDBACK');
    expect(p).toContain('PLANBODY');
    expect(p).toContain('FEEDBACK');
    // empty feedback falls back to a generic "needs another pass" instruction
    expect(revisionUserPrompt('PLANBODY', '   ')).toMatch(/needs another pass/);
  });
});
