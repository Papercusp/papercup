import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteBootedHarnessHandle } from '../hyperbee/remote-booted-harness';
import { SubstrateIpcClient } from '../hyperbee/substrate-ipc-client';
import { guardGitServingSigner, type GitServingRequest } from './serving-capability';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('P514 separate serving and publishing processes', () => {
  it('signs the owner context and refuses an old owner/store after replacement over real RPC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p514-rpc-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'owner.sock');
    const keys = generateKeyPairSync('ed25519');
    const device = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const request: GitServingRequest = { workspaceId: 'test', installSlug: 'repo', potHomeSlug: 'home',
      scope: { hive_id: Buffer.alloc(32, 7).toString('base64'), repo_key: 'gh:123' } };
    async function stop(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    async function start() {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./__fixtures__/serving-owner.mts', import.meta.url))], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, P514_SERVING_FIXTURE: JSON.stringify({ socketPath, request, device }) },
      });
      cleanups.push(() => stop(child));
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message as { ready: boolean; pid: number }),
        once(child, 'exit').then(([code]) => { throw new Error(`serving fixture exited ${code}: ${stderr}`); }),
      ]);
      expect(ready.ready).toBe(true);
      expect(ready.pid).not.toBe(process.pid);
      return child;
    }
    const first = await start();
    const client = new SubstrateIpcClient(socketPath);
    cleanups.push(() => client.close());
    const handle = new RemoteBootedHarnessHandle({ workspaceId: request.workspaceId, harnessSlug: request.installSlug,
      storeId: 'store-1', ownLogKey: 'c'.repeat(64), ownLogLength: 0, client });
    const initial = await handle.getGitServingCapability(request);
    expect(initial.status).toBe('ready');
    if (initial.status !== 'ready') throw new Error('owner failed to issue capability');
    const guarded = guardGitServingSigner(initial.capability, request, () => handle.getGitServingCapability(request),
      async bytes => sign(null, bytes, keys.privateKey));
    const payload = Buffer.from(JSON.stringify({ context: initial.capability.context, device: initial.capability.identity.devicePubkeyBase64 }));
    expect(verify(null, payload, keys.publicKey, await guarded(payload))).toBe(true);

    await client.call('test:replaceStore');
    await expect(guarded(payload)).rejects.toMatchObject({ code: 'GIT_SERVING_UNAVAILABLE' });
    const replaced = await handle.getGitServingCapability(request);
    expect(replaced.status === 'ready' && replaced.capability.context.store_generation).toBe(`sg2-2-${'b'.repeat(40)}`);

    await stop(first);
    await start();
    const restarted = await handle.getGitServingCapability(request);
    expect(restarted.status).toBe('ready');
    if (restarted.status === 'ready') expect(restarted.capability.runtimeId).not.toBe(initial.capability.runtimeId);
    await expect(guarded(payload)).rejects.toMatchObject({ retryable: true });
    await handle.close();
    expect(await handle.getGitServingCapability(request)).toMatchObject({ status: 'stopped' });
  }, 30_000);
});
