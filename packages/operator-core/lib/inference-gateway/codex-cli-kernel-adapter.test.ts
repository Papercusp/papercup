/**
 * codex-cli-kernel-adapter.test.ts — P-005.
 *
 * These drive the adapter through the REAL `executeGatewayRequestKernel`, with
 * no gateway wiring, exactly as the P-002 and P-004 adapter suites do. The point
 * is to prove the ladder is expressible by the kernel BEFORE `gateway.ts` is
 * rewired onto it, so a failure here is a design answer rather than a
 * regression in a live handler.
 *
 * The end-to-end behaviour these must agree with is pinned separately by the
 * `cli-exec` characterization goldens in `gateway-openai-proxy.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createCodexCliKernelAdapter,
  type CodexCliKernelAdapterDeps,
  type CodexCliChunk,
  type CodexCliResponseMetadata,
  type CodexCliRouteValue,
} from './codex-cli-kernel-adapter';
import { executeGatewayRequestKernel, GatewayRequestKernelError } from './request-kernel';
import { makeGatewayLaneRegistry } from './provider-adapters';
import { GatewayRequestTelemetry } from './request-stage-telemetry';
import type { AccountPool } from './provider-contracts';
import type { CodexCliAccount, CodexCliRunOpts } from './codex-cli-bridge';
import { isCodexAuthFailure } from './codex-cli-bridge';

const AUTH_QUARANTINE_MS = 15 * 60 * 1000;
const FAILOVER_BACKOFF_MS = 30 * 1000;

const unusedPool = {
  active: () => null,
  onExhausted: () => null,
  healthyCount: () => 1,
} as unknown as AccountPool;

const laneRegistry = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
});
const lane = laneRegistry.openaiResponses;

const acct = (accountId: string): CodexCliAccount => ({ accountId, home: `/homes/${accountId}` });

/** A pool that records every park and hands back the next account round-robin,
 *  which is the shape `createFailoverPool.onExhausted` presents to the handler. */
function fakePool(ids: string[]) {
  const parked = new Map<string, number>();
  const parks: { accountId: string; untilMs: number }[] = [];
  return {
    parks,
    parked,
    onExhausted(accountId: string, untilMs: number) {
      parked.set(accountId, untilMs);
      parks.push({ accountId, untilMs });
      const next = ids.find((id) => id !== accountId && (parked.get(id) ?? 0) <= Date.now());
      return next ? { accountId: next, token: async () => '' } : null;
    },
  };
}

function makeAdapter(overrides: Partial<CodexCliKernelAdapterDeps> & { accountIds?: string[] } = {}) {
  const accountIds = overrides.accountIds ?? ['cli-a', 'cli-b'];
  const accounts = accountIds.map(acct);
  const pool = fakePool(accountIds);
  const deps: CodexCliKernelAdapterDeps = {
    initialAccount: accounts[0],
    accounts: () => accounts,
    pool,
    run: async () => ({ text: 'ok', inputTokens: 1, outputTokens: 1 }),
    model: 'gpt-5.4',
    effort: 'medium',
    prompt: 'hello',
    timeoutMs: 60_000,
    authQuarantineMs: AUTH_QUARANTINE_MS,
    failoverBackoffMs: FAILOVER_BACKOFF_MS,
    isAuthFailure: isCodexAuthFailure,
    hardPin: false,
    pinnedAccountId: null,
    ...overrides,
  };
  return { adapter: createCodexCliKernelAdapter(deps), pool, accounts, deps };
}

/** Run one request through the real kernel, wiring `observeAttempt` the way the
 *  gateway does — which is the only place the unconditional quarantine can fire. */
async function runKernel(
  adapter: ReturnType<typeof makeAdapter>['adapter'],
  opts: { hardPin?: boolean; pinnedAccountId?: string | null; maxAttempts?: number } = {},
) {
  const maxAttempts = opts.maxAttempts ?? 6;
  const seenAttempts: { attempt: number; accountId: string | null; error: string | null }[] = [];
  const started: { status: number; metadata: CodexCliResponseMetadata }[] = [];

  const result = await executeGatewayRequestKernel<
    CodexCliRouteValue,
    CodexCliRouteValue,
    CodexCliChunk,
    CodexCliResponseMetadata
  >({
    request: {
      lane,
      body: (async function* () {
        yield Buffer.from('{}');
      })(),
      ownerId: null,
      pin: opts.pinnedAccountId
        ? { accountId: opts.pinnedAccountId, mode: opts.hardPin ? 'hard' : 'soft' }
        : null,
    },
    policy: {
      maxBodyBytes: 1024 * 1024,
      bodyReadTimeoutMs: 5_000,
      requestCeilingMs: 60_000,
      ttfbTimeoutMs: 60_000,
      bodyIdleTimeoutMs: 60_000,
      downstreamIdleTimeoutMs: 60_000,
      maxAttempts,
    },
    telemetry: new GatewayRequestTelemetry(),
    admission: {
      run: (_context, task) => task(),
      observeAttempt: ({ context, error }) => {
        seenAttempts.push({
          attempt: context.attempt,
          accountId: context.route.accountId ?? null,
          error: error?.message ?? null,
        });
        if (!error) return;
        adapter.noteAttemptFailure({
          accountId: context.route.accountId ?? '',
          attempt: context.attempt,
          maxAttempts,
          message: error.message,
          aborted: false,
        });
      },
    },
    adapter,
    inFlight: { register: () => ({ unregister: () => undefined }) },
    downstream: {
      start: (response) => {
        started.push({ status: response.status, metadata: response.metadata });
      },
      write: () => undefined,
      end: () => undefined,
    },
  });

  return { result, seenAttempts, started };
}

describe('codex cli-exec kernel adapter', () => {
  it('serves the caller-resolved account without ever selecting one itself (D-010)', async () => {
    const runs: string[] = [];
    const { adapter, accounts } = makeAdapter({
      run: async (o) => {
        runs.push(o.home);
        return { text: 'served', inputTokens: 2, outputTokens: 3 };
      },
    });

    const { result, started } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.failovers).toBe(0);
    // The account came from `initialAccount` — no pool `active()` call exists here to advance.
    expect(runs).toEqual([accounts[0].home]);
    expect(started[0].metadata.accountId).toBe('cli-a');
    expect(started[0].metadata.result.text).toBe('served');
  });

  it('rotates to the next account on a run failure and reports it as ONE failover', async () => {
    const { adapter } = makeAdapter({
      run: async (o) => {
        if (o.home.endsWith('cli-a')) throw new Error('codex exited 1: transient blip');
        return { text: 'served by b', inputTokens: 1, outputTokens: 1 };
      },
    });

    const { result, seenAttempts, started } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    // Every retry on this lane is an ACCOUNT change, so attempts-1 === failovers.
    expect(result.failovers).toBe(1);
    expect(seenAttempts.map((a) => a.accountId)).toEqual(['cli-a', 'cli-b']);
    expect(started[0].metadata.accountId).toBe('cli-b');
  });

  it('parks a quota-walled account for the SHORT backoff', async () => {
    const { adapter, pool } = makeAdapter({
      run: async (o) => {
        if (o.home.endsWith('cli-a')) throw new Error('codex exited 1: usage limit reached');
        return { text: 'b', inputTokens: 1, outputTokens: 1 };
      },
    });

    const before = Date.now();
    await runKernel(adapter);

    expect(pool.parks).toHaveLength(1);
    expect(pool.parks[0].accountId).toBe('cli-a');
    const window = pool.parks[0].untilMs - before;
    expect(window).toBeGreaterThan(0);
    // A quota wall is a rate window, NOT credential death.
    expect(window).toBeLessThan(AUTH_QUARANTINE_MS);
  });

  it('parks an AUTH-DEAD account for the LONG quarantine (EI-21618978789879488)', async () => {
    const { adapter, pool } = makeAdapter({
      run: async (o) => {
        if (o.home.endsWith('cli-a')) throw new Error('codex exited 1: 401 unauthorized, run `codex login`');
        return { text: 'b', inputTokens: 1, outputTokens: 1 };
      },
    });

    const before = Date.now();
    const { result } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(pool.parks[0].accountId).toBe('cli-a');
    // Strictly longer than the quota window — that difference IS the fix.
    expect(pool.parks[0].untilMs - before).toBeGreaterThanOrEqual(AUTH_QUARANTINE_MS - 5_000);
  });

  it('quarantines credential death even on the FINAL attempt, when no retry remains', async () => {
    // THE REGRESSION CATCHER, and the reason the quarantine cannot live in
    // `selectFailover`: the kernel does not consult it once attempts are spent.
    // Before EI-21618978789879488 the park was gated on a retry being available,
    // so the last attempt left an auth-dead home fully selectable.
    const { adapter, pool } = makeAdapter({
      accountIds: ['cli-only'],
      run: async () => {
        throw new Error('codex exited 1: no usable auth.json — re-login with `codex login`');
      },
    });

    await expect(runKernel(adapter, { maxAttempts: 1 })).rejects.toBeInstanceOf(GatewayRequestKernelError);

    expect(pool.parks).toHaveLength(1);
    expect(pool.parks[0].accountId).toBe('cli-only');
    expect(pool.parks[0].untilMs).toBeGreaterThan(Date.now() + AUTH_QUARANTINE_MS - 5_000);
  });

  it('CONTROL: a quota wall on the FINAL attempt parks NOTHING — the two classes really do differ', async () => {
    // The calibration case for the test above. If this control ever starts
    // parking, the "unconditional" assertion above has stopped discriminating
    // and is merely observing that failures park accounts.
    const { adapter, pool } = makeAdapter({
      accountIds: ['cli-only'],
      run: async () => {
        throw new Error('codex exited 1: usage limit reached, try again later');
      },
    });

    await expect(runKernel(adapter, { maxAttempts: 1 })).rejects.toBeInstanceOf(GatewayRequestKernelError);

    expect(pool.parks).toEqual([]);
  });

  it('a HARD pin suppresses both the rotation and the quarantine', async () => {
    const { adapter, pool } = makeAdapter({
      hardPin: true,
      pinnedAccountId: 'cli-a',
      run: async () => {
        throw new Error('codex exited 1: 401 unauthorized');
      },
    });

    const { seenAttempts } = await runKernel(adapter, { hardPin: true, pinnedAccountId: 'cli-a' }).catch((e) => {
      expect(e).toBeInstanceOf(GatewayRequestKernelError);
      return { seenAttempts: null as never };
    });

    if (seenAttempts) expect(seenAttempts).toHaveLength(1);
    // Parking the ONLY permitted account would strand the pin rather than route
    // around it, so the live handler gates the quarantine on `!hardPin` too.
    expect(pool.parks).toEqual([]);
  });

  it('reports a soft-pin yield when the served account is not the pinned one', async () => {
    const { adapter } = makeAdapter({
      pinnedAccountId: 'cli-a',
      run: async (o) => {
        if (o.home.endsWith('cli-a')) throw new Error('codex exited 1: transient blip');
        return { text: 'b', inputTokens: 1, outputTokens: 1 };
      },
    });

    const { started } = await runKernel(adapter, { pinnedAccountId: 'cli-a' });

    expect(started[0].metadata.accountId).toBe('cli-b');
    expect(started[0].metadata.pinYieldedFrom).toBe('cli-a');
  });

  it('does not double-park when observeAttempt and selectFailover both run for one attempt', async () => {
    // `onExhausted` both PARKS and RETURNS the next account, so calling it from
    // each hook would park an extra account per retry — a slow leak that would
    // only show up as accounts mysteriously going cold under load.
    const { adapter, pool } = makeAdapter({
      accountIds: ['cli-a', 'cli-b', 'cli-c'],
      run: async (o) => {
        if (o.home.endsWith('cli-c')) return { text: 'c', inputTokens: 1, outputTokens: 1 };
        throw new Error('codex exited 1: transient blip');
      },
    });

    const { result } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(3);
    // Exactly one park per FAILED attempt, never two.
    expect(pool.parks.map((p) => p.accountId)).toEqual(['cli-a', 'cli-b']);
  });

  it('declines to rotate onto an account already tried, rather than cycling', async () => {
    const { adapter } = makeAdapter({
      accountIds: ['cli-a'],
      run: async () => {
        throw new Error('codex exited 1: transient blip');
      },
    });

    // With one account the pool has nothing to hand back, so the failure is
    // forwarded instead of looping until attempts are spent.
    await expect(runKernel(adapter)).rejects.toBeInstanceOf(GatewayRequestKernelError);
  });

  it('surfaces the run failure with the live 502 message shape', async () => {
    const { adapter } = makeAdapter({
      accountIds: ['cli-only'],
      run: async () => {
        throw new Error('codex exited 1: boom');
      },
    });

    await expect(runKernel(adapter)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('codex-cli bridge failed'),
    });
  });

  it('passes the caller-built prompt, model, effort and ceiling through to the run', async () => {
    // Typed on the real run signature: an untyped `vi.fn(async () => …)` gives
    // `mock.calls` an empty tuple type, so indexing it below is a compile error.
    const seen = vi.fn(async (_opts: CodexCliRunOpts) => ({ text: 'ok', inputTokens: 0, outputTokens: 0 }));
    const { adapter } = makeAdapter({
      run: seen as never,
      model: 'gpt-5.4',
      effort: 'xhigh',
      prompt: 'be terse\n\ncarried body',
      timeoutMs: 12_345,
    });

    await runKernel(adapter);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toMatchObject({
      home: '/homes/cli-a',
      model: 'gpt-5.4',
      effort: 'xhigh',
      prompt: 'be terse\n\ncarried body',
      timeoutMs: 12_345,
    });
  });
});
