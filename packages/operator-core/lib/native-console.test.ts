/**
 * Unit tests for native-console.ts's Tauri fallback path
 * (windows-desktop-feature-parity-2026-07-02 P-014).
 *
 * The server-side spawn (Linux/macOS) is exercised elsewhere via
 * console-spawn.test.ts / console-launch route tests; this file covers the
 * renderer-side fallback that fires when the operator host isn't Linux
 * (501): resolve the envelope, invoke Tauri `console_launch`, then — the
 * new behavior — best-effort POST /api/agent-mcp/console/record so the
 * spawned terminal gets an adv_sessions row (previously: nothing at all).
 *
 * Hermetic: global `fetch` and `./tauri-bindings`'s `commands` are mocked;
 * no real network, no Tauri IPC bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const consoleLaunchMock = vi.fn();
vi.mock('./tauri-bindings', () => ({ commands: { consoleLaunch: (...a: unknown[]) => consoleLaunchMock(...a) } }));

import { launchNativeConsole } from './native-console';

const originalWindow = (globalThis as { window?: unknown }).window;
let fetchMock: ReturnType<typeof vi.fn>;

/** A Response-ish stub. */
function res(opts: { ok?: boolean; status?: number; body: unknown }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.body,
  } as unknown as Response;
}

function installTauriWindow(): void {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: { invoke: vi.fn() },
    location: { origin: 'tauri://localhost' },
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  consoleLaunchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  vi.clearAllMocks();
});

const ENVELOPE = {
  cwd: '/home/avi/papercup',
  env: {},
  mcpJsonContents: '{}',
  greetingCmd: 'psu',
  needsSuperuserBootstrap: false,
};

describe('launchNativeConsole — server-side spawn succeeds', () => {
  it('returns without touching Tauri or console/record when the server-side spawn is 200 ok', async () => {
    fetchMock.mockResolvedValueOnce(res({ body: { status: 'ok' } }));
    await launchNativeConsole({ slug: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleLaunchMock).not.toHaveBeenCalled();
  });
});

describe('launchNativeConsole — Tauri fallback (non-Linux operator, 501)', () => {
  it('resolves the envelope, invokes console_launch, and records the session (parity fix)', async () => {
    installTauriWindow();
    fetchMock
      .mockResolvedValueOnce(res({ status: 501, body: { status: 'error', error: 'not linux' } })) // console/launch
      .mockResolvedValueOnce(res({ body: ENVELOPE })) // console/resolve
      .mockResolvedValueOnce(res({ body: { status: 'ok' } })); // console/record
    consoleLaunchMock.mockResolvedValueOnce({ status: 'ok', pid: 4242, displaced_mcp_json: false, bootstrapped: false });

    await launchNativeConsole({ slug: 'papercup', label: 'my session', planSlug: 'the-plan' });

    expect(consoleLaunchMock).toHaveBeenCalledWith(ENVELOPE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [recordUrl, recordInit] = fetchMock.mock.calls[2]!;
    expect(recordUrl).toBe('/api/agent-mcp/console/record');
    const body = JSON.parse((recordInit as RequestInit).body as string);
    expect(body).toEqual({
      cwd: ENVELOPE.cwd,
      terminalBin: 'wt.exe',
      label: 'my session',
      planSlug: 'the-plan',
      launchArgv: [ENVELOPE.greetingCmd],
    });
    // The load-bearing safety property: the Windows-namespace pid Tauri
    // returned (4242) must NEVER be forwarded to console/record — a foreign
    // pid namespace would poison the WSL-hosted operator's liveness checks.
    expect(body.pid).toBeUndefined();
  });

  it('still resolves the launch when console/record itself fails (best-effort, non-fatal)', async () => {
    installTauriWindow();
    fetchMock
      .mockResolvedValueOnce(res({ status: 501, body: { status: 'error', error: 'not linux' } }))
      .mockResolvedValueOnce(res({ body: ENVELOPE }))
      .mockRejectedValueOnce(new Error('record endpoint unreachable'));
    consoleLaunchMock.mockResolvedValueOnce({ status: 'ok', pid: 4242, displaced_mcp_json: false, bootstrapped: false });

    await expect(launchNativeConsole({ slug: 'papercup' })).resolves.toBeUndefined();
  });

  it('throws and never calls console/record when console_launch itself errors', async () => {
    installTauriWindow();
    fetchMock
      .mockResolvedValueOnce(res({ status: 501, body: { status: 'error', error: 'not linux' } }))
      .mockResolvedValueOnce(res({ body: ENVELOPE }));
    consoleLaunchMock.mockResolvedValueOnce({ status: 'err', error: 'wt.exe spawn failed' });

    await expect(launchNativeConsole({ slug: 'papercup' })).rejects.toThrow('wt.exe spawn failed');
    expect(fetchMock).toHaveBeenCalledTimes(2); // launch (501) + resolve only — no record call
  });

  it('throws when the server-side spawn 501s and no Tauri bridge is present', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 501, body: { status: 'error', error: 'not linux' } }));
    await expect(launchNativeConsole({ slug: 'papercup' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
