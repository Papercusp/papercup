import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { DetectedHardware } from '../provisioner/hardware-detect';
import {
  ensureLocalWhisper,
  stopLocalWhisper,
  whisperSttBaseUrl,
  __resetLocalWhisperStateForTests,
} from './local-whisper-service';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill(_sig?: string): boolean {
    this.killed = true;
    this.exitCode = 143;
    this.emit('exit', 143);
    return true;
  }
}

const linuxHw: DetectedHardware = { platform: 'linux', arch: 'x64', ramGB: 32, gpu: null, notes: [] };

/** Provision a fake-but-integrity-valid whisper cache + model into `home`. */
async function provisionFakeWhisper(home: string): Promise<string> {
  const binDir = join(home, '.papercusp/backends/whisper-server/v1.9.1/linux-x64-cpu');
  await mkdir(binDir, { recursive: true });
  const binContent = 'fake-whisper-server-binary';
  const binPath = join(binDir, 'whisper-server');
  await writeFile(binPath, binContent);
  const sha256 = createHash('sha256').update(binContent).digest('hex');
  await writeFile(
    join(binDir, 'manifest.json'),
    JSON.stringify({ version: 'v1.9.1', platformKey: 'linux-x64-cpu', source: 'prebuilt', sha256, builtAt: 'x' }),
  );
  const modelDir = join(home, '.papercusp/models/whisper');
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, 'ggml-base.bin'), 'fake-weights');
  return binPath;
}

describe('local-whisper-service', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'local-whisper-test-'));
    __resetLocalWhisperStateForTests();
  });
  afterEach(async () => {
    __resetLocalWhisperStateForTests();
    await rm(home, { recursive: true, force: true });
  });

  it('an external server always wins — no hardware probe, no spawn', async () => {
    const r = await ensureLocalWhisper({
      home,
      externalUrl: 'http://external:2022',
      probe: async (u) => u === 'http://external:2022',
      detectHw: async () => {
        throw new Error('must not probe hardware when external answers');
      },
      spawnFn: (() => {
        throw new Error('must not spawn');
      }) as never,
    });
    expect(r).toEqual({ ok: true, url: 'http://external:2022', source: 'external' });
  });

  it('un-provisioned box: clean not-provisioned reason, never a spawn or download', async () => {
    const r = await ensureLocalWhisper({
      home,
      probe: async () => false,
      detectHw: async () => linuxHw,
      spawnFn: (() => {
        throw new Error('must not spawn');
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-provisioned');
  });

  it('provisioned box: spawns the cached binary, health-gates, and serves the managed url', async () => {
    const binPath = await provisionFakeWhisper(home);
    let spawned: { cmd: string; args: string[] } | null = null;
    const child = new FakeChild();
    let managedUp = false;
    const r = await ensureLocalWhisper({
      home,
      port: 12345,
      probe: async (u) => u.includes('12345') && managedUp,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: ((cmd: string, args: string[]) => {
        spawned = { cmd, args };
        managedUp = true; // "server boots instantly"
        return child as unknown as ChildProcess;
      }) as never,
    });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('managed');
    expect(r.url).toBe('http://127.0.0.1:12345');
    expect(spawned!.cmd).toBe(binPath);
    expect(spawned!.args).toContain('--inference-path');
    expect(spawned!.args).toContain('/v1/audio/transcriptions');

    // Second call: managed child reused, no new spawn.
    let respawned = false;
    const again = await ensureLocalWhisper({
      home,
      port: 12345,
      probe: async (u) => u.includes('12345') && managedUp,
      detectHw: async () => linuxHw,
      spawnFn: (() => {
        respawned = true;
        return new FakeChild() as unknown as ChildProcess;
      }) as never,
    });
    expect(again.ok).toBe(true);
    expect(respawned).toBe(false);

    await stopLocalWhisper();
    expect(child.killed).toBe(true);
  });

  it('a child that dies during startup reads spawn-failed (not a hang)', async () => {
    await provisionFakeWhisper(home);
    const r = await ensureLocalWhisper({
      home,
      probe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 500,
      spawnFn: (() => {
        const c = new FakeChild();
        c.exitCode = 127; // dead before the first health poll
        return c as unknown as ChildProcess;
      }) as never,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('spawn-failed');
    expect(r.detail).toMatch(/exited 127/);
  });

  it('spawn-storm guard: refuses a 4th spawn inside the window', async () => {
    await provisionFakeWhisper(home);
    const mkDeps = () => ({
      home,
      probe: async () => false,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 20,
      spawnFn: (() => new FakeChild() as unknown as ChildProcess) as never,
    });
    for (let i = 0; i < 3; i++) {
      const r = await ensureLocalWhisper(mkDeps());
      expect(r.reason).toBe('unhealthy'); // spawned, never answered, timed out
    }
    const fourth = await ensureLocalWhisper(mkDeps());
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe('spawn-storm');
  });

  it('concurrent ensure calls coalesce onto ONE spawn', async () => {
    await provisionFakeWhisper(home);
    let spawns = 0;
    let managedUp = false;
    const deps = {
      home,
      port: 23456,
      probe: async (u: string) => u.includes('23456') && managedUp,
      detectHw: async () => linuxHw,
      healthIntervalMs: 5,
      healthTimeoutMs: 2000,
      spawnFn: (() => {
        spawns++;
        setTimeout(() => {
          managedUp = true;
        }, 20);
        return new FakeChild() as unknown as ChildProcess;
      }) as never,
    };
    const [a, b, c] = await Promise.all([ensureLocalWhisper(deps), ensureLocalWhisper(deps), ensureLocalWhisper(deps)]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(spawns).toBe(1);
  });

  it('whisperSttBaseUrl falls back to the external URL when nothing is provisioned (same error surface as before)', async () => {
    const url = await whisperSttBaseUrl({
      home,
      externalUrl: 'http://localhost:29999',
      probe: async () => false,
      detectHw: async () => linuxHw,
    });
    expect(url).toBe('http://localhost:29999');
  });
});
