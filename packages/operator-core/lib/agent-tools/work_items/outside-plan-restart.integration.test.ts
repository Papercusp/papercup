import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux')('retains the outside session, work-items and exact fleet across a process restart offline', async () => {
  const script = fileURLToPath(new URL('../../../test/outside-plan-restart.mts', import.meta.url));
  const { stdout } = await promisify(execFile)('bwrap', [
    '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--', process.execPath, '--import', 'tsx', script,
  ], { timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  expect(stdout).toContain('application-process restart and exact-set drain verified');
}, 250_000);
