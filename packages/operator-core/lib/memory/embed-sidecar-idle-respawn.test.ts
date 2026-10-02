/**
 * P-531 (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10005523): re-launching
 * an embed sidecar that exited on idle.
 *
 * The sidecar announces an idle exit on stdout and then shuts down. Two
 * properties are pinned here with a FAKE child process (no real spawn, no
 * model load, no socket):
 *  1. an ensure that arrives DURING that shutdown window must not be handed the
 *     closing sidecar's URL — it waits, the exit triggers an immediate
 *     re-launch, and it resolves once the NEW child is ready;
 *  2. the wiring passes the per-attempt ensure hook only for a sidecar this
 *     process spawns, never for an explicit URL another process supervises.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ children: [] as Array<import('node:events').EventEmitter & Record<string, unknown>> }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new Emitter(), {
        stdout: new Emitter(),
        stderr: new Emitter(),
        killed: false,
        kill(this: { killed: boolean }) {
          this.killed = true;
          return true;
        },
      });
      fake.children.push(child);
      return child;
    }),
  };
});

import { spawn } from 'node:child_process';
import { EMBED_SIDECAR_IDLE_EXIT_LINE, EMBED_SIDECAR_READY_LINE } from './embed-sidecar-server';
import {
  _resetEmbedSidecarSpawnStateForTests,
  EMBED_SIDECAR_ENABLE_ENV,
  embedSidecarLocalUrl,
  ensureEmbedSidecar,
  isEmbedSidecarReady,
  spawnEmbedSidecar,
} from './embed-sidecar-spawn';
import { localSidecarEnsure, type SidecarWiringDeps } from './embed-sidecar-wiring';

function say(child: EventEmitter & Record<string, unknown>, line: string): void {
  (child.stdout as EventEmitter).emit('data', Buffer.from(`${line}\n`));
}

describe('ensureEmbedSidecar during an announced idle exit (P-531)', () => {
  const savedEnable = process.env[EMBED_SIDECAR_ENABLE_ENV];

  beforeEach(() => {
    fake.children.length = 0;
    vi.mocked(spawn).mockClear();
    _resetEmbedSidecarSpawnStateForTests();
    process.env[EMBED_SIDECAR_ENABLE_ENV] = '1';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetEmbedSidecarSpawnStateForTests();
    if (savedEnable === undefined) delete process.env[EMBED_SIDECAR_ENABLE_ENV];
    else process.env[EMBED_SIDECAR_ENABLE_ENV] = savedEnable;
    vi.restoreAllMocks();
  });

  it('waits for the re-launched child instead of returning the closing one', async () => {
    const first = spawnEmbedSidecar();
    expect(fake.children).toHaveLength(1);
    say(fake.children[0], EMBED_SIDECAR_READY_LINE);
    await first;
    expect(isEmbedSidecarReady()).toBe(true);

    // The child announces its idle exit but has not exited yet.
    say(fake.children[0], EMBED_SIDECAR_IDLE_EXIT_LINE);
    expect(isEmbedSidecarReady()).toBe(false);

    let resolved: string | null | undefined;
    const pending = ensureEmbedSidecar(['embed']).then((u) => {
      resolved = u;
      return u;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBeUndefined(); // parked, NOT handed the closing sidecar
    expect(fake.children).toHaveLength(1);

    // The announced clean exit: no crash-respawn, but the parked caller
    // triggers an immediate re-launch.
    fake.children[0].emit('exit', 0);
    expect(fake.children).toHaveLength(2);
    expect(resolved).toBeUndefined();

    say(fake.children[1], EMBED_SIDECAR_READY_LINE);
    await expect(pending).resolves.toBe(embedSidecarLocalUrl());
    expect(isEmbedSidecarReady()).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('an idle exit with nobody waiting does not re-launch; the next ensure does', async () => {
    const first = spawnEmbedSidecar();
    say(fake.children[0], EMBED_SIDECAR_READY_LINE);
    await first;
    say(fake.children[0], EMBED_SIDECAR_IDLE_EXIT_LINE);
    fake.children[0].emit('exit', 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.children).toHaveLength(1); // stays down: that is the memory saving

    // The sidecar is gone, so a running check fails and ensure would probe the
    // port before spawning. Make the probe answer "nothing listening" so this
    // test never touches a real sidecar on the shared port.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const pending = ensureEmbedSidecar(['embed']);
    await vi.waitFor(() => expect(fake.children).toHaveLength(2));
    say(fake.children[1], EMBED_SIDECAR_READY_LINE);
    await expect(pending).resolves.toBe(embedSidecarLocalUrl());
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('localSidecarEnsure (wiring, P-531)', () => {
  const deps = (explicit: string | null): SidecarWiringDeps & { ensure: ReturnType<typeof vi.fn> } => ({
    resolveUrl: () => explicit,
    ensure: vi.fn(async () => 'http://127.0.0.1:3384'),
    probeHealth: async () => null,
  });

  it('returns a hook that re-ensures the local sidecar with the caller capability', async () => {
    const d = deps(null);
    const hook = localSidecarEnsure(d, 'http://127.0.0.1:3384', 'rerank');
    expect(hook).toBeTypeOf('function');
    await hook!();
    expect(d.ensure).toHaveBeenCalledWith(['rerank']);
  });

  it('returns no hook for an explicit URL (that sidecar is supervised elsewhere)', () => {
    expect(localSidecarEnsure(deps('http://10.0.0.5:3384'), 'http://10.0.0.5:3384', 'embed')).toBeUndefined();
  });

  it('returns no hook when no sidecar is in play (pure in-process)', () => {
    expect(localSidecarEnsure(deps(null), null, 'embed')).toBeUndefined();
  });
});
