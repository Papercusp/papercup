import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux').each([
  { scenario: 'storage', args: [], timeout: 240_000 },
  { scenario: 'HTTP operator', args: ['--http'], timeout: 600_000 },
])('retains the outside session, work-items and exact fleet across a $scenario restart offline', async test => {
  const script = fileURLToPath(new URL('../../../test/outside-plan-restart.mts', import.meta.url));
  const { stdout } = await promisify(execFile)('bwrap', [
    '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--tmpfs', '/run', '--', process.execPath, '--import', 'tsx', script, ...test.args,
  ], { timeout: test.timeout, maxBuffer: 8 * 1024 * 1024 });
  expect(stdout).toContain('application-process restart and exact-set drain verified');
  if (test.args.includes('--http')) {
    const prefix = 'Verified HTTP session, work-item references and fleet admission ';
    const receipts = stdout.split('\n').filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    expect(receipts.map(receipt => receipt.epoch)).toEqual(['before', 'after']);
    expect(receipts.every(receipt => Number.isSafeInteger(receipt.pid) && receipt.pid > 0)).toBe(true);
    expect(new Set(receipts.map(receipt => receipt.pid)).size).toBe(2);
  }
}, 610_000);
