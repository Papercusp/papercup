import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostedWorkspaceHostSessionAdapter,
  SafeRootFileService,
  type HostedHostOutboundEnvelope,
  type HostedHostPty,
} from './hosted-session-host';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-session-host-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  return root;
}

class FakePty extends EventEmitter implements HostedHostPty {
  writes: Buffer[] = [];
  sizes: Array<[number, number]> = [];
  signals: string[] = [];
  killed = false;
  write(data: Buffer) {
    this.writes.push(data);
    return !this.killed;
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
    return !this.killed;
  }
  signal(signal: string) {
    this.signals.push(signal);
    return !this.killed;
  }
  kill() {
    this.killed = true;
  }
  snapshot() {
    return Promise.resolve('restored-screen');
  }
  onData(listener: (data: Buffer) => void) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }
  onExit(listener: (code: number, signal: number) => void) {
    this.on('exit', listener);
    return () => this.off('exit', listener);
  }
  output(value: string) {
    this.emit('data', Buffer.from(value));
  }
}

const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'workspace-1',
  hostId: 'host-1',
  routeLabel: 'alpha',
  generation: 4,
  transport: 'websocket',
  state: 'active',
};

function harness(root: string) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const ptys: FakePty[] = [];
  const audit = vi.fn();
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: root,
    send: (message) => sent.push(message),
    onAudit: audit,
    createPty: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  const open = (channelId: string, userId = 'user-1', hostedSessionId = 'session-1') =>
    adapter.accept({
      type: 'relay.open',
      channelId,
      userId,
      hostedSessionId,
      audience: 'workspace-operator',
      role: 'controller',
    });
  const relay = (channelId: string, payload: unknown) => adapter.accept({ type: 'relay', channelId, payload });
  return { adapter, sent, ptys, audit, open, relay };
}

describe('HostedWorkspaceHostSessionAdapter', () => {
  it('binds one PTY to an exact browser principal/session and resumes it across channels', async () => {
    const root = await projectRoot();
    const { adapter, sent, ptys, open, relay } = harness(root);
    await open('channel-1');
    await relay('channel-1', { type: 'pty.input', data: Buffer.from('hello').toString('base64') });
    await relay('channel-1', { type: 'pty.resize', cols: 90, rows: 24 });
    await relay('channel-1', { type: 'pty.signal', signal: 'SIGINT' });
    ptys[0].output('world');
    await adapter.accept({ type: 'relay.close', channelId: 'channel-1', reason: 'tab_closed' });
    await open('channel-2');

    expect(ptys).toHaveLength(1);
    expect(ptys[0].writes.map((data) => data.toString())).toEqual(['hello']);
    expect(ptys[0].sizes).toEqual([[90, 24]]);
    expect(ptys[0].signals).toEqual(['SIGINT']);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'channel-1',
      payload: { type: 'pty.output', data: Buffer.from('world').toString('base64') },
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'channel-2',
      payload: { type: 'pty.ready', resumed: true, role: 'controller' },
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'channel-2',
      payload: { type: 'pty.snapshot', data: Buffer.from('restored-screen').toString('base64') },
    });
  });

  it('isolates different users and hosted sessions even on one connector', async () => {
    const root = await projectRoot();
    const { ptys, open } = harness(root);
    await open('one', 'user-1', 'session');
    await open('two', 'user-2', 'session');
    await open('three', 'user-1', 'other-session');
    expect(ptys).toHaveLength(3);
  });

  it('expires a detached PTY while keeping audit free of terminal/file content', async () => {
    vi.useFakeTimers();
    const root = await projectRoot();
    const sent: HostedHostOutboundEnvelope[] = [];
    const pty = new FakePty();
    const audit = vi.fn();
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: root,
      send: (message) => sent.push(message),
      createPty: () => pty,
      idleMs: 100,
      onAudit: audit,
    });
    await adapter.accept({
      type: 'relay.open',
      channelId: 'one',
      userId: 'user',
      hostedSessionId: 'session',
      audience: 'workspace-operator',
      role: 'controller',
    });
    await adapter.accept({
      type: 'relay',
      channelId: 'one',
      payload: { type: 'pty.input', data: Buffer.from('TERMINAL_CANARY').toString('base64') },
    });
    await adapter.accept({ type: 'relay.close', channelId: 'one' });
    vi.advanceTimersByTime(101);
    expect(pty.killed).toBe(true);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('TERMINAL_CANARY');
  });

  it('serves idempotent file reads/writes and rejects a changed replay', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    await relay('one', { type: 'file.read', requestId: 'read-1', path: 'src/index.ts' });
    await relay('one', {
      type: 'file.write',
      requestId: 'write-1',
      path: 'src/new.ts',
      encoding: 'utf8',
      data: 'hello\n',
    });
    await relay('one', {
      type: 'file.write',
      requestId: 'write-1',
      path: 'src/new.ts',
      encoding: 'utf8',
      data: 'hello\n',
    });
    await relay('one', {
      type: 'file.write',
      requestId: 'write-1',
      path: 'src/new.ts',
      encoding: 'utf8',
      data: 'changed\n',
    });

    expect(await readFile(join(root, 'src', 'new.ts'), 'utf8')).toBe('hello\n');
    expect(
      sent.filter((message) => message.type === 'relay' && (message.payload as any)?.requestId === 'write-1'),
    ).toHaveLength(3);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: expect.objectContaining({ type: 'operation.error', code: 'idempotency_conflict' }),
    });
  });

  it('round-trips zero-byte uploads while rejecting a missing payload', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    await relay('one', {
      type: 'file.upload',
      requestId: 'upload-empty',
      path: 'src/empty.txt',
      encoding: 'base64',
      data: '',
    });
    await relay('one', {
      type: 'file.upload',
      requestId: 'upload-missing',
      path: 'src/missing.txt',
      encoding: 'base64',
    });

    expect((await readFile(join(root, 'src', 'empty.txt'))).byteLength).toBe(0);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: expect.objectContaining({
        type: 'file.result',
        requestId: 'upload-empty',
        operation: 'upload',
        bytes: 0,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: {
        type: 'operation.error',
        requestId: 'upload-missing',
        operation: 'file.upload',
        code: 'invalid_file_data',
      },
    });
  });
});

describe('SafeRootFileService', () => {
  it('denies traversal, secret files, and symlinks that escape the selected root', async () => {
    const root = await projectRoot();
    const outside = await mkdtemp(join(tmpdir(), 'hosted-session-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(join(outside, 'secret.txt'), join(root, 'src', 'escape'));
    await writeFile(join(root, '.env'), 'SECRET=canary');
    const files = new SafeRootFileService(root);

    await expect(files.read('../outside')).rejects.toMatchObject({ code: 'path_escape' });
    await expect(files.read('.env')).rejects.toMatchObject({ code: 'secret_path_denied' });
    await expect(files.read('src/escape')).rejects.toMatchObject({ code: 'symlink_denied' });
    await expect(files.write('src/escape', Buffer.from('overwrite'))).rejects.toMatchObject({ code: 'symlink_denied' });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  });

  it('filters secret and symlink entries from directory listings', async () => {
    const root = await projectRoot();
    await writeFile(join(root, 'src', '.env.local'), 'secret');
    await symlink(join(root, 'src', 'index.ts'), join(root, 'src', 'alias.ts'));
    const files = new SafeRootFileService(root);
    await expect(files.list('src')).resolves.toEqual([{ name: 'index.ts', kind: 'file', bytes: 24 }]);
  });
});
