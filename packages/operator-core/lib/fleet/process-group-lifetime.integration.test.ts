import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('process group host shutdown', () => {
  it.each(['SIGTERM', 'exit'] as const)('reaps a real helper after host %s', async (ending) => {
    const moduleUrl = new URL('./process-group-lifetime.ts', import.meta.url).href;
    const helper = "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);";
    const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { processGroupLifetime } from ${JSON.stringify(moduleUrl)};
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const lifetime = processGroupLifetime(child, message => process.stderr.write(message));
      child.on('close', () => void lifetime.waitForExit());
      child.on('message', pid => { process.send(pid); child.disconnect(); });
      process.on('message', () => process.exit(0));
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let helperPid = 0;
    let stderr = '';
    host.stderr?.on('data', (data) => { stderr += data; });
    const closed = once(host, 'close');
    try {
      helperPid = await Promise.race([
        once(host, 'message').then(([pid]) => Number(pid)),
        closed.then(() => { throw new Error(`host exited before fixture ready: ${stderr}`); }),
      ]);
      expect(alive(helperPid)).toBe(true);
      if (ending === 'exit') host.send('exit');
      else host.kill(ending);
      await closed;
      await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 5000 });
    } finally {
      if (alive(host.pid!)) host.kill('SIGKILL');
      if (helperPid && alive(helperPid)) process.kill(-helperPid, 'SIGKILL');
      await closed;
    }
  }, 20_000);
});
