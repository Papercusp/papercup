import { describe, it, expect, beforeEach, vi } from 'vitest';
import candidatesTool from './candidates';
import { getFlag } from '@papercusp/flags/server';
import { listLearningPackCandidates } from '../../learning-packs/candidates';

// PG-free unit: the candidate read has its own suite; this pins the TOOL — flag
// gate, the status default ('pending' review queue), the conditional limit, and
// the { count, candidates } envelope (self-improvement-consume-edges P-032 / B-11).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../learning-packs/candidates', () => ({ listLearningPackCandidates: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockList = vi.mocked(listLearningPackCandidates);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    candidatesTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('learning_packs:candidates tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockList.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }] as unknown as Awaited<ReturnType<typeof listLearningPackCandidates>>);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({}))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('defaults the status to "pending" (the review queue), no limit key', async () => {
    await callTool({});
    expect(mockList).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('forwards an explicit status + limit', async () => {
    await callTool({ status: 'adopted', limit: 5 });
    expect(mockList).toHaveBeenCalledWith({ status: 'adopted', limit: 5 });
  });

  it('returns { ok, count, candidates }', async () => {
    expect(body(await callTool({}))).toMatchObject({ ok: true, count: 2 });
  });
});
