/**
 * acquire_granular.test.ts — the locks:acquire_granular HANDLER (tryAcquireGranular/
 * validatePath mocked; txn wrapper runs the callback). Pins: a non-root path is validated
 * (a bad path → { ok:false, error }, no store call); the harness root "" SKIPS validation
 * (it's a legal node); a conflict returns the conflict list; a success returns the full
 * lock-set + ISO expiry. A regression that validates "" away, or reports a conflict as
 * success, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/acquire_granular.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('./su-lock-store', () => ({ tryAcquireGranular: vi.fn(), validatePath: vi.fn() }));

import { tryAcquireGranular, validatePath } from './su-lock-store';
const acqM = vi.mocked(tryAcquireGranular);
const validateM = vi.mocked(validatePath);
const tool = (await import('./acquire_granular')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler({ mode: 'X', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  validateM.mockReset(); // clearAllMocks keeps implementations — reset the throw from the invalid-path test
  acqM.mockResolvedValue({ ok: true, lock_id: 'L1', locks: ['', 'src'], expires_ts: new Date('2026-02-01T00:00:00Z') } as never);
});

describe('locks:acquire_granular handler', () => {
  it('rejects an invalid non-root path before touching the store', async () => {
    validateM.mockImplementation(() => { throw new Error('path traversal not allowed'); });
    const b = body(await call({ path: '../etc/passwd' }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/traversal/);
    expect(acqM).not.toHaveBeenCalled();
  });

  it('allows the harness root "" (skips path validation) and returns the lock-set', async () => {
    const b = body(await call({ path: '' }));
    expect(validateM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, lock_id: 'L1', mode: 'X', locks: ['', 'src'], expires_ts: '2026-02-01T00:00:00.000Z' });
  });

  it('returns the conflict list when the lock-set cannot be granted', async () => {
    acqM.mockResolvedValue({ ok: false, reason: 'conflict', conflicts: [{ node: 'src', owner: 'other' }] } as never);
    const b = body(await call({ path: 'src', mode: 'X' }));
    expect(b).toMatchObject({ ok: false, reason: 'conflict', conflicts: [{ node: 'src', owner: 'other' }] });
  });
});
