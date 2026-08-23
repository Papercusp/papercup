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
  vncBridgeScript,
  localVncCommand,
  VNC_TICKET_TTL_MS,
  _setFrameVncDepsForTests,
  _resetFrameVncForTests,
  type VncBridgeWs,
} from './frame-vnc';
import type { DesktopSessionRecord } from '../desktop/desktop-session-registry';

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
    expect(s.target).toBe('frame');
    expect(s.spawnCmd.cmd).toBe('ssh');
    expect(s.spawnCmd.args.at(-2)).toBe('ubuntu@203.0.113.7');
    // non-root login → sudo'd bridge command, read-only for watch on :99
    const remote = s.spawnCmd.args.at(-1)!;
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

// ── P-004: local desktops reuse the same machinery, with an admission gate ────

/** A registry row shaped like the one desktop-lease registers for a pot lease. */
function localRecord(over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds-local-1',
    workspaceId: 'ws',
    harnessSlug: 'h1',
    kind: 'xvfb-local',
    scope: 'pot',
    scopeRef: 'h1',
    hostRef: null,
    ownerPid: process.pid,
    ownerBootId: 'boot-1',
    display: ':110',
    displayGeometry: { width: 1280, height: 1024, depth: 24 },
    captureGeometry: { width: 1024, height: 768 },
    state: 'ready',
    leaseHolder: null,
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {},
    ttlSec: null,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    releasedAt: null,
    ...over,
  };
}

/**
 * Wire the local deps: a registry that admits exactly `admitted` displays, and a
 * recording viewer-setter. Deliberately NOT a blanket "resolve always succeeds"
 * stub — the whole point of the gate is which displays it refuses.
 */
function localDeps(admitted: Record<string, DesktopSessionRecord>, over: Parameters<typeof _setFrameVncDepsForTests>[0] = {}) {
  const audits: AuditEv[] = [];
  const viewerWrites: { id: string; mode: string; actor: string | null | undefined }[] = [];
  _setFrameVncDepsForTests({
    // A frame loader that would SUCCEED — so a test proving the local path was
    // taken cannot pass merely because the frame path was unavailable.
    loadFrame: async () => ({ frame: FRAME, config: { target: 'latitude' } }),
    audit: (ev) => audits.push(ev),
    resolveLocalDesktop: async ({ display }) => admitted[display],
    setViewer: async (id, viewer) => {
      viewerWrites.push({ id, mode: viewer.mode, actor: viewer.actor });
      return true;
    },
    ...over,
  });
  return { audits, viewerWrites };
}

describe('local desktop VNC target (P-004)', () => {
  it('localVncCommand is the SAME bridge script as the frame path, minus ssh and sudo', () => {
    const local = localVncCommand(110, 'watch');
    expect(local.cmd).toBe('bash');
    expect(local.args[0]).toBe('-c');
    // Identical script text — this is what "reuse, do not fork the bridge" means,
    // and it fails the moment someone gives local its own divergent command.
    expect(local.args[1]).toBe(vncBridgeScript(110, 'watch'));
    expect(local.args[1]).toContain('-display :110');
    expect(local.args[1]).toContain('-localhost'); // never network-exposed
    expect(local.args[1]).toContain('-viewonly'); // watch is read-only server-side
    expect(local.args[1]).not.toContain('sudo'); // we already own this Xvfb
    expect(local.args[1]).not.toMatch(/0\.0\.0\.0/);
  });

  it('takeover drops -viewonly on the local path too', () => {
    expect(localVncCommand(110, 'takeover').args[1]).not.toContain('-viewonly');
  });

  it('a registered local display mints a ticket bound to a LOCAL spawn (no ssh hop)', async () => {
    const { audits } = localDeps({ ':110': localRecord() });
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    expect(t.target).toBe('local');
    expect(t.desktopSessionId).toBe('ds-local-1');

    const s = consumeTicket(t.ticket)!;
    expect(s.spawnCmd.cmd).toBe('bash'); // NOT 'ssh' — the hop is gone
    expect(s.spawnCmd.args.at(-1)).toContain('-display :110');
    expect(audits[0]).toMatchObject({
      action: 'frame-vnc.watch-requested',
      subject: 'local:h1:110', // distinguishable from a frame's 'h1:110'
      details: expect.objectContaining({ target: 'local', desktopSessionId: 'ds-local-1' }),
    });
  });

  // ── the admission gate. These are the tests that matter. ──
  it('REFUSES an unregistered display — the owner\'s real desktop is not viewable', async () => {
    localDeps({ ':110': localRecord() }); // :110 is an agent desktop; :0 is the human's
    await expect(
      createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 0, mode: 'takeover', actor: 'user:a', target: 'local',
      }),
    ).rejects.toThrow(/not a registered local agent desktop/);
  });

  it('refusal happens BEFORE any process is spawned, and is audited as nothing', async () => {
    const spawn = vi.fn();
    const { audits } = localDeps({}, { spawn: spawn as unknown as typeof import('node:child_process').spawn });
    await expect(
      createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 1, mode: 'watch', actor: 'user:a', target: 'local',
      }),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    // no ticket was minted, so nothing is consumable and nothing was audited as granted
    expect(audits).toHaveLength(0);
  });

  it('a RELEASED desktop stops being viewable (resolver excludes terminal rows)', async () => {
    // The resolver's own query filters terminal states; here the stub mirrors that
    // by simply not admitting the display, which is what a released row produces.
    localDeps({});
    await expect(
      createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
      }),
    ).rejects.toThrow(/not a registered local agent desktop/);
  });

  it('default target stays FRAME — a caller that says nothing keeps pre-P-004 behaviour', async () => {
    localDeps({ ':110': localRecord() });
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a',
    });
    expect(t.target).toBe('frame');
    expect(consumeTicket(t.ticket)!.spawnCmd.cmd).toBe('ssh');
  });

  // ── the cross-process viewer indicator ──
  it('binds the viewer on the registry row while open and CLEARS it on teardown', async () => {
    const child = fakeChild();
    const { viewerWrites } = localDeps(
      { ':110': localRecord() },
      { spawn: (() => child) as unknown as typeof import('node:child_process').spawn },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'takeover', actor: 'user:a', target: 'local',
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    await Promise.resolve();
    expect(viewerWrites).toEqual([{ id: 'ds-local-1', mode: 'takeover', actor: 'user:a' }]);

    ws.emit('close');
    await Promise.resolve();
    expect(viewerWrites.at(-1)).toEqual({ id: 'ds-local-1', mode: 'none', actor: null });
  });

  it('clears the viewer on EVERY teardown reason, not just the viewer leaving', async () => {
    const child = fakeChild();
    const { viewerWrites } = localDeps(
      { ':110': localRecord() },
      { spawn: (() => child) as unknown as typeof import('node:child_process').spawn },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    bridgeVncSession(fakeWs(), consumeTicket(t.ticket)! as never);
    child.emit('close'); // the desktop side went away, not the viewer
    await Promise.resolve();
    expect(viewerWrites.at(-1)).toEqual({ id: 'ds-local-1', mode: 'none', actor: null });
  });

  it('a failing viewer write does not break the session (indicator is cosmetic)', async () => {
    const child = fakeChild();
    const { audits } = localDeps(
      { ':110': localRecord() },
      {
        spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
        setViewer: async () => {
          throw new Error('row vanished mid-session');
        },
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = await createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
      });
      const ws = fakeWs();
      expect(() => bridgeVncSession(ws, consumeTicket(t.ticket)! as never)).not.toThrow();
      await Promise.resolve();
      // the session is live and byte-piping regardless
      child.stdout.emit('data', Buffer.from('rfb'));
      expect(ws.sent[0]).toEqual(Buffer.from('rfb'));
      expect(audits.some((a) => a.action === 'frame-vnc.watch-started')).toBe(true);
      // swallowed, but NOT silently: a lost indicator write is still reported.
      expect(warn).toHaveBeenCalledWith(
        '[frame-vnc] viewer indicator write failed:',
        expect.objectContaining({ message: 'row vanished mid-session' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('frame sessions write NO viewer row (they have none) — negative control', async () => {
    const child = fakeChild();
    const { viewerWrites } = localDeps(
      { ':110': localRecord() },
      { spawn: (() => child) as unknown as typeof import('node:child_process').spawn },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:a', target: 'frame',
    });
    bridgeVncSession(fakeWs(), consumeTicket(t.ticket)! as never);
    await Promise.resolve();
    expect(viewerWrites).toEqual([]);
  });

  it('local and frame sessions coexist in activeVncSessions, tagged by target', async () => {
    const { audits } = localDeps({ ':110': localRecord() }, {
      spawn: (() => fakeChild()) as unknown as typeof import('node:child_process').spawn,
    });
    const a = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    const b = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:b', target: 'frame',
    });
    bridgeVncSession(fakeWs(), consumeTicket(a.ticket)! as never);
    bridgeVncSession(fakeWs(), consumeTicket(b.ticket)! as never);
    const live = activeVncSessions('h1');
    expect(live.map((s) => s.target).sort()).toEqual(['frame', 'local']);
    expect(audits.filter((x) => x.action.endsWith('-started'))).toHaveLength(2);
  });
});
