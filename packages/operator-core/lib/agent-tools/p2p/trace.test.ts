import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listP2pReceipts: vi.fn(),
  listRefusedOpCounters: vi.fn(),
  resolveDelegatedSpawnOutcome: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveP2pGrantWorkspace: vi.fn(),
  getBuildInfo: vi.fn(),
}));

vi.mock('../../p2p/receipts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../p2p/receipts')>()),
  listP2pReceipts: mocks.listP2pReceipts,
  listRefusedOpCounters: mocks.listRefusedOpCounters,
}));
vi.mock('../../p2p/delegated-spawn-outcome-resolve', () => ({
  resolveDelegatedSpawnOutcome: mocks.resolveDelegatedSpawnOutcome,
}));
vi.mock('../../p2p/grant-store', () => ({ resolveP2pGrantWorkspace: mocks.resolveP2pGrantWorkspace }));
vi.mock('../../build-info', () => ({ getBuildInfo: mocks.getBuildInfo }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.resolveAgentIdentity }));

import tool from './trace';
import type { P2pReceipt } from '../../p2p/receipts';

const receipt = (id: string, detail: string, action = 'delegated-seat:spawn'): P2pReceipt => ({
  workspaceId: 'ws-1',
  potSlug: 'papercusp',
  receiptId: id,
  kind: 'honored',
  offerId: 'spawnreq-1',
  action,
  refusalCode: null,
  missingCapability: null,
  budgetAxis: null,
  detail,
  requesterKind: null,
  requesterRef: null,
  requesterGithubUserId: null,
  responderGithubUserId: 123,
  responderDevicePubkey: 'device-1',
  receiptTs: 1,
  origin: 'remote',
});

function outcome(responderBuild: Record<string, unknown> | null) {
  return {
    outcome: {
      verdict: 'honored-unverified',
      detail: 'remote host launched the member',
      attribution: 'none',
      members: [],
      shortfall: 0,
      actionable: false,
    },
    request: { offerId: 'spawnreq-1', fleetSlug: 'fleet-1', count: 1, requestedAtMs: 1 },
    responderBuild,
    targetOfferId: 'seat-1',
    honoringDevicePubkey: 'device-1',
    memberEvidenceAvailable: false,
    concurrentRequests: 0,
    requesterOwnerId: 'su-requester',
    planSlug: 'plan-1',
  };
}

async function runTrace() {
  const result = (await tool.handler({ pot: 'papercusp', offerId: 'spawnreq-1' } as never, {} as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as {
    tracingBuild: { sha: string | null; version: string };
    receipts: Array<{ receiptId: string; responderBuild?: Record<string, unknown> }>;
    spawnRequestOutcome: { responderBuild: Record<string, unknown> };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentIdentity.mockReturnValue({ workspaceId: 'ws-1', ownerId: 'su-reader' });
  mocks.resolveP2pGrantWorkspace.mockReturnValue('ws-1');
  mocks.getBuildInfo.mockReturnValue({ sha: 'abcdef1', version: '0.0.13' });
  mocks.listRefusedOpCounters.mockResolvedValue([]);
});

describe('p2p:trace responder build provenance', () => {
  it('exposes current, legacy, and unknown evidence with honest same/skew/unknown comparisons', async () => {
    mocks.listP2pReceipts.mockResolvedValue([
      receipt('same', 'honored [responder-build sha=abcdef123456 version=0.0.13]'),
      receipt('skew', 'honored [responder-build sha=fedcba9 version=0.0.13]'),
      receipt('legacy', 'legacy honored receipt'),
      receipt('unknown', 'honored [responder-build sha=unknown version=0.0.13]'),
      receipt('unrelated', 'ordinary receipt', 'work-offer:claim'),
    ]);
    mocks.resolveDelegatedSpawnOutcome.mockResolvedValue(
      outcome({
        state: 'current',
        sha: 'fedcba9',
        version: '0.0.13',
        marker: '[responder-build sha=fedcba9 version=0.0.13]',
        detail: 'honored [responder-build sha=fedcba9 version=0.0.13]',
      }),
    );

    const out = await runTrace();
    expect(out.tracingBuild).toEqual({ sha: 'abcdef1', version: '0.0.13' });
    expect(out.receipts.find((row) => row.receiptId === 'same')!.responderBuild).toMatchObject({
      evidence: 'current',
      sha: 'abcdef123456',
      comparison: 'same',
    });
    expect(out.receipts.find((row) => row.receiptId === 'skew')!.responderBuild).toMatchObject({
      evidence: 'current',
      sha: 'fedcba9',
      comparison: 'skew',
      chronology: 'not-measured',
    });
    expect(String(out.receipts.find((row) => row.receiptId === 'skew')!.responderBuild!.comparisonDetail)).toContain(
      'chronology were not measured',
    );
    expect(out.receipts.find((row) => row.receiptId === 'legacy')!.responderBuild).toMatchObject({
      evidence: 'legacy',
      comparison: 'unknown',
    });
    expect(out.receipts.find((row) => row.receiptId === 'unknown')!.responderBuild).toMatchObject({
      evidence: 'unknown',
      comparison: 'unknown',
    });
    expect(out.receipts.find((row) => row.receiptId === 'unrelated')!.responderBuild).toBeUndefined();
    expect(out.spawnRequestOutcome.responderBuild).toMatchObject({
      evidence: 'current',
      comparison: 'skew',
      chronology: 'not-measured',
    });
  });

  it('reports unavailable responder evidence as unknown instead of healthy or same-build', async () => {
    mocks.listP2pReceipts.mockResolvedValue([]);
    mocks.resolveDelegatedSpawnOutcome.mockResolvedValue(outcome(null));
    const out = await runTrace();
    expect(out.spawnRequestOutcome.responderBuild).toEqual({
      evidence: 'unavailable',
      sha: null,
      version: null,
      comparison: 'unknown',
      comparisonDetail: 'no honored/refusal receipt is available to identify the responder build.',
    });
  });
});
