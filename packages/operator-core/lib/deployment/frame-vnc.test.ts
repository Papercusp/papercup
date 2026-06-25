import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Frame } from '@papercusp/deployment-driver';
import {
  createVncSession,
  consumeTicket,
  bridgeVncSession,
  activeVncSessions,
  vncRemoteCommand,
  VNC_TICKET_TTL_MS,
  _setFrameVncDepsForTests,
  _resetFrameVncForTests,
  type VncBridgeWs,
} from './frame-vnc';

const FRAME: Frame = {
  id: 'lat-1',
  target: 'latitude',
  placement: 'remote',
  host: '203.0.113.7',
  meta: { sshUser: 'ubuntu' },
};

type AuditEv = { action: string; actor: string; subject: string; details: Record<string, unknown> };

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: { write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = undefined; // no real process group — endSession falls back to child.kill
  child.stdin = { write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function fakeWs() {
  const ws = new EventEmitter() as EventEmitter & VncBridgeWs & {
    sent: Uint8Array[];
    send: (d: Uint8Array) => void;
    close: ReturnType<typeof vi.fn> & VncBridgeWs['close'];
  };
  ws.sent = [];
  ws.send = (d) => ws.sent.push(d);
  ws.close = vi.fn() as ReturnType<typeof vi.fn> & VncBridgeWs['close'];
  return ws;
}

function deps(over: Parameters<typeof _setFrameVncDepsForTests>[0] = {}) {
  const audits: AuditEv[] = [];
  _setFrameVncDepsForTests({
    loadFrame: async () => ({ frame: FRAME, config: { target: 'latitude' } }),
    audit: (ev) => audits.push(ev),
    ...over,
  });
  return audits;
}

afterEach(() => _resetFrameVncForTests());

describe('vncRemoteCommand', () => {
  it('watch mode: localhost-only x11vnc + socat bridge, read-only, on-demand', () => {
    const cmd = vncRemoteCommand(99, 'watch');
    expect(cmd).toContain('-display :99');
    expect(cmd).toContain('-localhost'); // never network-exposed
    expect(cmd).toContain('-once'); // exits when the viewer leaves
    expect(cmd).toContain('-timeout 30'); // self-exit if the bridge never connects
    expect(cmd).toContain('-nopw'); // auth is the ticketed tunnel, not an RFB pw
    expect(cmd).toContain('-viewonly');
    expect(cmd).toContain('socat STDIO TCP:127.0.0.1:$P'); // the stdio bridge
    expect(cmd).not.toContain('-inetd'); // -inetd can't run over an SSH pipe
    expect(cmd).not.toMatch(/0\.0\.0\.0/);
  });

  it('takeover mode drops -viewonly (D-002 explicit takeover)', () => {
    expect(vncRemoteCommand(100, 'takeover')).not.toContain('-viewonly');
    expect(vncRemoteCommand(100, 'takeover')).toContain('-display :100');
  });
});

describe('createVncSession + ticket lifecycle (P-010)', () => {
  it('mints a single-use ticket bound to the frame ssh command + audits the request', async () => {
    const audits = deps();
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:a' });
    expect(t.ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(audits[0]).toMatchObject({ action: 'frame-vnc.watch-requested', subject: 'h1:99' });

    const s = consumeTicket(t.ticket)!;
    expect(s.sshCmd.cmd).toBe('ssh');
    expect(s.sshCmd.args.at(-2)).toBe('ubuntu@203.0.113.7');
    // non-root login → sudo'd bridge command, read-only for watch on :99
    const remote = s.sshCmd.args.at(-1)!;
    expect(remote.startsWith('sudo -H bash -c ')).toBe(true);
    expect(remote).toContain('-display :99');
    expect(remote).toContain('-viewonly');
    expect(remote).toContain('socat STDIO TCP:127.0.0.1:$P');
    // single-use: second consume fails
    expect(consumeTicket(t.ticket)).toBeUndefined();
  });

  it('expired tickets are not consumable', async () => {
    let nowMs = 1_000_000;
    deps({ now: () => nowMs });
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'u' });
    nowMs += VNC_TICKET_TTL_MS + 1;
    expect(consumeTicket(t.ticket)).toBeUndefined();
  });

  it('no deployed frame → throws', async () => {
    deps({ loadFrame: async () => undefined });
    await expect(
      createVncSession({ slug: 'nope', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'u' }),
    ).rejects.toThrow(/no deployed frame/);
  });

  it('takeover request is audited as takeover (D-002)', async () => {
    const audits = deps();
    await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 100, mode: 'takeover', actor: 'user:b' });
    expect(audits[0]).toMatchObject({ action: 'frame-vnc.takeover-requested', subject: 'h1:100' });
  });
});

describe('bridgeVncSession (the RFB byte pipe + lifecycle)', () => {
  async function mintAndConsume(mode: 'watch' | 'takeover', audits: AuditEv[]) {
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode, actor: 'user:a' });
    audits.length = 0; // drop the *-requested event; tests below assert the bridge's events
    return consumeTicket(t.ticket)!;
  }

  it('pipes ws→stdin and stdout→ws; session is registered while open (D-002 indicator)', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('watch', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);

    expect(audits[0]).toMatchObject({ action: 'frame-vnc.watch-started', subject: 'h1:99' });
    expect(activeVncSessions('h1')).toHaveLength(1);
    expect(activeVncSessions('h1')[0]).toMatchObject({ display: 99, mode: 'watch', actor: 'user:a' });

    ws.emit('message', Buffer.from('rfb-client-bytes'));
    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from('rfb-client-bytes'));
    child.stdout.emit('data', Buffer.from('rfb-server-bytes'));
    expect(ws.sent[0]).toEqual(Buffer.from('rfb-server-bytes'));
  });

  it('viewer leaving kills the child + audits the end (P-010 idle teardown)', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('watch', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);

    ws.emit('close');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(activeVncSessions('h1')).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'frame-vnc.ended',
      details: expect.objectContaining({ why: 'viewer-left' }),
    });
  });

  it('remote side closing tears down the ws + deregisters', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('takeover', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);
    expect(audits[0]).toMatchObject({ action: 'frame-vnc.takeover-started' });

    child.emit('close');
    expect(ws.close).toHaveBeenCalled();
    expect(activeVncSessions()).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'frame-vnc.ended',
      details: expect.objectContaining({ why: 'remote-closed', mode: 'takeover' }),
    });
  });

  it('teardown is idempotent (close after close emits one ended event)', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('watch', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);
    ws.emit('close');
    child.emit('close');
    const ended = audits.filter((a) => a.action === 'frame-vnc.ended');
    expect(ended).toHaveLength(1);
  });
});
