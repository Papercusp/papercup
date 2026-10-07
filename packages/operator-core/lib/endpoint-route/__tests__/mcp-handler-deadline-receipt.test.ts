/**
 * MCP transport P2-5 deadline path — HANDLER-LEVEL coverage for the two
 * claims that rode on `raced.{toolOutcome,deadlineFired}` untested (WI-6914,
 * filed while closing WI-6868's closure-narrowing fix on that same holder
 * object):
 *
 *   1. On a deadline, the caller is answered immediately with a clean
 *      `request_timeout` error — the tool keeps running server-side, and its
 *      eventual replay-receipt persist does NOT re-block the response
 *      (`if (!raced.deadlineFired) await persist;` in _mcp-handler.ts).
 *   2. The receipt persisted once the tool finishes is the tool's REAL
 *      outcome, never the raced timeout envelope (EI-19301511582594101:
 *      "persisting the raced timeout envelope would make every retry replay
 *      the timeout instead of the real outcome" — `raced.toolOutcome`, never
 *      `dispatched`, is what gets stored).
 *
 * `__tests__/mcp-deadline.test.ts` already pins `raceDeadline` /
 * `effectiveMcpDeadlineMs` as ISOLATED units — no handler, no receipt
 * (op cit., grep for replay|store|persist there finds nothing).
 * `mcp-handler-gating-matrix.test.ts` drives the real handler and covers the
 * replay-receipt commit-then-store ORDERING, but never enters the deadline
 * branch at all (grep for 'deadline' in that file finds nothing) — every
 * case there takes the normal (non-deadline) path.
 *
 * This file closes exactly that gap, at the SAME "drive the real registered
 * tools/call handler" level gating-matrix uses (same seam mocks, same
 * `callTool` shape) — but as its OWN small, dedicated file rather than
 * bolted onto the shared 96-test gating-matrix file. `MCP_DEADLINE_MS` is a
 * module-load-time const read from `PAPERCUSP_MCP_DEADLINE_MS`
 * (`effectiveMcpDeadlineMs(projected.timeoutSec)` only ever RAISES it, never
 * lowers it below the base — see the WI-6914 filing), so it must be set
 * BEFORE `_mcp-handler` is imported; retrofitting that into gating-matrix's
 * shared 96 tests would apply the short deadline file-wide and risk flaking
 * unrelated cases under fleet load. A separate file with its own module
 * instance avoids that entirely.
 */
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetVerifiedSpawns } from '../../spawn-signing';
import { MCP_REQUEST_TRACE_HEADER } from '../../mcp-request-trace';
import type { McpCallResult } from '../routes/transport/mcp-diagnostic-warnings';

const h = vi.hoisted(() => {
  const fakeTx = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
  });
  const fakeSql = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeTx),
  });
  return {
    fakeTx,
    fakeSql,
    withWorkspaceCalls: [] as string[],
    withWorkspaceDelayMs: 0,
    commitFailure: null as Error | null,
    txEvents: [] as string[],
    replayStores: [] as Array<{ idempotencyKey: string; result: unknown }>,
    storedReplay: null as { content: Array<Record<string, unknown>>; _meta?: Record<string, unknown> } | null,
    invocations: [] as unknown[],
    resultDoorDelayMs: 0,
    resultDoorCalls: 0,
    handlers: new Map<string, (req: unknown, extra: unknown) => Promise<unknown>>(),
    verifySpawnParams: vi.fn(
      async (_u: unknown): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }),
    ),
    logVerificationFailure: vi.fn(async (_rec: unknown): Promise<void> => {}),
    verifyAccessToken: vi.fn(
      async (_bearer: string): Promise<Record<string, unknown> | null> => null,
    ),
    isValidSuperuserBearer: vi.fn(
      (bearer: string | null | undefined): boolean => bearer === 'test-su-bearer',
    ),
    workspaceForCoordOwner: vi.fn(async (_sid: string): Promise<string | null> => null),
    potHomeSlugForHarness: vi.fn(async (): Promise<string | null> => null),
    resolveWorkspaceForHarnessSlugIn: vi.fn(
      async (preferredWs: string): Promise<string | null> => preferredWs,
    ),
  };
});

// Same capture shim gating-matrix.test.ts uses — no real streamable-HTTP transport.
vi.mock('mcp-handler', () => ({
  createMcpHandler: (
    setup: (server: {
      server: { setRequestHandler: (schema: unknown, fn: unknown) => void };
    }) => void,
  ) => {
    setup({
      server: {
        setRequestHandler: (schema: unknown, fn: unknown) => {
          const s = schema as {
            shape?: { method?: { value?: string; _def?: { value?: string } } };
          };
          const method = s?.shape?.method?.value ?? s?.shape?.method?._def?.value;
          h.handlers.set(String(method), fn as (req: unknown, extra: unknown) => Promise<unknown>);
        },
      },
    });
    return async () => new Response(null);
  },
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.fakeSql }),
    withWorkspace: async <T>(ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      h.withWorkspaceCalls.push(ws);
      if (h.withWorkspaceDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, h.withWorkspaceDelayMs));
      }
      const out = await fn(h.fakeTx);
      if (h.commitFailure) throw h.commitFailure;
      h.txEvents.push('commit');
      return out;
    },
  };
});
// The seam under test: capture every persisted replay receipt, plain functions
// (not vi.fn()) so beforeEach's vi.resetAllMocks() cannot strip the impl out
// from under the assertions — the same reason gating-matrix.test.ts does this.
vi.mock('../routes/transport/_mcp-result-replay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    lookupStoredMcpResult: async (): Promise<Record<string, unknown> | null> =>
      h.storedReplay
        ? { ...h.storedReplay, _meta: { ...(h.storedReplay._meta ?? {}), replayed: true } }
        : null,
    storeMcpResult: async (a: { idempotencyKey: string; result: unknown }): Promise<void> => {
      h.txEvents.push('store');
      h.replayStores.push({ idempotencyKey: a.idempotencyKey, result: a.result });
    },
  };
});
vi.mock('../../result-door', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const applyResultDoorAsync = actual.applyResultDoorAsync as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    applyResultDoorAsync: async (...args: unknown[]): Promise<unknown> => {
      h.resultDoorCalls += 1;
      if (h.resultDoorDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, h.resultDoorDelayMs));
      }
      return applyResultDoorAsync(...args);
    },
  };
});
vi.mock('../../projected-tool-deps', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realDeps = actual.PROJECTED_DEPS as Record<string, unknown>;
  return {
    ...actual,
    PROJECTED_DEPS: {
      ...realDeps,
      recordInvocation: async (input: unknown): Promise<void> => {
        h.invocations.push(input);
      },
    },
  };
});
vi.mock('../../spawn-signing', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifySpawnParams: h.verifySpawnParams, logVerificationFailure: h.logVerificationFailure };
});
vi.mock('../../power-user-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifyAccessToken: h.verifyAccessToken };
});
vi.mock('../../superuser-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isValidSuperuserBearer: h.isValidSuperuserBearer };
});
vi.mock('../../adv-sessions', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, workspaceForCoordOwner: h.workspaceForCoordOwner };
});
vi.mock('../../resolve-harness-paths', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveHarnessPaths: async () => ({
      projectDir: '/tmp/mcp-deadline-receipt-proj',
      stateDir: '/tmp/mcp-deadline-receipt-state',
    }),
  };
});
vi.mock('../../hive-federation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, potHomeSlugForHarness: h.potHomeSlugForHarness };
});
vi.mock('../../harness-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveWorkspaceForHarnessSlugIn: h.resolveWorkspaceForHarnessSlugIn };
});

(globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
process.env.AGENT_MCP_TOOL_MANIFEST = '/nonexistent/mcp-deadline-receipt-no-manifest.json';
delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;
// The whole point of this file existing separately from gating-matrix.test.ts:
// MCP_DEADLINE_MS is read ONCE at module load, so this must be set before the
// import below — and setting it here applies ONLY to this file's own module
// instance, never to gating-matrix's other 96 cases.
const TEST_DEADLINE_MS = 25;
process.env.PAPERCUSP_MCP_DEADLINE_MS = String(TEST_DEADLINE_MS);

const { mcpHandler } = await import('../routes/transport/_mcp-handler');
// `_mcp-handler` defers the host and mcp-handler construction until the first
// request so importing pure helpers remains one-shot and side-effect-free.
// Warm the production path once before reading the handlers captured by the
// mocked adapter below.
// A LOCAL caller: a real one always sends a loopback Host, and a host-less outside request is
// answered at the edge with the P-006 OAuth 401 before the host (and its handlers) ever load.
await mcpHandler(new Request('http://127.0.0.1/api/mcp', { headers: { host: '127.0.0.1' } }));
const { registerProjectedTool, unregisterProjectedToolsForPlugin } = await import('@papercusp/agent-mcp');

/* ─── One synthetic probe: sleeps well past the deadline, then returns a
 *     result distinguishable from the timeout envelope. ────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SLOW_TOOL_MS = 150; // several multiples of TEST_DEADLINE_MS
const REAL_OUTCOME_TEXT = 'deadlinetest-real-outcome-not-a-timeout';
let slowCalls = 0;

registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only probe: sleeps past the P2-5 deadline, then resolves with a distinct real result',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'deadlinetest:slow' } },
  fn: async () => {
    slowCalls += 1;
    await sleep(SLOW_TOOL_MS);
    return { content: [{ type: 'text' as const, text: REAL_OUTCOME_TEXT }] };
  },
});

afterAll(() => {
  unregisterProjectedToolsForPlugin('mcp-deadline-receipt-test');
});

const MCP = 'http://127.0.0.1:3070/api/mcp';

function extraFor(url: string, headers: Record<string, string> = {}): unknown {
  return { requestInfo: { url, headers: { host: '127.0.0.1:3070', ...headers } } };
}
function superuserExtra(query = '', headers: Record<string, string> = {}): unknown {
  return extraFor(`${MCP}?superuser=1${query}`, { authorization: 'Bearer test-su-bearer', ...headers });
}

/**
 * DERIVED from the transport's own `McpCallResult` — see the same derivation in
 * mcp-handler-gating-matrix.test.ts. This file carried a byte-identical
 * hand-mirrored copy of that shape, so it was one asserted field away from the
 * same TS2339 drift (EI-21573072389650825); deriving it closes that off here
 * too rather than leaving the second copy armed.
 *
 * `content` is deliberately re-narrowed to the text-bearing shape these tests
 * assert on; the production union widens it to `Record<string, unknown>`.
 */
type CallResult = Omit<McpCallResult, 'content'> & {
  content: Array<{ type: string; text?: string }>;
};
async function callTool(
  name: string,
  args: Record<string, unknown>,
  extra: unknown,
  meta?: Record<string, unknown>,
): Promise<CallResult> {
  return (await h.handlers.get('tools/call')!(
    { params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    extra,
  )) as CallResult;
}
const textOf = (r: CallResult): string => r.content.map((c) => c.text ?? '').join('');

function traceEvents(calls: readonly unknown[][]): Array<Record<string, unknown>> {
  return calls.flatMap((call) => {
    const line = String(call[0] ?? '');
    const prefix = '[mcp-request-trace] ';
    if (!line.startsWith(prefix)) return [];
    try {
      return [JSON.parse(line.slice(prefix.length)) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  slowCalls = 0;
  h.withWorkspaceCalls.length = 0;
  h.withWorkspaceDelayMs = 0;
  h.commitFailure = null;
  h.txEvents.length = 0;
  h.replayStores.length = 0;
  h.storedReplay = null;
  h.invocations.length = 0;
  h.resultDoorDelayMs = 0;
  h.resultDoorCalls = 0;
  delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;
  _resetVerifiedSpawns();
});

// The 'slow' probe's whole point is to keep running — and its background
// persist landing — AFTER a test's own assertions finish. Left undrained,
// that pending timer fires during the NEXT test and leaks a storeMcpResult
// call into ITS freshly-reset h.replayStores (observed: a later test's poll
// picked up an earlier test's residual entry by array index). Draining here,
// past every real timer this file arms (deadline + slow-tool completion),
// guarantees each test starts with no async work still in flight.
afterEach(async () => {
  await sleep(SLOW_TOOL_MS + 100);
});

describe('P2-5 deadline path — background persist + real-outcome receipt (WI-6914)', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('answers with a clean request_timeout error once the deadline fires, without waiting for the tool', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain('deadlinetest:slow');
    expect(textOf(res)).toContain(`${TEST_DEADLINE_MS}ms`);
    expect(textOf(res)).toContain('commit status is UNKNOWN');
    expect(textOf(res)).toContain('re-read the current state');
    // Idempotency-key-aware wording (the two branches in _mcp-handler.ts differ
    // on whether a key was supplied) — this call passed one.
    expect(textOf(res)).toContain('retry with the same _meta.idempotencyKey');
    // EI-21570323060383850 / EI-21570305229276182: the instruction must name the key it is
    // telling the caller to reuse. The client injects the key on every call, so an agent
    // reading this error has never seen its value; both items were filed by callers who tried
    // to comply, found no key in the envelope, and fell back to reconciling by hand. Asserting
    // the literal VALUE (not just the phrase above) is what makes that non-recurrable.
    expect(textOf(res)).toContain('idem-deadline-1');
  });

  it('correlates the forwarded trace id across request start, deadline, and late handler settlement', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
    const resultDoorDelayMs = 45;
    h.resultDoorDelayMs = resultDoorDelayMs;
    try {
      const res = await callTool(
        'deadlinetest:slow',
        {},
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('request_timeout');
      const beforeSettlement = traceEvents(info.mock.calls);
      expect(beforeSettlement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            traceId,
            toolName: 'deadlinetest:slow',
            stage: 'request_started',
            elapsedMs: expect.any(Number),
          }),
          expect.objectContaining({ traceId, toolName: 'deadlinetest:slow', stage: 'inner_dispatch_started' }),
          expect.objectContaining({
            traceId,
            toolName: 'deadlinetest:slow',
            stage: 'deadline',
            phase: 'inner_dispatch',
            deadlineMs: TEST_DEADLINE_MS,
          }),
        ]),
      );
      expect(beforeSettlement.some((event) => event.stage === 'inner_dispatch_settled')).toBe(false);

      await sleep(SLOW_TOOL_MS + resultDoorDelayMs + 100);
      const settled = traceEvents(info.mock.calls).find((event) => event.stage === 'inner_dispatch_settled');
      expect(settled).toEqual(
        expect.objectContaining({
          traceId,
          toolName: 'deadlinetest:slow',
          outcome: 'success',
          elapsedMs: expect.any(Number),
          afterDeadline: true,
          phaseTimingsMs: expect.objectContaining({
            postDispatchToSettlement: expect.any(Number),
            resultDoor: expect.any(Number),
            advisory: expect.any(Number),
            advisoryFlagReads: expect.any(Number),
          }),
        }),
      );
      expect(h.resultDoorCalls).toBeGreaterThan(0);
      expect((settled?.phaseTimingsMs as { resultDoor?: number } | undefined)?.resultDoor)
        .toBeGreaterThanOrEqual(resultDoorDelayMs);
      expect(Number(settled?.elapsedMs)).toBeGreaterThanOrEqual(TEST_DEADLINE_MS);
    } finally {
      info.mockRestore();
    }
  });

  it('marks a delayed workspace acquisition as pre-dispatch and blocks late handler start', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = '73f01cc4-b44b-4d15-82f8-28d0d5774c31';
    const acquisitionDelayMs = TEST_DEADLINE_MS * 4;
    h.withWorkspaceDelayMs = acquisitionDelayMs;
    try {
      const res = await callTool(
        'deadlinetest:slow',
        {},
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('request_timeout');
      expect(h.withWorkspaceCalls).toEqual(['ws-test']);
      expect(traceEvents(info.mock.calls)).toContainEqual(
        expect.objectContaining({
          traceId,
          toolName: 'deadlinetest:slow',
          stage: 'deadline',
          phase: 'pre_dispatch',
          deadlineMs: TEST_DEADLINE_MS,
        }),
      );
      expect(traceEvents(info.mock.calls).some((event) => event.stage === 'inner_dispatch_started')).toBe(false);

      // Let the acquisition finish after its caller was answered. The absolute
      // deadline guard must still prevent entering the tool handler.
      await sleep(acquisitionDelayMs + 20);
      expect(slowCalls).toBe(0);
      expect(traceEvents(info.mock.calls).some((event) => event.stage === 'inner_dispatch_started')).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  // EI-21697542694243148: naming the VALUE is not enough — the message must also name a DOOR
  // that can actually send it. `_meta` is transport-level and every projected tool's args schema
  // is additionalProperties:false, so a caller who reads "pass exactly that value" and puts it in
  // the tool's arguments gets `invalid_args: Unrecognized key: "_meta"`. That is exactly what the
  // reporter did before falling back to hand-reconciliation. These assertions pin the two halves
  // that make the instruction actionable: the reachable flag, and the warning against the args
  // mistake. Without the fix the message named neither, so this test fails on the old wording.
  it('names a reachable door for the key, and warns it is not a tool argument (EI-21697542694243148)', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-door' });
    expect(res.isError).toBe(true);
    // The door that actually works (ptool's transport flag), carrying this call's own key.
    expect(textOf(res)).toContain('--idempotency-key idem-deadline-door');
    // And the trap it must steer the reader away from.
    expect(textOf(res)).toContain('TRANSPORT field');
    expect(textOf(res)).toContain('Unrecognized key');
    expect(textOf(res)).toContain('tools:invoke has no passthrough');
    // The printed invocation must be one ptool would actually accept: its parser THROWS on bare
    // positional tool args ("tool-specific arguments must be supplied in the JSON payload via
    // --json, --json-file, or --json -"), so an example ending in a bare `<args>` would reproduce
    // the very unactionable-instruction defect this item is about, one level down.
    expect(textOf(res)).toContain("--json '<the same args>'");
    expect(textOf(res)).not.toMatch(/--idempotency-key \S+ \S+ <args>/);
  });

  // The negative half, and the reason the assertion above is on the value rather than the
  // wording: the no-key branch must NOT start naming a key, or it would print an empty/undefined
  // one and send the caller chasing a replay that cannot work.
  it('the no-key branch names no key at all (EI-21570323060383850)', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('had no idempotencyKey');
    expect(textOf(res)).not.toContain("This call's key is");
    expect(textOf(res)).not.toMatch(/key is "?(undefined|null|)"/);
    // EI-21697542694243148: the forward-looking half of this branch ("pass one up front") had the
    // same gap — it told the caller to supply _meta.idempotencyKey without naming a door that can.
    // It must name the flag while still naming no concrete key value (asserted above).
    expect(textOf(res)).toContain('--idempotency-key');
    expect(textOf(res)).toContain('NOT as a tool argument');
  });

  it('does NOT re-block the response on the receipt persist — replayStores is still empty the instant the caller is answered', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-2' });
    expect(res.isError).toBe(true);
    // The whole point of `if (!raced.deadlineFired) await persist`: the caller
    // was already answered with the timeout envelope, and the persist for the
    // still-running tool has NOT happened yet — it happens in the background.
    expect(h.replayStores).toEqual([]);
  });

  it('times out during pre-dispatch workspace acquisition without entering the tool handler', async () => {
    h.withWorkspaceDelayMs = SLOW_TOOL_MS;
    const startedAt = Date.now();

    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-pre-dispatch-deadline',
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain(`${TEST_DEADLINE_MS}ms`);
    expect(Date.now() - startedAt).toBeLessThan(SLOW_TOOL_MS);

    // Let the delayed acquisition callback run. Without the pre-dispatch guard
    // it would enter runDispatch here and increment the synthetic tool count
    // after the caller had already received its timeout.
    await sleep(SLOW_TOOL_MS + 100);
    expect(slowCalls).toBe(0);
    expect(h.replayStores).toEqual([]);
    expect(h.invocations).toMatchObject([
      { toolName: 'deadlinetest:slow', status: 'error' },
    ]);
  });

  it('once the tool actually finishes, the persisted receipt is its REAL outcome — never the raced timeout envelope (EI-19301511582594101)', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-3' });
    expect(res.isError).toBe(true); // the CALLER got the timeout envelope...

    // ...but the tool keeps running server-side (raceDeadline never cancels
    // `run()`) and its real outcome is what eventually gets persisted. Poll
    // rather than a fixed sleep — deadline-bounded, so this can't hang the
    // suite even if the background persist regresses to never firing.
    const deadlineAt = Date.now() + SLOW_TOOL_MS + 2_000;
    while (h.replayStores.length === 0 && Date.now() < deadlineAt) {
      await sleep(10);
    }

    expect(slowCalls).toBe(1); // the tool really did run (not cancelled, not skipped)
    expect(h.replayStores).toHaveLength(1);
    expect(h.replayStores[0]!.idempotencyKey).toBe('idem-deadline-3');
    const stored = h.replayStores[0]!.result as CallResult;
    // The crux of the bug this item guards against: the STORED receipt must be
    // the tool's real content, not the "request_timeout" envelope the caller
    // was shown. A regression here would make every retry with this key replay
    // a timeout forever instead of the tool's actual (successful) result.
    expect(textOf(stored)).toBe(REAL_OUTCOME_TEXT);
    expect(textOf(stored)).not.toContain('request_timeout');
    expect(stored.isError).not.toBe(true);
  });

  it('with no idempotencyKey, the deadline still answers cleanly (no-retry-yet wording) and never persists a receipt', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain('commit status is UNKNOWN');
    expect(textOf(res)).toContain('Do NOT retry yet');
    expect(textOf(res)).toContain('re-read the current state');

    // Give the slow tool plenty of time to finish server-side; without an
    // idempotencyKey the handler's `if (idempotencyKey && ...)` guard means no
    // receipt is ever written, regardless of how the tool finishes.
    await sleep(SLOW_TOOL_MS + 100);
    expect(slowCalls).toBe(1);
    expect(h.replayStores).toEqual([]);
  });
});
