/**
 * Unit tests for POST /api/adv/sessions/launch-pui — opens the `pui`
 * ratatui workbench (apps/tui) in an OS terminal via a server-side spawn.
 * spawn / fs / os are mocked so no terminal is actually opened. Covers:
 *   - happy path → resolves the cargo `pui` binary, spawns `pui workbench`,
 *     returns ok + terminal + pid;
 *   - `pui` not installed → 200 status:error code:pui_not_installed, no spawn;
 *   - no terminal emulator on PATH → 500 status:error, no spawn;
 *   - non-linux host → 501.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const spawnMock = vi.fn(() => ({ unref: () => {}, pid: 4242 }));
const existsSyncMock = vi.fn((_p: string): boolean => true);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: spawnMock };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/x' };
});

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

async function callPost(): Promise<Response> {
  const mod = await import('../routes/adv/launch-pui');
  const route = (mod.default as Array<{ handler: (req: Request, ctx: RouteContext) => Promise<Response> }>)[0];
  const req = new Request('http://localhost:3070/api/adv/sessions/launch-pui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return route.handler(req, CTX);
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
  const args = call[1];
  return args[args.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  delete process.env.TERMINAL;
});

describe('launch-pui', () => {
  it('happy path: resolves the cargo pui binary, spawns `pui workbench`, returns ok + terminal + pid', async () => {
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.terminal).toBe('gnome-terminal');
    expect(json.pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const oneliner = lastOneliner();
    expect(oneliner).toContain('/home/x/.cargo/bin/pui');
    expect(oneliner).toContain('workbench');
  });

  it('pui not installed → 200 status:error code:pui_not_installed, no spawn', async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.code).toBe('pui_not_installed');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no terminal emulator on PATH → 500 status:error, no spawn', async () => {
    // pui binary present (path ends in /pui) but no terminal emulator found.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/pui'));
    const res = await callPost();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/no terminal emulator/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('non-linux host → 501, no spawn', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const res = await callPost();
      expect(res.status).toBe(501);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });
});
