/** @vitest-environment jsdom */

/**
 * resolveMaxInFlightFetches — WI-6253 + D-047 recurrence guards.
 *
 * WI-6253 BUG: the sync concurrency gate's 24-wide default (query-fetcher.ts's
 * DEFAULT_MAX_IN_FLIGHT) was measured over the Tauri webview→sidecar IPC path,
 * which has no real per-host connection cap — but nothing in apps/ passed
 * SyncProvider's `maxInFlightFetches`, so every environment (including a plain
 * non-Tauri browser tab, which has NO IPC bridge and always opens a real HTTP
 * connection subject to WebKitGTK's ~6-per-host cap) ran the IPC-tuned value.
 *
 * D-047 BUG (`no-http-anywhere-2026-07-28`): the fix for the above selected the
 * cap from `isTauri()`, which tests SHELL PRESENCE, not transport. The shell is
 * present while `/api` is on real HTTP in three cases — the rollback lever
 * `PAPERCUSP_DESKTOP_IPC=0` (`client: 'disabled'`), the pre-IPC startup window
 * (`'never-connected'` / `'dial-in-flight'`), and a dropped connection
 * (`'dead'`) — so each of those took the IPC-tuned 24 against a ~6-connection
 * pool, re-arming the very stampede WI-6253 fixed. These pin the replacement:
 * the cap is raised ONLY on a positive `client === 'connected'` assertion, and
 * every other state (and every failure) stays capped.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CONNECTION_CAPPED_MAX_IN_FLIGHT, syncMetrics } from '@papercusp/sync';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@/app/_components/SetupWizard/tauri-detect', () => ({ isTauri: () => true }));

const {
  resolveMaxInFlightFetches,
  assertIpcCarriesFetch,
  reportIpcAssertionTimeout,
  useIpcCarriesFetch,
  resolveHarnessSyncTransport,
} = await import("./HarnessSyncProvider");

beforeEach(() => {
  invoke.mockReset();
  syncMetrics.__resetForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveHarnessSyncTransport (hosted browser marker)", () => {
  it("keeps the local REST/SSE endpoints when no hosted marker is present", () => {
    vi.stubGlobal("window", {});
    expect(resolveHarnessSyncTransport()).toEqual({
      restEndpoint: "/api/zero-harness",
      endpointOverride: undefined,
      queryNameAllowlist: undefined,
    });
  });

  it("selects the hosted REST base and explicit SSE endpoint from the marker", () => {
    vi.stubGlobal("window", {
      __PAPERCUSP_HOSTED_BROWSER__: {
        version: 1,
        controlPlaneWorkspaceId: "control-plane",
        restEndpoint: "/api/hosted/browser",
        sseEndpoint: "/api/hosted/browser/sse",
        workspaceHostEndpoints: {
          connection: "/api/hosted/browser/workspace-hosts/connection",
          provision: "/api/hosted/browser/workspace-hosts/provision",
          action: "/api/hosted/browser/workspace-hosts/action",
        },
      },
    });
    expect(resolveHarnessSyncTransport()).toEqual({
      restEndpoint: "/api/hosted/browser",
      endpointOverride: "/api/hosted/browser/sse",
      queryNameAllowlist: ["workspaceHosts.control"],
    });
  });
});

describe('resolveMaxInFlightFetches', () => {
  it('returns the connection-capped value when IPC does NOT carry fetch', () => {
    expect(resolveMaxInFlightFetches(false)).toBe(CONNECTION_CAPPED_MAX_IN_FLIGHT);
  });

  it('defers to SyncProvider default (undefined) only when IPC PROVABLY carries fetch', () => {
    expect(resolveMaxInFlightFetches(true)).toBeUndefined();
  });

  it('the connection-capped value is strictly below the IPC-tuned default and below the ~6-per-host browser cap', () => {
    // Sanity guard against a future edit accidentally widening the
    // connection-capped floor back up past what a real browser connection
    // pool can bear (see query-fetcher.ts's CONNECTION_CAPPED_MAX_IN_FLIGHT doc).
    expect(CONNECTION_CAPPED_MAX_IN_FLIGHT).toBeLessThan(6);
    expect(CONNECTION_CAPPED_MAX_IN_FLIGHT).toBeGreaterThan(0);
  });
});

describe('assertIpcCarriesFetch (D-047)', () => {
  it('records a slow pending startup assertion before allowing the IPC cap', async () => {
    let resolve!: (value: { client: string }) => void;
    invoke.mockReturnValue(new Promise((done) => { resolve = done; }));
    const hook = renderHook(() => useIpcCarriesFetch());
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current).toBe(false);
    const pending = syncMetrics.snapshot().ipcAssertion!;
    expect(pending).toHaveLength(1);
    expect(pending[0].completedAtMs).toBeNull();
    await act(async () => { resolve({ client: 'connected' }); });
    expect(hook.result.current).toBe(true);
    const completed = syncMetrics.snapshot().ipcAssertion![0];
    expect(completed.client).toBe('connected');
    expect(completed.completedAtMs).toBeGreaterThanOrEqual(completed.startedAtMs);
    expect(pending[0].completedAtMs).toBeNull();
  });

  it('is true ONLY for a connected IPC client', async () => {
    invoke.mockResolvedValue({ client: 'connected' });
    await expect(assertIpcCarriesFetch()).resolves.toBe(true);
  });

  // The three states that made shell-presence the wrong predicate. Each one is
  // a live Tauri shell whose /api traffic is on real, connection-capped HTTP.
  it.each(['disabled', 'never-connected', 'dial-in-flight', 'dead'])(
    'is false for client=%s — a present shell that is NOT on IPC',
    async (client) => {
      invoke.mockResolvedValue({ client });
      await expect(assertIpcCarriesFetch()).resolves.toBe(false);
    },
  );

  it('fails CAPPED when the shell rejects the invoke', async () => {
    invoke.mockRejectedValue(new Error('no such command'));
    await expect(assertIpcCarriesFetch()).resolves.toBe(false);
  });

  it('fails CAPPED on an older shell whose IpcStatus predates the client field', async () => {
    invoke.mockResolvedValue({ resolution_detail: 'some prose' });
    await expect(assertIpcCarriesFetch()).resolves.toBe(false);
  });

  it('never infers from resolution_detail prose (D-005 infer-from-a-string class)', async () => {
    // Prose that READS like a healthy connection must not be believed; only the
    // structured `client` field decides.
    invoke.mockResolvedValue({ resolution_detail: 'connected to /run/papercusp.sock' });
    await expect(assertIpcCarriesFetch()).resolves.toBe(false);
  });

  it('records and warns when the bounded assertion gives up', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportIpcAssertionTimeout('dead');

    expect(syncMetrics.snapshot()).toMatchObject({
      ipcAssertTimedOut: true,
      ipcAssertLastClient: 'dead',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Last observed client: dead'));
    warn.mockRestore();
  });

  it('reports the timeout from the real startup poll deadline', async () => {
    invoke.mockResolvedValue({ client: 'dead' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();

    renderHook(() => useIpcCarriesFetch());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(syncMetrics.snapshot()).toMatchObject({
      ipcAssertTimedOut: true,
      ipcAssertLastClient: 'dead',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
