/**
 * `submitAsk` is the ONE shared boundary both Ask surfaces funnel through — the
 * /adv modal (AskComposer) and the left-sidebar pane (AskAgentPane). It carries
 * the owner's requirement that an ask names a SPECIFIC recipient
 * ("in the ask fleet section, you should be required to select a specific
 * agent"), so the guard is asserted HERE once rather than duplicated per surface:
 * a future surface that forgets its own `ready` check still cannot send an
 * unaddressed ask.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parseTopics, submitAsk } from './AskComposer';

function mockFetch() {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ conversation_id: 'conv-1' }),
  }));
  vi.stubGlobal('fetch', spy as unknown as typeof fetch);
  return spy;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('submitAsk — recipient is mandatory', () => {
  it('refuses an ask with no agent chosen, without touching the network', async () => {
    const spy = mockFetch();
    await expect(submitAsk({ question: 'who owns sync?', agentId: '' })).rejects.toThrow(
      /Choose which agent to ask/i,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a blank question even when an agent is chosen', async () => {
    const spy = mockFetch();
    await expect(submitAsk({ question: '   ', agentId: 'su-1' })).rejects.toThrow(/question is required/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes a valid ask to exactly the one named agent', async () => {
    const spy = mockFetch();
    await submitAsk({ question: '  who owns sync?  ', agentId: 'su-1', topics: ['sync'] });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('coord/ask');
    const body = JSON.parse(String(init.body));
    // Directed at ONE recipient. `to` is REQUIRED server-side (WI-5951), so it
    // alone opens the conversation — no `force_open` (that arg was removed with
    // the knowledge tier, and args schemas are .strict(), so still sending it
    // would hard-fail the call).
    expect(body.to).toEqual(['su-1']);
    expect(body.force_open).toBeUndefined();
    expect(body.question).toBe('who owns sync?');
  });

  it('omits empty topics rather than sending an empty array', async () => {
    const spy = mockFetch();
    await submitAsk({ question: 'q', agentId: 'su-1', topics: [] });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).topics).toBeUndefined();
  });
});

describe('parseTopics', () => {
  it('splits, trims and drops blanks from a comma-separated list', () => {
    expect(parseTopics(' inference-gateway , sync ,, ')).toEqual(['inference-gateway', 'sync']);
  });

  it('returns an empty list for blank input', () => {
    expect(parseTopics('   ')).toEqual([]);
  });
});
