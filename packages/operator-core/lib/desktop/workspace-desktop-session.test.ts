import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, connect, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameDecoder, FrameType, encodeJsonFrame } from '@papercusp/ipc-framing';
import { kasmvncWebsocketPort } from './x-server-backend';
import type { SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';
import {
  WORKSPACE_DESKTOP_PROTOCOL, parseWorkspaceDesktop, provisionWorkspaceDesktop,
  serializeWorkspaceDesktop, serveWorkspaceDesktop, workspaceDesktopOptions,
} from './workspace-desktop-session';

const desktop = (): SandboxDesktop => ({
  display: ':110', number: 110, width: 1024, height: 768, taskId: null, xServer: 'kasmvnc',
  gl: { id: 'mesa-software', tier: 'software', renderer: 'llvmpipe', launchPrefix: [], env: {}, reason: 'measured' },
  glProbeSandboxed: true,
  endpoint: { host: '127.0.0.1', port: kasmvncWebsocketPort(110) },
  credentials: { passwordFile: '/private/passwords', view: { user: 'view', secret: 'view-secret' }, control: { user: 'control', secret: 'control-secret' }, destroy: vi.fn() },
  appDiagnostics: () => [], release: vi.fn(async () => {}),
});
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace desktop identity boundary', () => {
  it.each(['xServer', 'displayNumber', 'credentialDir', 'kasmvncPasswordFile', 'sandboxApps', 'env', 'user'])('refuses caller-selected %s', key => {
    expect(() => workspaceDesktopOptions.parse({ [key]: 'override' })).toThrow();
  });
  it('refuses oversized geometry, argument lists and NUL bytes', () => {
    for (const options of [{ width: 7681 }, { apps: [['echo', '\0']] }, { apps: Array(17).fill(['echo']) }]) {
      expect(() => workspaceDesktopOptions.parse(options)).toThrow();
    }
  });
  it('transfers only the viewer grants and measured capability, never the credential file', () => {
    const result = parseWorkspaceDesktop(serializeWorkspaceDesktop(desktop()));
    expect(JSON.stringify(result)).not.toContain('/private/passwords');
    expect(result.gl.renderer).toBe('llvmpipe');
    expect(result.credentials.view.secret).not.toBe(result.credentials.control.secret);
  });
  it('refuses an off-host or mismatched endpoint', () => {
    const reply = parseWorkspaceDesktop(serializeWorkspaceDesktop(desktop()));
    expect(() => parseWorkspaceDesktop({ ...reply, endpoint: { ...reply.endpoint, host: '0.0.0.0' } })).toThrow();
    expect(() => parseWorkspaceDesktop({ ...reply, display: ':111' })).toThrow();
    expect(() => parseWorkspaceDesktop({ ...reply, endpoint: { ...reply.endpoint, port: 3070 } })).toThrow();
  });
  it('cleans a lease when the caller disconnects during provisioning', async () => {
    const input = new PassThrough(); const output = new PassThrough(); output.resume();
    const lease = desktop();
    let finish!: (value: SandboxDesktop) => void;
    const provision = vi.fn(() => new Promise<SandboxDesktop>(r => { finish = r; }));
    const serving = serveWorkspaceDesktop(input, output, provision);
    input.write(encodeJsonFrame(FrameType.REQUEST, { protocol: WORKSPACE_DESKTOP_PROTOCOL, action: 'provision', options: {} }));
    await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());
    input.destroy(); finish(lease);
    await serving;
    expect(lease.release).toHaveBeenCalledOnce();
  });
  it('rejects a repeated provision and releases the already created desktop', async () => {
    const input = new PassThrough(); const output = new PassThrough(); const bytes: Buffer[] = [];
    output.on('data', b => bytes.push(b));
    const lease = desktop(); const provision = vi.fn(async () => lease);
    const serving = serveWorkspaceDesktop(input, output, provision);
    const frame = encodeJsonFrame(FrameType.REQUEST, { protocol: WORKSPACE_DESKTOP_PROTOCOL, action: 'provision', options: {} });
    input.write(Buffer.concat([frame, frame]));
    await serving;
    expect(provision).toHaveBeenCalledOnce(); expect(lease.release).toHaveBeenCalledOnce();
    const decoder = new FrameDecoder(); decoder.push(Buffer.concat(bytes));
    expect(decoder.drain().map(f => f.type)).toEqual([FrameType.EVENT_JSON, FrameType.ERROR]);
  });
  it('round-trips the real Unix socket, then waits for worker cleanup on release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-desktop-wire-')); roots.push(root);
    const path = join(root, 'session.sock'); const lease = desktop();
    const provision = vi.fn(async () => lease);
    const server = createServer({ allowHalfOpen: true }, socket => { void serveWorkspaceDesktop(socket, socket, provision); });
    servers.push(server);
    await new Promise<void>(r => server.listen(path, r));
    const remote = await provisionWorkspaceDesktop({ width: 1280, apps: [['xterm']] }, { connect: () => connect(path) });
    expect(remote.isAlive?.()).toBe(true);
    expect(provision).toHaveBeenCalledWith({ width: 1280, apps: [['xterm']] });
    expect(remote.endpoint).toEqual(lease.endpoint);
    expect(remote.credentials?.control.secret).toBe('control-secret');
    await remote.release();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(remote.isAlive?.()).toBe(false);
  });
});
