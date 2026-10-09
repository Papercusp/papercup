// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor, socketPathFor } from '../scripts/psu-pty-host.mjs';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('managed output fixture did not reach its expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('managed PTY terminal output congestion', () => {
  it('pauses PTY output while still delivering owner input, then drains in order and cleans up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-output-congestion-'));
    const inputPath = join(root, 'input');
    const ownerId = `su-output-congestion-${process.pid}-${Date.now()}`;
    const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
    let captured = '';
    let congested = true;
    const stdout = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24,
      write(data: string) { captured += data; return !congested; },
    });
    const pause = vi.fn();
    const resume = vi.fn();
    const onExit = vi.fn();
    const done = hostThroughPty({
      command: process.execPath,
      args: ['-e', "const fs=require('fs');process.stdin.setRawMode(true);process.stdout.write('READY\\n');process.stdin.on('data',d=>{if(d.includes(4))process.exit(0);fs.appendFileSync(process.env.INPUT_PATH,d);process.stdout.write('ECHO:'+d+'\\n');});setTimeout(()=>process.exit(2),10000);"],
      cwd: root, ownerId, io: { stdin, stdout }, bridgeTty: false,
      env: hermeticEnv({ PAPERCUSP_SID: ownerId, INPUT_PATH: inputPath }),
      onExit,
      signalSource: new EventEmitter(),
      spawnPty: (file: string, argv: string[], options: object, realSpawn: Function) => {
        const child = realSpawn(file, argv, options);
        const realPause = child.pause.bind(child);
        const realResume = child.resume.bind(child);
        child.pause = () => { pause(); realPause(); };
        child.resume = () => { resume(); realResume(); };
        return child;
      },
    });
    try {
      await until(() => captured.includes('READY'));
      expect(pause).toHaveBeenCalledOnce();
      stdin.emit('data', Buffer.from('owner-input'));
      // Output remains paused, but the real child receives the input and proves
      // it outside the terminal stream. A synchronous host would never do this.
      await until(() => existsSync(inputPath) && readFileSync(inputPath, 'utf8') === 'owner-input');
      expect(captured).not.toContain('ECHO:owner-input');
      expect(resume).not.toHaveBeenCalled();
      congested = false;
      stdout.emit('drain');
      await until(() => captured.includes('ECHO:owner-input'));
      expect(resume).toHaveBeenCalledOnce();
      expect(captured.indexOf('READY')).toBeLessThan(captured.indexOf('ECHO:owner-input'));
      stdin.emit('data', Buffer.from('\x04'));
      expect(await done).toBe(0);
      expect(onExit).toHaveBeenCalledOnce();
      expect(existsSync(metaPathFor(ownerId))).toBe(false);
      expect(existsSync(socketPathFor(ownerId))).toBe(false);
      expect(stdout.listenerCount('drain')).toBe(0);
      expect(stdout.listenerCount('error')).toBe(0);
    } finally {
      congested = false;
      stdout.emit('drain');
      stdin.emit('data', Buffer.from('\x04'));
      await done;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
