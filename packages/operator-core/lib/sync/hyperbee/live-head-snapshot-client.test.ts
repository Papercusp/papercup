/**
 * P-019 (D-012) — the cutter-side client that asks the LIVE operator holding a hive
 * to append a head snapshot, so a `--sparse` cut can be taken with NO OUTAGE.
 *
 * Discovery and transport are injectable. One loopback server also exercises the
 * real HTTP deadline so mocked fetches cannot hide an independent transport timeout.
 */
import { createServer } from 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS,
  DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS,
  DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
  DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS,
  HEAD_SNAPSHOT_MAX_TIMEOUT_MS,
  HEAD_SNAPSHOT_MIN_TIMEOUT_MS,
  deriveHeadSnapshotTimeoutMs,
  findLiveOperatorHoldingHive,
  HEAD_SNAPSHOT_PATH,
  requestLiveOperatorHeadSnapshot,
  waitForLiveOperatorHoldingHive,
} from './live-head-snapshot-client';

interface Call {
  url: string;
  body: Record<string, unknown>;
  timeoutish: boolean;
}

/**
 * A fake sibling fleet. `holderPort` answers `booted:true`; every other port answers
 * `booted:false`; a port in `dead` refuses the connection; a port in `staleBuild` is
 * ALIVE but 404s this route (its build predates it — the P-014/WI-10773 case).
 */
function fleet(opts: {
  ports: number[];
  holderPort?: number;
  logLength?: number;
  dead?: number[];
  staleBuild?: number[];
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
    // Serving fine, but this ROUTE does not exist in that build.
    if (opts.staleBuild?.includes(port)) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    const booted = port === opts.holderPort;
    if (!booted) return { ok: true, status: 200, json: async () => ({ ok: true, booted: false }) };
    if (body.probeOnly === true) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          booted: true,
          probeOnly: true,
          ...(opts.logLength === undefined ? {} : { logLength: opts.logLength }),
        }),
      };
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

  it('carries the O(1) own-log length from the probe for timeout sizing', async () => {
    const f = fleet({ ports: [3271], holderPort: 3271, logLength: 7_657_919 });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out).toMatchObject({ kind: 'holder', logLength: 7_657_919 });
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

  it('distinguishes a STALE-BUILD sibling (alive, 404s this route) from a dead port', async () => {
    // The measured P-014/WI-10773 case: papercup-bg-host HELD the corestore write lock
    // and served every other internal route, but had started 9 minutes before the
    // head-snapshot route file existed, so it 404'd this one path. Both a 404 and a
    // refused connection are the same `__transportError` on the wire, and reporting them
    // identically hid the holder inside a list of ports that "did not answer" — while
    // the message said no process on the box held the hive, the opposite of the truth.
    const f = fleet({ ports: [3070, 3170, 3271], staleBuild: [3271], dead: [3170] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out.kind).toBe('no-holder');
    if (out.kind !== 'no-holder') return;
    expect(out.staleBuild).toEqual([3271]);
    // A refused connection is NOT a stale build — the remedies differ, so the two must
    // not collapse back together.
    expect(out.staleBuild).not.toContain(3170);
    // Neither one answered, so the pre-existing field is unchanged for both.
    expect(out.answered).toEqual([3070]);
  });

  it('a fleet with no 404s reports an EMPTY staleBuild (the field never fires spuriously)', async () => {
    const f = fleet({ ports: [3070, 3170], dead: [3170] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out.kind === 'no-holder' && out.staleBuild).toEqual([]);
  });

  it('finds the holder even when a SIBLING is unreachable (one bad process must not blind the search)', async () => {
    const f = fleet({ ports: [3070, 3170, 3271], holderPort: 3271, dead: [3170] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out.kind === 'holder' && out.sibling.port).toBe(3271);
  });

  it('no siblings on the box at all ⇒ no-holder with an empty probe list', async () => {
    const f = fleet({ ports: [] });
    const out = await findLiveOperatorHoldingHive({ ...base, ...f });
    expect(out).toEqual({ kind: 'no-holder', answered: [], probed: [], staleBuild: [] });
  });
});

describe('requestLiveOperatorHeadSnapshot', () => {
  it('keeps the caller deadline when response headers outlast the default dispatcher timeout', async () => {
    const original = getGlobalDispatcher();
    const shortDeadline = new Agent({ headersTimeout: 50 });
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const probe = JSON.parse(body).probeOnly === true;
      const reply = () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            probe
              ? { ok: true, booted: true }
              : {
                  ok: true,
                  booted: true,
                  appended: true,
                  coversUpTo: 12,
                  chunkCount: 1,
                  rowCount: 3,
                  elapsedMs: 1_600,
                },
          ),
        );
      };
      if (probe) reply();
      else {
        const timer = setTimeout(reply, 1_600);
        res.on('close', () => clearTimeout(timer));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    setGlobalDispatcher(shortDeadline);
    try {
      const out = await requestLiveOperatorHeadSnapshot({
        ...base,
        timeoutMs: 5_000,
        retryBudgetMs: 0,
        listSiblingsImpl: async () => [{ port, pid: process.pid, startedAt: 1 }],
      });
      expect(out).toMatchObject({ kind: 'produced', appended: true, coversUpTo: 12, rowCount: 3 });
    } finally {
      setGlobalDispatcher(original);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await shortDeadline.close();
    }
  });

  it('retains the underlying transport error instead of reporting only fetch failed', async () => {
    const f = fleet({ ports: [3070], holderPort: 3070 });
    const out = await requestLiveOperatorHeadSnapshot({
      ...base,
      ...f,
      retryBudgetMs: 0,
      fetchImpl: async (_url, init) => {
        if (JSON.parse(init.body).probeOnly)
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, booted: true }),
          };
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
        });
      },
    });
    expect(out).toMatchObject({
      kind: 'failed',
      transport: true,
      error: 'fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)',
    });
  });

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
    expect(out).toEqual({
      kind: 'failed',
      port: 3070,
      error: 'this harness engine is stopped/closing.',
      transport: false,
    });
  });

  it('a transport failure on the REAL call is FAILED, not no-holder (the difference is the remedy)', async () => {
    // no-holder ⇒ "nobody has this hive". failed ⇒ "the holder tried and could not."
    // Collapsing them would send a human to check the wrong thing.
    let phase = 0;
    const f = fleet({
      ports: [3070],
      holderPort: 3070,
      onCall: (c) => {
        if (c.body.probeOnly !== true) phase = 1;
      },
    });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const r = await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
      if (phase === 1) throw new Error('socket hang up');
      return r;
    }) as never;
    // retryBudgetMs:0 pins ONE attempt, so this stays a test about classification.
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f, fetchImpl, retryBudgetMs: 0 });
    expect(out).toEqual({ kind: 'failed', port: 3070, error: 'socket hang up', transport: true });
  });

  it('propagates no-holder from discovery without ever making the expensive call', async () => {
    const f = fleet({ ports: [3070, 3170] });
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f, retryBudgetMs: 0 });
    expect(out.kind).toBe('no-holder');
    expect(f.calls.every((c) => c.body.probeOnly === true)).toBe(true);
  });
});

/**
 * P-014 (2026-08-09). The holder self-recycles roughly twice as often as a cut needs it
 * to stay up, so surviving a recycle is the difference between a cut that lands and one
 * that throws away a 17-minute drain.
 */
describe('retrying across a holder recycle', () => {
  /** Records sleeps instead of taking them, so budget arithmetic is exact and instant. */
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      nowImpl: () => t,
      sleepImpl: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    };
  }

  it('a holder that recycles mid-request is WAITED OUT — the cut lands instead of dying', async () => {
    // The measured failure: discovery finds a booted holder, then the POST hits the
    // restart and returns `fetch failed`. Attempt 2 finds the new process and succeeds.
    let realCalls = 0;
    const f = fleet({ ports: [3070, 3271], holderPort: 3271 });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const isReal = JSON.parse(init.body).probeOnly !== true;
      if (isReal && ++realCalls === 1) throw new Error('fetch failed');
      return await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
    }) as never;

    const c = clock();
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f, fetchImpl, ...c });

    expect(out.kind).toBe('produced');
    expect(realCalls).toBe(2);
    expect(out.retry).toEqual({
      attempts: 2,
      waitedMs: DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
      elapsedMs: DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
    });
  });

  it('starts a retry after the first attempt consumes the full default timeout', async () => {
    // The retry budget must cover the complete in-flight timeout plus the next delay.
    // Otherwise the budget guard returns the first transport failure before retrying.
    let virtualNow = 0;
    let realCalls = 0;
    const f = fleet({ ports: [3070], holderPort: 3070 });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.probeOnly !== true) {
        realCalls += 1;
        if (realCalls === 1) {
          virtualNow += DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS;
          throw new Error('request timed out');
        }
      }
      return await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
    }) as never;

    const out = await requestLiveOperatorHeadSnapshot({
      ...base,
      ...f,
      fetchImpl,
      nowImpl: () => virtualNow,
      sleepImpl: async (ms) => {
        virtualNow += ms;
      },
    });

    expect(out).toMatchObject({ kind: 'produced', port: 3070 });
    expect(realCalls).toBe(2);
    expect(out.retry).toEqual({
      attempts: 2,
      waitedMs: DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
      elapsedMs: DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS + DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
    });
  });

  it('aborts an in-flight request when the specific holder disappears', async () => {
    let replacementActive = false;
    let realStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      realStarted = resolve;
    });
    let aborted = false;
    let realCalls = 0;
    const original = { port: 3271, pid: 4271, startedAt: 1 };
    const replacement = { port: 3271, pid: 5271, startedAt: 2 };
    const listSiblingsImpl = (async () => [replacementActive ? replacement : original]) as never;
    const fetchImpl = (async (_url: string, init: { body: string; signal: AbortSignal }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.probeOnly === true) {
        return { ok: true, status: 200, json: async () => ({ ok: true, booted: true, probeOnly: true }) };
      }
      realCalls += 1;
      if (realCalls > 1) {
        return { ok: true, status: 200, json: async () => ({ ok: true, appended: true, coversUpTo: 11 }) };
      }
      realStarted();
      return await new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('holder disappeared; request aborted'));
          },
          { once: true },
        );
      });
    }) as never;

    const request = requestLiveOperatorHeadSnapshot({
      ...base,
      listSiblingsImpl,
      fetchImpl,
      retryBudgetMs: 1_000,
      retryDelayMs: 0,
      holderLivenessIntervalMs: 1,
    });
    await started;
    replacementActive = true;
    const out = await request;

    expect(out).toMatchObject({ kind: 'produced', port: replacement.port, coversUpTo: 11 });
    expect(aborted).toBe(true);
    expect(realCalls).toBe(2);
  });

  it('does NOT abort a live holder just because another short HTTP probe would time out', async () => {
    // EI-20514105789487043: the real head snapshot is O(own-log) and can make the
    // holder's HTTP loop miss the 1.5s discovery deadline for minutes. The liveness
    // watcher used to run findLiveOperatorHoldingHive here, so the snapshot made its
    // own probe time out and the client aborted a process that never died.
    let markRealStarted!: () => void;
    const realStarted = new Promise<void>((resolve) => {
      markRealStarted = resolve;
    });
    let finishReal!: () => void;
    let aborted = false;
    let probeCalls = 0;
    const holder = { port: 3271, pid: 4271, startedAt: 1 };
    const listSiblingsImpl = (async () => [holder]) as never;
    const fetchImpl = (async (_url: string, init: { body: string; signal: AbortSignal }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.probeOnly === true) {
        probeCalls += 1;
        if (probeCalls === 1) {
          return { ok: true, status: 200, json: async () => ({ ok: true, booted: true }) };
        }
        // CONTROL for the old implementation: any liveness HTTP probe stalls past
        // its deadline, exactly as the live bg-host did while producing the snapshot.
        return await new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('probe timed out')), {
            once: true,
          });
        });
      }

      markRealStarted();
      return await new Promise<{
        ok: true;
        status: 200;
        json: () => Promise<Record<string, unknown>>;
      }>((resolve, reject) => {
        finishReal = () =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, appended: true, coversUpTo: 17 }),
          });
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('live holder was falsely aborted'));
          },
          { once: true },
        );
      });
    }) as never;

    const request = requestLiveOperatorHeadSnapshot({
      ...base,
      listSiblingsImpl,
      fetchImpl,
      retryBudgetMs: 0,
      probeTimeoutMs: 1,
      holderLivenessIntervalMs: 1,
    });
    await realStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(aborted).toBe(false);
    expect(probeCalls).toBe(1); // discovery only; liveness is process-identity based
    finishReal();
    await expect(request).resolves.toMatchObject({ kind: 'produced', coversUpTo: 17 });
  });

  it('CONTROL: the same recycle KILLS the cut when retry is disabled', async () => {
    // Without this the test above passes just as happily against a build that never
    // retries at all — the fake would simply not get asked a second time.
    let realCalls = 0;
    const f = fleet({ ports: [3070, 3271], holderPort: 3271 });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const isReal = JSON.parse(init.body).probeOnly !== true;
      if (isReal && ++realCalls === 1) throw new Error('fetch failed');
      return await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
    }) as never;

    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f, fetchImpl, retryBudgetMs: 0 });
    expect(out).toMatchObject({ kind: 'failed', transport: true, error: 'fetch failed' });
    expect(realCalls).toBe(1);
  });

  it('waits out a COLD hive too — a just-restarted holder reads as no-holder while its LRU warms', async () => {
    // D-025: the new process takes the fd lock immediately but `getBootedHarness` is an
    // in-process LRU that stays cold until something touches the hive, so the box reports
    // booted:false everywhere. Transient, and indistinguishable from "nothing holds it".
    let booted = false;
    const listSiblingsImpl = (async () => [{ port: 3271, pid: 4271, startedAt: 1 }]) as never;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const probe = JSON.parse(init.body).probeOnly === true;
      if (probe) {
        const was = booted;
        booted = true; // warms by the next pass
        return { ok: true, status: 200, json: async () => ({ ok: true, booted: was }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, appended: true, coversUpTo: 9 }) };
    }) as never;

    const c = clock();
    const out = await requestLiveOperatorHeadSnapshot({ ...base, listSiblingsImpl, fetchImpl, ...c });
    expect(out).toMatchObject({ kind: 'produced', coversUpTo: 9 });
    expect(out.retry?.attempts).toBe(2);
  });

  it('does NOT retry an operator that ANSWERED and refused — that is a real answer', async () => {
    // Retrying it would burn the whole budget re-asking a question already answered.
    const f = fleet({
      ports: [3070],
      holderPort: 3070,
      snapshotReply: { ok: false, error: 'this harness engine is stopped/closing.' },
    });
    const c = clock();
    const out = await requestLiveOperatorHeadSnapshot({ ...base, ...f, ...c });
    expect(out).toMatchObject({ kind: 'failed', transport: false });
    expect(c.slept).toEqual([]);
  });

  it('gives up inside the budget, and reports how hard it tried', async () => {
    // A holder that never comes back must terminate — and say so, so the refusal is not
    // mistaken for a transient blip worth re-running a 17-minute drain against.
    const f = fleet({ ports: [3070], holderPort: 3070 });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      if (JSON.parse(init.body).probeOnly !== true) throw new Error('fetch failed');
      return await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
    }) as never;

    const c = clock();
    const out = await requestLiveOperatorHeadSnapshot({
      ...base,
      ...f,
      fetchImpl,
      ...c,
      retryBudgetMs: 60_000,
      retryDelayMs: 15_000,
    });
    expect(out.kind).toBe('failed');
    // Spends the budget exactly and never overruns it: 4×15s of waiting fills 60s, and
    // the 5th attempt is the one that reports the give-up rather than sleeping past it.
    expect(c.slept).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(out.retry).toEqual({ attempts: 5, waitedMs: 60_000, elapsedMs: 60_000 });
  });

  it('the PRE-FLIGHT gate waits for a cold holder to warm instead of refusing in 32s', async () => {
    // The measured attempt-1 failure: every port answered booted:false during a recycle,
    // the cut refused, and 18 minutes later the same probe answered booted:true.
    let passes = 0;
    const findHolderImpl = async () =>
      ++passes < 3
        ? { kind: 'no-holder' as const, answered: [3271], probed: [3271], staleBuild: [] }
        : { kind: 'holder' as const, sibling: { port: 3271, pid: 4271, startedAt: 1 } };

    const c = clock();
    const out = await waitForLiveOperatorHoldingHive({ ...base, findHolderImpl: findHolderImpl as never, ...c });
    expect(out.kind).toBe('holder');
    expect(passes).toBe(3);
  });

  it('CONTROL: a single look REFUSES on that same cold window', async () => {
    // Pins that the test above measures the waiting, not the fake being generous.
    let passes = 0;
    const findHolderImpl = async () =>
      ++passes < 3
        ? { kind: 'no-holder' as const, answered: [3271], probed: [3271], staleBuild: [] }
        : { kind: 'holder' as const, sibling: { port: 3271, pid: 4271, startedAt: 1 } };

    const out = await waitForLiveOperatorHoldingHive({
      ...base,
      findHolderImpl: findHolderImpl as never,
      retryBudgetMs: 0,
    });
    expect(out.kind).toBe('no-holder');
    expect(passes).toBe(1);
  });

  it('a holder that never comes back still terminates — waiting cannot become hanging', async () => {
    // Siblings exist but none ever boots: worth waiting out, but strictly bounded.
    const findHolderImpl = (async () => ({
      kind: 'no-holder' as const,
      answered: [3070],
      probed: [3070, 3271],
      staleBuild: [],
    })) as never;
    const c = clock();
    const out = await waitForLiveOperatorHoldingHive({
      ...base,
      findHolderImpl,
      ...c,
      retryBudgetMs: 60_000,
      retryDelayMs: 15_000,
    });
    expect(out.kind).toBe('no-holder');
    expect(c.slept).toEqual([15_000, 15_000, 15_000, 15_000]);
  });

  it('a box with NO operator at all refuses instantly — it is an absence, not a recycle', async () => {
    // Waiting 10 minutes to say "there is no operator here" would be a regression in the
    // one case where the one-shot answer was always right (a CI box, a dev checkout).
    const findHolderImpl = (async () => ({
      kind: 'no-holder' as const,
      answered: [],
      probed: [],
      staleBuild: [],
    })) as never;
    const c = clock();
    const out = await waitForLiveOperatorHoldingHive({ ...base, findHolderImpl, ...c });
    expect(out.kind).toBe('no-holder');
    expect(c.slept).toEqual([]);
  });

  it('the retry budget outlasts a real bg-host recycle', async () => {
    // Measured cadence 2026-08-09: 8.5m/8.5m/15.7m/26.8m/8.5m/8.5m between restarts, and
    // a recycle returns in seconds. A budget under one recycle would be decorative.
    expect(DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS).toBeLessThanOrEqual(30_000);
    expect(DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS).toBeGreaterThan(
      DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS + DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS,
    );
  });
});

describe('budgets', () => {
  it('derives from own-log blocks, with a floor and ceiling, rather than folded row count', () => {
    expect(deriveHeadSnapshotTimeoutMs(0)).toBe(HEAD_SNAPSHOT_MIN_TIMEOUT_MS);
    expect(deriveHeadSnapshotTimeoutMs(7_657_919)).toBeGreaterThan(18 * 60_000);
    expect(deriveHeadSnapshotTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(HEAD_SNAPSHOT_MAX_TIMEOUT_MS);
    expect(deriveHeadSnapshotTimeoutMs(undefined)).toBe(DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS);
  });

  it('expands the retry budget when a measured corpus needs more than the fallback', async () => {
    const logLength = 200_000_000;
    const derivedTimeout = deriveHeadSnapshotTimeoutMs(logLength);
    expect(derivedTimeout).toBeGreaterThan(DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS);
    let virtualNow = 0;
    let realCalls = 0;
    const f = fleet({ ports: [3271], holderPort: 3271, logLength });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.probeOnly !== true && ++realCalls === 1) {
        virtualNow += derivedTimeout;
        throw new Error('request timed out');
      }
      return await (f.fetchImpl as unknown as (u: string, i: { body: string }) => Promise<unknown>)(url, init);
    }) as never;
    const out = await requestLiveOperatorHeadSnapshot({
      ...base,
      ...f,
      fetchImpl,
      nowImpl: () => virtualNow,
      sleepImpl: async (ms) => { virtualNow += ms; },
    });
    expect(out).toMatchObject({ kind: 'produced', port: 3271 });
    expect(realCalls).toBe(2);
  });

  it('the REAL call gets a far longer deadline than discovery', async () => {
    // Discovery is a memory-map lookup; the real call reads ~461k blocks. A cut that
    // gives up early leaves the operator still doing the work while the cut degrades to
    // a full seed — the worst of both outcomes.
    expect(DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
