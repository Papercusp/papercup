// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor } from '../scripts/psu-pty-host.mjs';

async function control(sock: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let bytes = '';
    conn.setTimeout(3000, () => conn.destroy(new Error('fixture control timed out')));
    conn.once('error', reject);
    conn.on('data', data => { bytes += data.toString(); });
    conn.once('end', () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
    conn.once('connect', () => conn.end(JSON.stringify(message)));
  });
}

it('holds real PTY owner input and refuses wake/raw/recycle effects until exact caller thaw', async () => {
  const ownerId = `test-assume-host-${process.pid}-${Date.now()}`;
  const nativeId = 'disposable-native';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const signals = new EventEmitter();
  let output = '';
  const prepare = vi.fn(async () => null);
  const onReexec = vi.fn();
  const done = hostThroughPty({ command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',b=>process.stdout.write('INPUT:'+b.toString()+'\\n'));process.stdout.write('FIXTURE_READY\\n');setInterval(()=>{},1000)"],
    cwd: process.cwd(), ownerId,
    env: hermeticEnv({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_SID: ownerId, PAPERCUSP_WORKSPACE: 'test-workspace',
      PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) }),
    resolveRespawnNativeId: () => nativeId,
    identityAssume: { verify: async () => true, prepare }, onReexec,
    signalSource: signals, emitCompacted: () => null, onExit: () => {}, bridgeTty: false,
    io: { stdin, stdout: { isTTY: false, columns: 100, rows: 30,
      write(data: string) { output += data; return true; } } },
  });
  try {
    const meta = await vi.waitFor(() => {
      const value = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
      expect(output).toContain('FIXTURE_READY');
      expect(value.identityAssume?.version).toBe(1);
      return value;
    }, { timeout: 5000 });
    const request = { transitionKey: `session-assume:${'a'.repeat(64)}`, preparationHash: 'b'.repeat(64),
      recoveryRef: 'carry-note:fixture', recoveryHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000,
      caller: { ownerId, workspaceId: 'test-workspace', nativeSessionId: nativeId,
        nativePid: meta.ptyPid, ...meta.identityAssume, childGeneration: meta.childGeneration } };
    const send = (action: string, value = request) => control(meta.sock, { v: 1, mode: 'identity-assume', ownerId, action, request: value });
    expect(await send('freeze')).toMatchObject({ ok: true, phase: 'frozen' });
    stdin.emit('data', Buffer.from('HELD_OWNER'));
    for (const mode of ['raw', 'turn', 'recycle', 'carry-respawn', 'hooks-observe', 'shutdown']) {
      expect(await control(meta.sock, { v: 1, mode, ownerId, data: 'MUST_NOT_RUN' }))
        .toMatchObject({ ok: false, reason: 'assume-caller-paused' });
    }
    expect(output).not.toContain('INPUT:HELD_OWNER');
    expect(await send('queue')).toMatchObject({ ok: true, phase: 'queued' });
    expect(await send('thaw', { ...request, recoveryHash: 'd'.repeat(64) })).toMatchObject({ ok: false });
    expect(prepare).not.toHaveBeenCalled(); // No native result/completion, so no target orders.
    expect(onReexec).not.toHaveBeenCalled();
    expect(await send('thaw')).toMatchObject({ ok: true, phase: 'released' });
    await vi.waitFor(() => expect(output).toContain('INPUT:HELD_OWNER'), { timeout: 3000 });
    expect(await send('freeze')).toMatchObject({ ok: false, reason: 'assume-replayed-transition' });
  } finally {
    signals.emit('SIGTERM');
    await done;
  }
}, 20_000);
