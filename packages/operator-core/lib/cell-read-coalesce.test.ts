/**
 * WI-6554700010008923 (oversized-tool-results-reduction-2026-10-12#P-004): `readCell`
 * shares IDENTICAL CONCURRENT resolver dispatches and caches nothing after they settle.
 *
 * Measured 2026-10-12: the TUI status bar reads three cells that all poll
 * `dev:pipeline_position {}`, and each read started its own ~228 KB, ~1.3 s pipeline
 * computation. These tests pin both halves of the fix. Concurrent identical reads collapse
 * to one dispatch. Reads that differ in anything the result depends on (reader, args,
 * role) stay separate, as do reads that arrive after the first one settled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { readCell, resolverDispatchKey, __resolverInflightCountForTests, type CellReadEnv } from './cell-read';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from './cell-registry';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };
const OTHER_READER = { ...READER, ownerId: 'su-other' };

function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.a',
    owner: 'test',
    headline: 'positions.deployed',
    assessment: {
      path: 'assessments.deployedSha',
      codes: {
        serving: { meaning: 'The running process is executing this sha.', safeAction: 'Treat the deploy as live.' },
        stale: {
          meaning: 'The sha is deployed on disk but the process predates it.',
          safeAction: 'Restart the unit before trusting the deploy.',
        },
      },
      evidence: ['serving.startedSinceCodeChange'],
    },
    nullable: false,
    whyTotal: 'test fixture — the stub resolver returns a value or throws; no read can fail into a default.',
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

const PAYLOAD = {
  positions: { deployed: true, onStaging: true },
  serving: { startedSinceCodeChange: true },
  assessments: { deployedSha: 'serving', stagingState: 'serving' },
};

/** A dispatch the test settles by hand, so "concurrent" is deterministic. */
function deferredDispatch() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function callerContext(
  principalSlug: string,
  capabilities: Iterable<string>,
  signal = new AbortController().signal,
): NonNullable<CellReadEnv['callerContext']> {
  return {
    workspaceId: ENV.workspaceId,
    harnessSlug: ENV.harnessSlug,
    role: ENV.role,
    uiClientId: principalSlug,
    log: () => {},
    progress: () => {},
    emit: () => {},
    principal: { kind: 'system', slug: principalSlug, authMethod: 'bearer-token', trust: 'trusted',
      workspaceId: ENV.workspaceId, capabilities: new Set(capabilities) },
    signal,
  } satisfies UnifiedToolContext;
}

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
  // Two cells that share ONE resolver, the shape that caused the measured waste. D-038
  // requires each cell on a shared payload to own a distinct assessment path.
  registerCell(spec({ cell: 'test.a' }));
  const a = spec().assessment!;
  registerCell(
    spec({
      cell: 'test.b',
      headline: 'positions.onStaging',
      assessment: { ...a, path: 'assessments.stagingState' },
    }),
  );
});

describe('readCell — concurrent identical resolver dispatches are shared', () => {
  it('two cells on the same resolver, read together by one reader, dispatch ONCE', async () => {
    const d = deferredDispatch();
    dispatchReadOnlyTool.mockReturnValue(d.promise);

    const reads = Promise.all([readCell('test.a', READER, ENV), readCell('test.b', READER, ENV)]);
    // Both reads have reached the dispatch before it settles.
    await vi.waitFor(() => expect(__resolverInflightCountForTests()).toBe(1));
    d.resolve(PAYLOAD);
    const [a, b] = await reads;

    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('value');
    expect(b.status).toBe('value');
    // Settled, so nothing is left to share.
    expect(__resolverInflightCountForTests()).toBe(0);
  });

  it('caches nothing after settling: a read that starts later dispatches again', async () => {
    dispatchReadOnlyTool.mockResolvedValue(PAYLOAD);
    await readCell('test.a', READER, ENV);
    await readCell('test.a', READER, ENV);
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2);
  });

  it('never shares across READERS: each reader gets its own dispatch', async () => {
    const d = deferredDispatch();
    dispatchReadOnlyTool.mockReturnValue(d.promise);
    const reads = Promise.all([readCell('test.a', READER, ENV), readCell('test.a', OTHER_READER, ENV)]);
    await vi.waitFor(() => expect(__resolverInflightCountForTests()).toBe(2));
    d.resolve(PAYLOAD);
    await reads;
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2);
    const onBehalfOf = dispatchReadOnlyTool.mock.calls.map((c) => (c[2] as { onBehalfOf: string }).onBehalfOf);
    expect(onBehalfOf.sort()).toEqual(['su-me', 'su-other']);
  });

  it('does not share when the same wearer loses a capability during an in-flight read', async () => {
    const first = deferredDispatch();
    const afterRevocation = deferredDispatch();
    let call = 0;
    dispatchReadOnlyTool.mockImplementation(() => (call++ === 0 ? first.promise : afterRevocation.promise));

    const liveCapabilities = new Set(['read:private']);
    const firstContext = callerContext('wearer-principal', liveCapabilities);
    const firstRead = readCell('test.a', READER, { ...ENV, callerContext: firstContext });
    await vi.waitFor(() => expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1));
    const firstEnv = dispatchReadOnlyTool.mock.calls[0]![2] as { callerContext: NonNullable<CellReadEnv['callerContext']> };
    expect([...firstEnv.callerContext.principal!.capabilities]).toEqual(['read:private']);

    liveCapabilities.clear();
    const revokedContext = callerContext('wearer-principal', liveCapabilities);
    const revokedRead = readCell('test.a', READER, { ...ENV, callerContext: revokedContext });
    await vi.waitFor(() => expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2));
    const revokedEnv = dispatchReadOnlyTool.mock.calls[1]![2] as { callerContext: NonNullable<CellReadEnv['callerContext']> };
    expect(revokedEnv.callerContext).toBe(revokedContext);
    expect([...revokedEnv.callerContext.principal!.capabilities]).toEqual([]);

    first.resolve(PAYLOAD);
    afterRevocation.resolve(PAYLOAD);
    const [before, after] = await Promise.all([firstRead, revokedRead]);
    expect(before.status).toBe('value');
    expect(after.status).toBe('value');
  });

  it('does not share caller contexts for different principal subjects', async () => {
    const first = deferredDispatch();
    const second = deferredDispatch();
    let call = 0;
    dispatchReadOnlyTool.mockImplementation(() => (call++ === 0 ? first.promise : second.promise));

    const reads = Promise.all([
      readCell('test.a', READER, { ...ENV, callerContext: callerContext('subject-one', ['read:private']) }),
      readCell('test.a', READER, { ...ENV, callerContext: callerContext('subject-two', ['read:private']) }),
    ]);
    await vi.waitFor(() => expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2));
    const subjects = dispatchReadOnlyTool.mock.calls.map((callArgs) =>
      (callArgs[2] as { callerContext: NonNullable<CellReadEnv['callerContext']> }).callerContext.principal!.slug,
    );
    expect(subjects).toEqual(['subject-one', 'subject-two']);

    first.resolve(PAYLOAD);
    second.resolve(PAYLOAD);
    const results = await reads;
    expect(results.map((result) => result.status)).toEqual(['value', 'value']);
  });

  it('keeps caller-owned cancellation signals isolated between overlapping reads', async () => {
    const first = deferredDispatch();
    const second = deferredDispatch();
    let call = 0;
    dispatchReadOnlyTool.mockImplementation(() => (call++ === 0 ? first.promise : second.promise));
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();

    const reads = Promise.all([
      readCell('test.a', READER, { ...ENV, callerContext: callerContext('wearer-principal', ['read:private'], firstAbort.signal) }),
      readCell('test.a', READER, { ...ENV, callerContext: callerContext('wearer-principal', ['read:private'], secondAbort.signal) }),
    ]);
    await vi.waitFor(() => expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2));
    const signals = dispatchReadOnlyTool.mock.calls.map((callArgs) =>
      (callArgs[2] as { callerContext: NonNullable<CellReadEnv['callerContext']> }).callerContext.signal,
    );
    expect(signals).toEqual([firstAbort.signal, secondAbort.signal]);

    firstAbort.abort();
    expect(firstAbort.signal.aborted).toBe(true);
    expect(secondAbort.signal.aborted).toBe(false);

    first.resolve(PAYLOAD);
    second.resolve(PAYLOAD);
    const results = await reads;
    expect(results.map((result) => result.status)).toEqual(['value', 'value']);
  });

  it('a rejected shared dispatch fails every waiter the same way and leaves nothing behind', async () => {
    const d = deferredDispatch();
    dispatchReadOnlyTool.mockReturnValue(d.promise.then(() => Promise.reject(new Error('resolver blew up'))));
    const reads = Promise.all([readCell('test.a', READER, ENV), readCell('test.b', READER, ENV)]);
    await vi.waitFor(() => expect(__resolverInflightCountForTests()).toBe(1));
    d.resolve(undefined);
    const [a, b] = await reads;
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('unknown');
    expect(b.status).toBe('unknown');
    expect(__resolverInflightCountForTests()).toBe(0);
  });
});

describe('resolverDispatchKey — the key separates everything the result depends on', () => {
  const base = resolverDispatchKey('dev:pipeline_position', {}, ENV, 'su-me');

  it('is stable for identical inputs', () => {
    expect(resolverDispatchKey('dev:pipeline_position', {}, ENV, 'su-me')).toBe(base);
  });

  it.each([
    ['tool', resolverDispatchKey('state:other', {}, ENV, 'su-me')],
    ['args', resolverDispatchKey('dev:pipeline_position', { path: 'a.ts' }, ENV, 'su-me')],
    ['reader', resolverDispatchKey('dev:pipeline_position', {}, ENV, 'su-other')],
    ['role', resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, role: 'worker' }, 'su-me')],
    ['harness', resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, harnessSlug: null }, 'su-me')],
    ['workspace', resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, workspaceId: 'w2' }, 'su-me')],
  ])('differs when the %s differs', (_label, key) => {
    expect(key).not.toBeNull();
    expect(key).not.toBe(base);
  });

  it('refuses to share a call that carries an AbortSignal', () => {
    const signal = new AbortController().signal;
    expect(resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, signal }, 'su-me')).toBeNull();
  });

  it('refuses to serialize caller authority Sets or caller-owned cancellation into a shared key', () => {
    const granted = callerContext('wearer-principal', ['read:private']);
    const revoked = callerContext('wearer-principal', []);
    const callerSignal = new AbortController().signal;

    expect(resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, callerContext: granted }, 'su-me')).toBeNull();
    expect(resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, callerContext: revoked }, 'su-me')).toBeNull();
    expect(resolverDispatchKey('dev:pipeline_position', {}, {
      ...ENV, callerContext: callerContext('wearer-principal', ['read:private'], callerSignal),
    }, 'su-me')).toBeNull();
  });
});
