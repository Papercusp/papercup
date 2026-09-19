/**
 * P-019 (D-012) — POST /api/internal/substrate/head-snapshot.
 *
 * The contracts under test are the ones the CALLER's fan-out depends on, and each
 * fails in an expensive direction if it drifts:
 *  • `booted:false` is a 200 — a non-holder answering 404/5xx makes "I don't have it"
 *    indistinguishable from "I am broken", and the fan-out cannot tell a miss from an
 *    outage;
 *  • never 5xx — a broken probe apparatus must not read as an unhealthy process;
 *  • `probeOnly` appends NOTHING — that is what lets the cut refuse BEFORE
 *    backfillLocalState mutates substrate_outbox.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const booted = vi.hoisted(() => ({
  handle: null as null | {
    produceHeadSnapshotNow: () => Promise<unknown>;
    ownLog: { length: number };
  },
}));

// Mock ONLY getBootedHarness, spreading the real module through. A factory that
// enumerates a sibling module's exports strands the fixture the moment anything is
// added to that module (see the repo guide's vi.mock note).
vi.mock('../../../sync/hyperbee/boot-all', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sync/hyperbee/boot-all')>()),
  getBootedHarness: () => booted.handle,
}));

const { default: route } = await import('./substrate-head-snapshot');

function post(body: unknown): Request {
  return new Request('http://127.0.0.1:3070/api/internal/substrate/head-snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (req: Request) => (route as any).handler(req) as Promise<Response>;

afterEach(() => {
  booted.handle = null;
});

const OK_SNAP = { appended: true, coversUpTo: 461_475, chunkCount: 10, rowCount: 12_345 };

describe('POST /internal/substrate/head-snapshot', () => {
  it('is registered as a loopback-only POST on the expected path', () => {
    expect(route).toMatchObject({
      method: 'POST',
      path: '/internal/substrate/head-snapshot',
      auth: 'loopback',
    });
  });

  it('a NON-holder answers 200 booted:false — not a 404, so a fan-out can tell a miss from an outage', async () => {
    const res = await call(post({ workspaceId: 'ws', hive: 'papercusp' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, booted: false });
  });

  it('the HOLDER produces the snapshot and reports what landed', async () => {
    booted.handle = { produceHeadSnapshotNow: async () => OK_SNAP, ownLog: { length: 7657919 } };
    const res = await call(post({ workspaceId: 'ws', hive: 'papercusp' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      booted: true,
      appended: true,
      coversUpTo: 461_475,
      chunkCount: 10,
      rowCount: 12_345,
    });
  });

  it('probeOnly answers booted:true and APPENDS NOTHING', async () => {
    // The whole reason the cut can refuse before mutating substrate_outbox.
    const produce = vi.fn(async () => OK_SNAP);
    booted.handle = { produceHeadSnapshotNow: produce, ownLog: { length: 7657919 } };
    const res = await call(post({ workspaceId: 'ws', hive: 'papercusp', probeOnly: true }));
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      booted: true,
      probeOnly: true,
      logLength: 7657919,
    });
    expect(produce).not.toHaveBeenCalled();
  });

  it('a THROWING producer is a 200 ok:false carrying the cause — never a 5xx', async () => {
    booted.handle = {
      ownLog: { length: 7657919 },
      produceHeadSnapshotNow: async () => {
        throw new Error('this harness engine is stopped/closing.');
      },
    };
    const res = await call(post({ workspaceId: 'ws', hive: 'papercusp' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      booted: true,
      error: expect.stringContaining('stopped/closing'),
    });
  });

  it('a SYNCHRONOUS throw is caught too (the sidecar handle throws rather than rejecting)', async () => {
    // RemoteBootedHarnessHandle.produceHeadSnapshotNow throws synchronously. If the
    // handler only awaited a rejected promise, that would escape as a 500 and the cut
    // would see a transport error instead of the real, named diagnosis.
    booted.handle = {
      ownLog: { length: 7657919 },
      produceHeadSnapshotNow: (() => {
        throw new Error('no substrate:produceHeadSnapshot RPC verb exists yet');
      }) as never,
    };
    const res = await call(post({ workspaceId: 'ws', hive: 'papercusp' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('RPC verb'),
    });
  });

  it('rejects a request missing workspaceId/hive rather than guessing a hive', async () => {
    const res = await call(post({ hive: 'papercusp' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('required') });
  });

  it('rejects malformed JSON', async () => {
    const res = await call(post('{not json'));
    expect(res.status).toBe(400);
  });

  it('identifies itself (process/pid/port) on every answer, so a fan-out can label the holder', async () => {
    const res = await call(post({ workspaceId: 'ws', hive: 'papercusp' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.process).toBe('string');
    expect(body.pid).toBe(process.pid);
    expect(typeof body.port).toBe('number');
  });
});
