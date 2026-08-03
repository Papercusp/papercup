/**
 * P-019 (D-012) — the cutter-side client that asks the LIVE operator holding a hive
 * to append a head snapshot, so a `--sparse` cut can be taken with NO OUTAGE.
 *
 * Everything here is injectable (`fetchImpl`, `listSiblingsImpl`), so these are pure
 * unit tests: no ports, no processes, no discovery files.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS,
  DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS,
  findLiveOperatorHoldingHive,
  HEAD_SNAPSHOT_PATH,
  requestLiveOperatorHeadSnapshot,
} from './live-head-snapshot-client';

interface Call {
  url: string;
  body: Record<string, unknown>;
  timeoutish: boolean;
}

/**
 * A fake sibling fleet. `holderPort` answers `booted:true`; every other port answers
 * `booted:false`; a port in `dead` refuses the connection.
 */
function fleet(opts: {
  ports: number[];
  holderPort?: number;
  dead?: number[];
  snapshotReply?: Record<string, unknown>;
  onCall?: (c: Call) => void;
}) {
  const calls: Call[] = [];
  const listSiblingsImpl = (async (o?: { selfPort?: number }) => {
    listSiblingsImpl.sawSelfPort = o?.selfPort;
    return opts.ports.map((port) => ({ port, pid: 1000 + port, startedAt: 1 }));
  }) as ((o?: { selfPort?: number }) => Promise<{ port: number; pid: number; startedAt: number }[]>) & {
    sawSelfPort?: number;
  };

  const fetchImpl = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const call: Call = { url, body, timeoutish: false };
    calls.push(call);
    opts.onCall?.(call);
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    if (opts.dead?.includes(port)) throw new Error('ECONNREFUSED');
    const booted = port === opts.holderPort;
    if (!booted) return { ok: true, status: 200, json: async () => ({ ok: true, booted: false }) };
    if (body.probeOnly === true) {
      return { ok: true, status: 200, json: async () => ({ ok: true, booted: true, probeOnly: true }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        opts.snapshotReply ?? {
          ok: true,
          booted: true,
          process: 'operator',
          appended: true,
          coversUpTo: 461_475,
          chunkCount: 10,
          rowCount: 12_345,
          elapsedMs: 8_200,
        },
    };
  }) as never;

  return { calls, fetchImpl, listSiblingsImpl };
}

const base = { workspaceId: 'ws', hive: 'papercusp', warn: () => {} };

describe('findLiveOperatorHoldingHive', () => {
  it('excludes NOTHING from discovery — the cutter is a CLI and serves no port', async () => {
    // The default (`ownHonoPort()`, which falls back to 3070) would silently skip the
    // release operator — the single most likely holder — and the symptom would be an
    // unexplained no-holder on a perfectly healthy box.
    const f = fleet({ ports: [3070, 3170, 3271], holderPort: 3070 });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(f.listSiblingsImpl.sawSelfPort).toBe(-1);
    expect(out.kind).toBe('holder');
    expect(out.kind === 'holder' && out.sibling.port).toBe(3070);
  });

  it('is side-effect-free: every discovery call carries probeOnly', async () => {
    // This is what lets the cut refuse BEFORE backfillLocalState INSERTs into
    // substrate_outbox (the P-014 fail-before-mutating invariant).
    const f = fleet({ ports: [3070, 3170], holderPort: 3170 });
    await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((c) => c.body.probeOnly === true)).toBe(true);
    expect(f.calls.every((c) => c.url.endsWith(HEAD_SNAPSHOT_PATH))).toBe(true);
  });

  it('reports no-holder (never throws) when no sibling has the hive booted', async () => {
    const f = fleet({ ports: [3070, 3170] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out.kind).toBe('no-holder');
    expect(out.kind === 'no-holder' && out.probed).toEqual([3070, 3170]);
    expect(out.kind === 'no-holder' && out.answered).toEqual([3070, 3170]);
  });

  it('distinguishes "answered, not mine" from "never answered" — a dead sibling is not a silent miss', async () => {
    const f = fleet({ ports: [3070, 3170], dead: [3170] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out.kind).toBe('no-holder');
    expect(out.kind === 'no-holder' && out.probed).toEqual([3070, 3170]);
    // 3170 threw, so it never answered: the diagnosis a human reads says so.
    expect(out.kind === 'no-holder' && out.answered).toEqual([3070]);
  });

  it('finds the holder even when a SIBLING is unreachable (one bad process must not blind the search)', async () => {
    const f = fleet({ ports: [3070, 3170, 3271], holderPort: 3271, dead: [3170] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out.kind === 'holder' && out.sibling.port).toBe(3271);
  });

  it('no siblings on the box at all ⇒ no-holder with an empty probe list', async () => {
    const f = fleet({ ports: [] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out).toEqual({ kind: 'no-holder', answered: [], probed: [] });
  });
});

describe('requestLiveOperatorHeadSnapshot', () => {
  it('asks ONLY the holder to do the expensive thing — the O(own-log) call is never fanned out', async () => {
    // The real call reads the entire own log and stalls the holder's merge loop. Fanning
    // that across every operator on the box to find one would put all of them at risk.
    const f = fleet({ ports: [3070, 3170, 3271], holderPort: 3170 });
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f });
    expect(out.kind).toBe('produced');
    const real = f.calls.filter((c) => c.body.probeOnly !== true);
    expect(real).toHaveLength(1);
    expect(real[0]!.url).toContain(':3170');
  });

  it('returns what actually landed, so the cut can report a real coversUpTo', async () => {
    const f = fleet({ ports: [3070], holderPort: 3070 });
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f });
    expect(out).toMatchObject({
      kind: 'produced',
      port: 3070,
      pid: 4070,
      process: 'operator',
      appended: true,
      coversUpTo: 461_475,
      chunkCount: 10,
      rowCount: 12_345,
    });
  });

  it('an operator-reported failure is a typed FAILED outcome, never a thrown error mid-cut', async () => {
    const f = fleet({
      ports: [3070],
      holderPort: 3070,
      snapshotReply: { ok: false, booted: true, error: 'this harness engine is stopped/closing.' },
    });
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f });
    expect(out).toEqual({ kind: 'failed', port: 3070, error: 'this harness engine is stopped/closing.' });
  });

  it('a transport failure on the REAL call is FAILED, not no-holder (the difference is the remedy)', async () => {
    // no-holder ⇒ "nobody has this hive". failed ⇒ "the holder tried and could not."
    // Collapsing them would send a human to check the wrong thing.
    let phase = 0;
    const f = fleet({ ports: [3070], holderPort: 3070, onCall: (c) => { if (c.body.probeOnly !== true) phase = 1; } });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const r = await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
      if (phase === 1) throw new Error('socket hang up');
      return r;
    }) as never;
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f, fetchImpl });
    expect(out).toEqual({ kind: 'failed', port: 3070, error: 'socket hang up' });
  });

  it('propagates no-holder from discovery without ever making the expensive call', async () => {
    const f = fleet({ ports: [3070, 3170] });
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f });
    expect(out.kind).toBe('no-holder');
    expect(f.calls.every((c) => c.body.probeOnly === true)).toBe(true);
  });
});

describe('budgets', () => {
  it('the REAL call gets a far longer deadline than discovery', async () => {
    // Discovery is a memory-map lookup; the real call reads ~461k blocks. A cut that
    // gives up early leaves the operator still doing the work while the cut degrades to
    // a full seed — the worst of both outcomes.
    expect(DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
