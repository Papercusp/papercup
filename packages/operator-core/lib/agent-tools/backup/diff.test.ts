/**
 * diff.test.ts — the backup:diff HANDLER (child_process.spawn mocked with an EventEmitter
 * fake). The handler builds the kopia env (KOPIA_PASSWORD from deriveRepoPassword + the
 * per-workspace config/log/cache paths) and runs `kopia diff <from> <to>`, resolving the
 * stdout or rejecting on a non-zero exit. Pins: the spawn args, the credential/env wiring,
 * the success stdout, and the non-zero-exit rejection. A regression that drops the
 * password env or swallows a kopia failure is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/backup/diff.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({ cfg: { stdout: '', stderr: '', code: 0 } }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (h.cfg.stdout) child.stdout.emit('data', Buffer.from(h.cfg.stdout));
      if (h.cfg.stderr) child.stderr.emit('data', Buffer.from(h.cfg.stderr));
      child.emit('close', h.cfg.code);
    });
    return child;
  }),
}));
vi.mock('../../backup', () => ({ deriveRepoPassword: vi.fn(async () => 'repo-pw') }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1'), workspacesRoot: vi.fn(() => '/root') }));

import { spawn } from 'node:child_process';
const spawnM = vi.mocked(spawn);
const tool = (await import('./diff')).default;

type Out = { content: { text: string }[] };
const call = () => tool.handler({ fromSnapshotId: 'snapA', toSnapshotId: 'snapB' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg = { stdout: '', stderr: '', code: 0 };
});

describe('backup:diff handler', () => {
  it('runs `kopia diff <from> <to>` with the credential env and returns the diff', async () => {
    h.cfg = { stdout: '+ added.ts\n- removed.ts\n', stderr: '', code: 0 };
    const b = body(await call());
    expect(b).toMatchObject({ diff: '+ added.ts\n- removed.ts\n' });
    // spawn args + env wiring
    const [, args, opts] = spawnM.mock.calls[0]! as [string, string[], { env: Record<string, string> }];
    expect(args).toEqual(['diff', 'snapA', 'snapB']);
    expect(opts.env.KOPIA_PASSWORD).toBe('repo-pw');
    expect(opts.env.KOPIA_CONFIG_PATH).toContain('/root/ws-1/backups');
  });

  it('rejects when kopia exits non-zero (failure is not swallowed)', async () => {
    h.cfg = { stdout: '', stderr: 'no such snapshot', code: 1 };
    await expect(call()).rejects.toThrow(/exited 1/);
  });
});
