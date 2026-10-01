/**
 * cupboard:ledger-anchor / cupboard:ledger-anchor-run handlers (P-041, R-29):
 * status, prove → verify round trip, and the run tool's dry-run default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLinks, entryDigest } from '@papercusp/hash-chain';
import {
  HOUR_SECONDS,
  memoryLedgerAnchorStore,
  runAnchorTick,
  type AnchorBackend,
  type AnchoredRoot,
  type LedgerAnchorStore,
} from '../../cupboard/ledger-anchor';

const WS = 'ws-tool';
const ATTESTER = '0x00000000000000000000000000000000000a11ce';
const links = appendLinks('money-journal', null, [entryDigest({ c: 1 }), entryDigest({ c: 2 })]);

const h = vi.hoisted(() => ({
  store: null as unknown as LedgerAnchorStore,
  records: new Map<string, AnchoredRoot>(),
  runPass: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => WS }));
vi.mock('../../cupboard/ledger-chain', () => ({
  pgLedgerChainLinkStore: () => ({
    links: async (_ws: string, streamId: string) =>
      links.filter((l) => l.streamId === streamId).map((link) => ({ sourceId: `${streamId}#${link.seq}`, link })),
  }),
}));
vi.mock('../../cupboard/ledger-anchor-store', () => ({
  pgLedgerAnchorStore: () => h.store,
  pgAnchorLinkFeed: () => ({ links: async () => links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) }),
  ledgerAnchorLogId: (ws: string) => `papercusp:${ws}`,
}));
vi.mock('../../cupboard/ledger-anchor-eas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cupboard/ledger-anchor-eas')>()),
  resolveAnchorBackend: () => ({
    ok: false,
    reason: 'key-missing',
    detail: 'no anchor key at /nowhere',
    config: { backend: 'eas', rpcUrl: 'https://sepolia.base.org', chainId: 84532, keyFile: '/nowhere' },
    reader: null,
  }),
  easAnchorReader: () => ({ read: async (ref: string) => h.records.get(ref) ?? null }),
}));
vi.mock('../../cupboard/ledger-anchor-runtime', () => ({ runLedgerAnchorPass: h.runPass }));

import anchorTool from './ledger-anchor';
import runTool from './ledger-anchor-run';

const body = (response: unknown) =>
  JSON.parse((response as { content: { text: string }[] }).content[0]!.text) as Record<string, any>;

const backend: AnchorBackend = {
  kind: 'eas',
  async publish(p) {
    const ref = `0x${(h.records.size + 1).toString(16).padStart(64, '0')}`;
    h.records.set(ref, { ...p, attester: ATTESTER, revoked: false });
    return { backend: 'eas', chainId: 84532, ref, txHash: null, attester: ATTESTER };
  },
};

beforeEach(() => {
  h.store = memoryLedgerAnchorStore();
  h.records.clear();
  h.runPass.mockReset();
});

describe('cupboard:ledger-anchor', () => {
  it('status names why the backend is not ready and how far behind the log is', async () => {
    const s = body(await anchorTool.handler({ op: 'status' }, {} as never));
    expect(s).toMatchObject({
      ok: true,
      workspaceId: WS,
      backend: { ready: false, reason: 'key-missing', chainId: 84532 },
      leaves: 0,
      pendingLinks: 2,
      anchors: 0,
      latest: null,
      cadence: { status: 'missed' },
    });
  });

  it('prove returns a bundle once anchored, and verify accepts it and refuses a tampered copy', async () => {
    const proveArgs = { op: 'prove' as const, streamId: 'money-journal', seq: 1 };
    expect(body(await anchorTool.handler(proveArgs, {} as never))).toEqual({ ok: false, error: 'not-in-log' });

    const now = Math.floor(Date.now() / 1000);
    const feed = { links: async () => links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) };
    await runAnchorTick({ workspaceId: WS, logId: `papercusp:${WS}`, nowSeconds: now, store: h.store, feed, backend });

    const proved = body(await anchorTool.handler(proveArgs, {} as never));
    expect(proved.ok).toBe(true);
    const verify = (bundle: unknown) =>
      anchorTool.handler({ op: 'verify', bundle: bundle as Record<string, unknown>, expectedAttester: ATTESTER }, {} as never);
    expect(body(await verify(proved.bundle))).toMatchObject({ ok: true, attester: ATTESTER, rpcUrl: 'https://sepolia.base.org' });
    expect(body(await verify({ ...proved.bundle, logRoot: 'e'.repeat(64) }))).toMatchObject({ ok: false });
    expect(body(await verify({ ...proved.bundle, anchor: { ...proved.bundle.anchor, chainId: 1 } }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('chain 1'),
    });
    expect(body(await anchorTool.handler({ op: 'prove', streamId: 'money-journal', seq: 9 }, {} as never))).toEqual({
      ok: false,
      error: 'no-such-link',
    });
    expect(HOUR_SECONDS).toBe(3600);
  });
});

describe('cupboard:ledger-anchor-run', () => {
  it('is a dry run unless confirm:true, and only then runs the pass for this workspace', async () => {
    const dry = body(await runTool.handler({ confirm: false }, {} as never));
    expect(dry).toMatchObject({ ok: true, dryRun: true, backendReady: false, pendingLinks: 2 });
    expect(h.runPass).not.toHaveBeenCalled();

    h.runPass.mockResolvedValue({ backend: 'eas', backendUnavailable: null, workspaces: [{ workspaceId: WS, tick: { status: 'already-anchored' }, cadence: null }] });
    const ran = body(await runTool.handler({ confirm: true }, {} as never));
    expect(h.runPass).toHaveBeenCalledWith({ workspaces: [WS] });
    expect(ran).toMatchObject({ ok: true, backend: 'eas' });
  });
});
