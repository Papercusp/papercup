import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freezeMinecraftTrial } from './minecraft-protocol';
import { startMinecraftRuntime } from './minecraft-runtime';
import type { ProcExec } from './grader/swe-bench-pro';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mc-runtime-test-')); roots.push(root);
  const serverJar = join(root, 'server.jar'); await writeFile(serverJar, 'jar-fixture');
  const sha = 'a'.repeat(64);
  const trial = freezeMinecraftTrial({ schemaVersion: 1, runId: 'run', armId: 'stock', taskId: 'iron',
    manifestHash: sha, selectionHash: sha, worldSeed: '9223372036854775807', objective: 'iron-tools',
    rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
    pins: { serverImage: `minecraft/server@sha256:${sha}`, serverJarSha256: createHash('sha256').update('jar-fixture').digest('hex'),
      mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
    participants: ['alice'], observations: ['position', 'inventory'], actions: ['move'],
    limits: { maxWallClockMs: 60_000, maxProgramMs: 1000, maxUsd: 2 } });
  const commands: string[][] = [];
  const exec: ProcExec = vi.fn(async (_cmd, args) => {
    commands.push(args);
    let stdout = '';
    if (args[0] === 'run' && args.includes('-p')) stdout = '["4.32.0","2.4.5"]';
    else if (args[0] === 'run' && args.includes('/app/program.cjs')) stdout = '{"ok":true,"value":{"x":1}}';
    else if (args[0] === 'logs') stdout = args.at(-1)?.endsWith('-bot')
      ? '{"ready":true,"participants":["alice"]}' : 'Done (1.0s)!';
    else if (args[0] === 'inspect') stdout = 'true';
    return { code: 0, stdout, stderr: args[0] === 'exec' ? 'openjdk version "17.0.1"' : '' };
  });
  return { trial, serverJar, workRoot: root, botImage: `sha256:${sha}`, acceptEula: true, exec, commands };
}
describe('Minecraft owned runtime lifecycle', () => {
  it('refuses incompatible pins, EULA and player identities before allocating a container', async () => {
    const f = await fixture();
    await expect(startMinecraftRuntime({ ...f, acceptEula: false })).rejects.toThrow(/EULA/);
    await expect(startMinecraftRuntime({ ...f, botImage: 'node:latest' })).rejects.toThrow(/pins/);
    await writeFile(f.serverJar, 'changed');
    await expect(startMinecraftRuntime(f)).rejects.toThrow(/jar pin/);
    expect(f.exec).not.toHaveBeenCalled();
  });
  it('separates world, trusted bot and network-none program mounts and retains exact seed', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    try {
      expect(runtime.measurement.trialId).toBe(f.trial.trialId);
      expect(await readFile(join((await runtime.stop()).evidenceDir, 'server.properties'), 'utf8')).toContain('level-seed=9223372036854775807');
      const server = f.commands.find(args => args.includes('/opt/server.jar') && args[0] === 'run')!;
      const bot = f.commands.find(args => args.includes('/app/bot.cjs'))!;
      expect(server[server.indexOf('--network') + 1]).toBe('none');
      expect(bot[bot.indexOf('--network') + 1]).toContain('container:');
      expect(bot.join(' ')).not.toContain('target=/data');
      expect(server).toContain('no-new-privileges');
      expect((await runtime.stop()).removed).toBe(true);
    } finally { await runtime.dispose(); }
  });
  it('executes bounded programs only for enrolled participants and stops idempotently', async () => {
    const f = await fixture(); const runtime = await startMinecraftRuntime(f);
    try {
      await expect(runtime.execute('intruder', 'return 1')).rejects.toThrow(/participant/);
      await expect(runtime.execute('alice', 'x'.repeat(16385))).rejects.toThrow(/program/);
      expect(await runtime.execute('alice', 'return await bot.position()')).toEqual({ ok: true, value: { x: 1 } });
      const program = f.commands.find(args => args.includes('/app/program.cjs'))!;
      expect(program[program.indexOf('--network') + 1]).toBe('none');
      expect(program.join(' ')).not.toMatch(/target=\/data|docker.sock|protocol.json|server.jar/);
      const result = await runtime.stop(); expect(result).toMatchObject({ removed: true, errors: [] });
      expect(await runtime.stop()).toBe(result);
      await expect(runtime.execute('alice', 'return 1')).rejects.toThrow(/closed/);
    } finally { await runtime.dispose(); }
  });
  it('cleans names even when Docker created a server but its response was lost', async () => {
    const f = await fixture(); const base = f.exec;
    f.exec = vi.fn(async (cmd, args, opts) => args[0] === 'run' && args.includes('/opt/server.jar')
      ? { code: 124, stdout: '', stderr: 'lost run response' } : base(cmd, args, opts));
    await expect(startMinecraftRuntime(f)).rejects.toThrow(/cleanup=/);
    expect(f.commands.some(args => args[0] === 'rm' && args.at(-1)?.endsWith('-server'))).toBe(true);
    expect(f.commands.some(args => args[0] === 'ps' && args.includes('--filter'))).toBe(true);
  });
  it('drains a cancelled active program before verifying container cleanup', async () => {
    const f = await fixture(); const controller = new AbortController(); const base = f.exec;
    f.exec = vi.fn(async (cmd, args, opts) => {
      if (args.includes('/app/program.cjs')) {
        controller.abort(); return { code: 124, stdout: '', stderr: 'cancelled' };
      }
      return base(cmd, args, opts);
    });
    const runtime = await startMinecraftRuntime({ ...f, signal: controller.signal });
    await expect(runtime.execute('alice', 'while (true) {}')).rejects.toThrow(/cancelled/);
    expect(await runtime.dispose()).toMatchObject({ removed: true, errors: [] });
  });
});
