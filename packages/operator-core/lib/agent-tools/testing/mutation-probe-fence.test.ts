import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(),
}));

import { readQueue } from '../locks/su-lock-store';
import { runTestFilesCore } from './run';

const readQueueMock = vi.mocked(readQueue);
let root: string;

afterEach(() => {
  readQueueMock.mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'testing-run-mutation-probe-fence-'));
  return root;
}

it('refuses the run before root discovery when the checkout has an active mutation-probe lock', async () => {
  readQueueMock.mockResolvedValue({
    active_locks: [{ path: 'src/subject.ts', intent: ' mutation probe ' }],
    waiting: [],
  } as never);

  const checkout = makeRoot();
  const result = await runTestFilesCore({ root: checkout, files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active' });
  expect(result.hint).toContain('src/subject.ts');
  expect(readQueueMock).toHaveBeenCalledWith(expect.anything(), { coordinationDomain: checkout });
});

it('fails closed when the lock ledger cannot establish whether a probe is active', async () => {
  readQueueMock.mockRejectedValue(new Error('lock ledger unavailable'));

  const result = await runTestFilesCore({ root: makeRoot(), files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_state_unknown' });
  expect(result.hint).toContain('lock ledger unavailable');
});

it('continues to ordinary root validation when no mutation-probe lock is active', async () => {
  readQueueMock.mockResolvedValue({ active_locks: [], waiting: [] } as never);

  const result = await runTestFilesCore({ root: makeRoot(), files: ['tests/subject.test.ts'] });

  expect(result).toMatchObject({ ok: false, error: 'invalid_root' });
});
