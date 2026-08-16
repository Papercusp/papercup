/**
 * EI-19464316359123796: the embed sidecar's OWN graceful shutdown
 * (SIGTERM/SIGINT, under `Restart=always` systemd supervision — see
 * `runEmbedSidecarServer`) used to call `process.exit(0)` directly after
 * closing the HTTP listener. `buildGemmaEmbedder` / `buildHarrierEmbedder` /
 * `buildLocalEmbedder` all route through `local-embedder-worker.ts`'s shared
 * `worker_threads` worker, and the reranker through its sibling module — a
 * bare `process.exit()` skips Node's `beforeExit` hook (by design), so those
 * workers' own graceful-teardown listeners never ran and the ONNX native
 * addon inside them got torn down mid-flight, surfacing as an unlabelled
 * `terminate called after throwing an instance of 'Napi::Error'` / SIGABRT
 * (exit 134) on every restart of this unit — even though the shutdown was
 * entirely graceful. This suite pins the fix: `shutdownLocalEmbedder()` and
 * `shutdownLocalReranker()` must both be awaited, AFTER the HTTP listener has
 * drained, BEFORE `process.exit(0)` runs.
 *
 * All builders here are FAKES injected via module mocks — no ONNX model ever
 * loads, matching the discipline in embed-sidecar-server.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shutdownLocalEmbedder = vi.fn(async () => {});
const shutdownLocalReranker = vi.fn(async () => {});

vi.mock('@papercusp/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/memory')>();
  return {
    ...actual,
    buildGemmaEmbedder: async () => async (text: string) => [text.length, 1],
    buildHarrierEmbedder: async () => async (text: string) => [text.length, 2],
    buildLocalEmbedder: async () => async (text: string) => [text.length, 3],
    shutdownLocalEmbedder,
  };
});

vi.mock('@papercusp/rerank', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/rerank')>();
  return {
    ...actual,
    loadCrossEncoder: async () => async () => [],
    shutdownLocalReranker,
  };
});

describe('runEmbedSidecarServer graceful shutdown', () => {
  const signalListeners = new Map<string, () => void>();
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onSpy: ReturnType<typeof vi.spyOn>;
  const prevPortEnv = process.env.PAPERCUSP_EMBED_SIDECAR_PORT;

  beforeEach(() => {
    process.env.PAPERCUSP_EMBED_SIDECAR_PORT = '0'; // ephemeral — never the real :3384
    signalListeners.clear();
    // Double-hop escape (NOT a bare `as never`/`as any`) — the same pattern
    // typed-mock.ts's own mockImplementationTyped uses internally: real
    // functions assignable to `(code?: ...) => never` must themselves never
    // return, which a no-op fake deliberately isn't, so casting through a
    // concrete real type (`typeof process.exit`) is the sanctioned escape.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    onSpy = vi.spyOn(process, 'on').mockImplementation((event: string | symbol, listener: (...a: unknown[]) => void) => {
      if (event === 'SIGTERM' || event === 'SIGINT') signalListeners.set(event, listener as () => void);
      return process;
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    onSpy.mockRestore();
    if (prevPortEnv === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    else process.env.PAPERCUSP_EMBED_SIDECAR_PORT = prevPortEnv;
    shutdownLocalEmbedder.mockClear();
    shutdownLocalReranker.mockClear();
  });

  it('awaits shutdownLocalEmbedder + shutdownLocalReranker before process.exit(0) on SIGTERM', async () => {
    const { runEmbedSidecarServer } = await import('./embed-sidecar-server');
    runEmbedSidecarServer();

    const sigterm = signalListeners.get('SIGTERM');
    expect(sigterm).toBeTypeOf('function');
    sigterm!();

    // The shutdown chain is async (server.close → Promise.allSettled → exit);
    // give the microtask/close-callback queue a turn.
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    expect(shutdownLocalEmbedder).toHaveBeenCalledTimes(1);
    expect(shutdownLocalReranker).toHaveBeenCalledTimes(1);

    // Ordering: both teardown fns must have been invoked BEFORE process.exit —
    // never the reverse (that would mean the exit skipped past them again).
    const embedderCallOrder = shutdownLocalEmbedder.mock.invocationCallOrder[0];
    const rerankerCallOrder = shutdownLocalReranker.mock.invocationCallOrder[0];
    const exitCallOrder = exitSpy.mock.invocationCallOrder[0];
    expect(embedderCallOrder).toBeLessThan(exitCallOrder);
    expect(rerankerCallOrder).toBeLessThan(exitCallOrder);
  });
});
