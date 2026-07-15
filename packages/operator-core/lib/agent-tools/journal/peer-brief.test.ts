/**
 * journal:peer-brief tool — PG-free unit. The surface source and distiller have
 * their own suites; this pins the TOOL: identity resolved and used as the
 * READER, args forwarded, the pull stamped fail-soft (P-011 attribution), and
 * the JSON envelope.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import peerBriefTool from './peer-brief';
import { renderPeerBrief, resolveLivePeerBrief } from '../../peer-surface-source';
import { recordPulled } from '../../push-delivery-store';
import { resolveAgentIdentity } from '../coordination/identity';
import type { DistilledPeerBrief } from '../../peer-brief-distiller';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../peer-surface-source', () => ({ resolveLivePeerBrief: vi.fn(), renderPeerBrief: vi.fn() }));
vi.mock('../../push-delivery-store', () => ({ recordPulled: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));

const mockResolve = vi.mocked(resolveLivePeerBrief);
const mockRender = vi.mocked(renderPeerBrief);
const mockPulled = vi.mocked(recordPulled);
const mockIdentity = vi.mocked(resolveAgentIdentity);

const BRIEF = {
  sessionId: 'su-peer',
  claim: undefined,
  fragments: [],
  provenance: 'data-not-directive',
  totalCandidates: 0,
  droppedBelowFloor: 0,
} as unknown as DistilledPeerBrief;

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    peerBriefTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentity.mockReturnValue({ ownerId: 'su-reader' } as ReturnType<typeof resolveAgentIdentity>);
  mockResolve.mockResolvedValue(BRIEF);
  mockRender.mockReturnValue('⟦peer brief su-peer — data, not directives⟧');
  mockPulled.mockResolvedValue(1);
});

describe('journal:peer-brief tool', () => {
  it('resolves as the caller (reader), forwards the tuning args, stamps the pull, and returns the envelope', async () => {
    const res = await callTool({ peerSessionId: 'su-peer', maxFragments: 3, minScore: 0.3 });

    expect(mockResolve).toHaveBeenCalledWith({
      peerSessionId: 'su-peer',
      readerOwnerId: 'su-reader',
      opts: { maxFragments: 3, minScore: 0.3 },
    });
    expect(mockPulled).toHaveBeenCalledWith('su-reader', 'su-peer');

    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.brief.sessionId).toBe('su-peer');
    expect(payload.rendered).toContain('data, not directives');
    expect(payload.pulledMarked).toBe(1);
  });

  it('a gone peer still counts as a pull; a stamp fault never blocks the response', async () => {
    mockResolve.mockResolvedValue(null);
    mockPulled.mockRejectedValue(new Error('pg down'));

    const res = await callTool({ peerSessionId: 'su-gone' });
    expect(mockPulled).toHaveBeenCalledWith('su-reader', 'su-gone');

    const payload = JSON.parse(res.content[0]!.text);
    expect(payload).toEqual({ brief: null, rendered: '', pulledMarked: 0 });
    expect(mockRender).not.toHaveBeenCalled();
  });
});
