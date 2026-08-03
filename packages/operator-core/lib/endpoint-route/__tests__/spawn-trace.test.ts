import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const spawnMock = vi.fn((...args: unknown[]) => {
  console.log('SPAWN CALL', JSON.stringify(args[0]));
  console.log(new Error().stack);
  return { unref: () => {}, pid: 4242 };
});
const existsSyncMock = vi.fn((_p: string): boolean => true);
vi.spyOn(process, 'kill').mockReturnValue(true);

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  delete process.env.TERMINAL;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('spawn-trace', () => {
  it('trace', async () => {
    const mod = await import('../routes/adv/launch-pui');
    const route = (mod.default as Array<{ handler: (req: Request, ctx: RouteContext) => Promise<Response> }>)[0];
    const req = new Request('http://localhost:3070/api/adv/sessions/launch-pui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const resPromise = route.handler(req, CTX);
    await vi.advanceTimersByTimeAsync(500);
    await resPromise;
    console.log('TOTAL CALLS', spawnMock.mock.calls.length);
    expect(true).toBe(true);
  });
});
