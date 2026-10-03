/**
 * WI-10005932 (plan agent-capacity-and-cost-gcp-2026-09-30, P-532d): the READY
 * deadline for an embed sidecar this Server spawns.
 *
 * The deadline was a hard-coded 10 s. On a 4-vCPU capacity VM with three
 * packaged Servers cold-booting at once, the re-exec'd bundle needed about
 * 10 s to print READY, so the parent killed a healthy child four times in a
 * row and each respawn paid the same startup again. Pinned here with a FAKE
 * child process (no real spawn, no model load) and fake timers:
 *  1. a child still starting past the old 10 s deadline is NOT killed;
 *  2. a child that never reaches READY is still killed at the (configurable)
 *     deadline, so a wedged start stays bounded;
 *  3. the deadline helper takes only a positive integer override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeChild = import('node:events').EventEmitter & {
  stdout: import('node:events').EventEmitter;
  stderr: import('node:events').EventEmitter;
  killed: boolean;
};

const fake = vi.hoisted(() => ({ children: [] as FakeChild[] }));

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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EMBED_SIDECAR_READY_LINE } from './embed-sidecar-server';
import {
  _resetEmbedSidecarSpawnStateForTests,
  EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS,
  EMBED_SIDECAR_ENABLE_ENV,
  EMBED_SIDECAR_STARTUP_TIMEOUT_ENV,
  embedSidecarStartupTimeoutMs,
  spawnEmbedSidecar,
} from './embed-sidecar-spawn';

function say(child: FakeChild, line: string): void {
  child.stdout.emit('data', Buffer.from(`${line}\n`));
}

describe('embedSidecarStartupTimeoutMs (WI-10005932)', () => {
  it('defaults well above a contended cold start', () => {
    expect(embedSidecarStartupTimeoutMs({})).toBe(EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS);
    expect(EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('takes a positive integer override and ignores anything else', () => {
    expect(embedSidecarStartupTimeoutMs({ [EMBED_SIDECAR_STARTUP_TIMEOUT_ENV]: '90000' })).toBe(90_000);
    for (const bad of ['', '  ', '0', '-5', '1.5', 'abc']) {
      expect(embedSidecarStartupTimeoutMs({ [EMBED_SIDECAR_STARTUP_TIMEOUT_ENV]: bad })).toBe(
        EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS,
      );
    }
  });
});

describe('spawnEmbedSidecar READY deadline (WI-10005932)', () => {
  const saved = {
    enable: process.env[EMBED_SIDECAR_ENABLE_ENV],
    port: process.env.PAPERCUSP_EMBED_SIDECAR_PORT,
    home: process.env.PAPERCUSP_HOME,
    startup: process.env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV],
  };
  let home: string;

  beforeEach(() => {
    fake.children.length = 0;
    _resetEmbedSidecarSpawnStateForTests();
    process.env[EMBED_SIDECAR_ENABLE_ENV] = '1';
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    delete process.env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV];
    home = mkdtempSync(path.join(tmpdir(), 'wi10005932-startup-'));
    process.env.PAPERCUSP_HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetEmbedSidecarSpawnStateForTests();
    for (const [k, v] of [
      [EMBED_SIDECAR_ENABLE_ENV, saved.enable],
      ['PAPERCUSP_EMBED_SIDECAR_PORT', saved.port],
      ['PAPERCUSP_HOME', saved.home],
      [EMBED_SIDECAR_STARTUP_TIMEOUT_ENV, saved.startup],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not kill a child that is still starting past the old 10 s deadline', async () => {
    let outcome: string | null = null;
    const started = spawnEmbedSidecar().then(
      () => {
        outcome = 'resolved';
      },
      (e: unknown) => {
        outcome = `rejected: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
    expect(fake.children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.children[0].killed).toBe(false);
    expect(outcome).toBeNull();

    say(fake.children[0], `${EMBED_SIDECAR_READY_LINE} port=41301`);
    await started;
    expect(outcome).toBe('resolved');
    expect(fake.children[0].killed).toBe(false);
  });

  it('still kills and rejects a child that never reaches READY by the deadline', async () => {
    process.env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV] = '20000';
    const outcome = spawnEmbedSidecar().then(
      () => 'resolved',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );

    await vi.advanceTimersByTimeAsync(19_000);
    expect(fake.children[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(fake.children[0].killed).toBe(true);
    await expect(outcome).resolves.toBe('Embed sidecar startup timeout (20000 ms)');
  });
});
