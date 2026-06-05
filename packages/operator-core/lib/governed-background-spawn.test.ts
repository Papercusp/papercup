/**
 * Unit tests for spawnInvokeOnceBackground (RB-012) — the governed fire-and-forget
 * spawn used by the scoper. Asserts: flag OFF = a plain detached
 * spawn (no governor touched); flag ON = acquire-before-spawn + release-on-exit; bail
 * (permit denied) = no spawn + DONE sentinel appended so the caller's poll ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

const governorForBackendMock = vi.fn();
vi.mock('@papercusp/papercup-shared/agent', () => ({
  governorForBackend: (...a: unknown[]) => governorForBackendMock(...a),
}));

const appendFileSyncMock = vi.fn();
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  appendFileSync: (...a: unknown[]) => appendFileSyncMock(...a),
}));

import { spawnInvokeOnceBackground } from './governed-background-spawn';

function fakeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  const c = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  c.unref = vi.fn();
  return c;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const spec = { command: 'claude', args: ['-p'], cwd: '/x', env: {} as NodeJS.ProcessEnv };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_AGENT_GOVERNOR;
});
afterEach(() => {
  delete process.env.PAPERCUSP_AGENT_GOVERNOR;
});

describe('spawnInvokeOnceBackground', () => {
  it('flag OFF: a plain detached spawn, no governor', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    spawnInvokeOnceBackground(spec);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ detached: true });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(governorForBackendMock).not.toHaveBeenCalled();
  });

  it('flag ON: acquires a permit BEFORE spawning, releases on child close', async () => {
    process.env.PAPERCUSP_AGENT_GOVERNOR = '1';
    const release = vi.fn();
    const gov = { acquire: vi.fn().mockResolvedValue(release) };
    governorForBackendMock.mockReturnValue(gov);
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    spawnInvokeOnceBackground({ ...spec, backend: 'claude-code' });
    await tick();

    expect(gov.acquire).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled(); // held while the child runs
    child.emit('close');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('flag ON bail: permit denied → no spawn + DONE sentinel appended to resultPath', async () => {
    process.env.PAPERCUSP_AGENT_GOVERNOR = '1';
    const gov = { acquire: vi.fn().mockResolvedValue(null) };
    governorForBackendMock.mockReturnValue(gov);

    spawnInvokeOnceBackground({ ...spec, resultPath: '/tmp/r.log' });
    await tick();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(appendFileSyncMock).toHaveBeenCalledWith('/tmp/r.log', expect.stringContaining('__INVOCATION_DONE__'));
  });

  it('flag ON: releases the permit on child error too', async () => {
    process.env.PAPERCUSP_AGENT_GOVERNOR = '1';
    const release = vi.fn();
    governorForBackendMock.mockReturnValue({ acquire: vi.fn().mockResolvedValue(release) });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    spawnInvokeOnceBackground(spec);
    await tick();
    child.emit('error', new Error('boom'));
    expect(release).toHaveBeenCalledTimes(1);
  });
});
