/**
 * release.test.ts — issues:release keyed bulk contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../issues-engineer', () => ({ releaseIssue: vi.fn() }));

import { releaseIssue } from '../../issues-engineer';
const releaseM = vi.mocked(releaseIssue);
const tool = (await import('./release')).default;

type Out = { data?: any; content?: Array<{ text: string }> };
const call = async (args: Record<string, unknown>) => {
  const res = (await tool.handler(args as never, {} as never)) as Out;
  return res.data ?? JSON.parse(res.content![0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  releaseM.mockImplementation(async (id: string) => ({ id, assignee: null }) as never);
});

describe('issues:release handler', () => {
  it('wraps a single id through the keyed bulk envelope', async () => {
    const b = await call({ id: 'EI-1' });
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [{ ok: true, id: 'EI-1', issue: { id: 'EI-1', assignee: null } }],
    });
  });

  it('releases selected ids and isolates a missing issue', async () => {
    releaseM.mockImplementation(async (id: string) => (id === 'missing' ? null : ({ id, assignee: null }) as never));
    const b = await call({ ids: ['EI-1', 'missing', 'EI-2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => [r.id, r.ok])).toEqual([
      ['EI-1', true],
      ['missing', false],
      ['EI-2', true],
    ]);
    expect(b.results[1]).toMatchObject({ error: 'issue not found' });
  });
});
