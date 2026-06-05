/**
 * Coverage for registerAllExpirables — the central TTL-table registry. Mocks
 * the registry seam and asserts every expirable table is registered once, the
 * call is idempotent, harness_status carries its mark-status onExpire config,
 * and ensureExpirableRegistry is kicked.
 */
import { describe, expect, it, vi } from 'vitest';

const registerExpirable = vi.fn();
const ensureExpirableRegistry = vi.fn();
vi.mock('./expirable-registry', () => ({
  registerExpirable: (...a: unknown[]) => registerExpirable(...a),
  ensureExpirableRegistry: () => ensureExpirableRegistry(),
}));

import { registerAllExpirables } from './expirable-registrations';

describe('registerAllExpirables', () => {
  it('registers each expirable table exactly once and is idempotent', () => {
    registerAllExpirables();
    const afterFirst = registerExpirable.mock.calls.length;
    registerAllExpirables(); // second call must no-op (module-level _registered guard)
    expect(registerExpirable.mock.calls.length).toBe(afterFirst);
    expect(ensureExpirableRegistry).toHaveBeenCalled();

    const tables = registerExpirable.mock.calls.map((c) => (c[0] as { table: string }).table);
    expect(tables).toEqual(
      expect.arrayContaining([
        'harness_shared.operator_scan_locks',
        // operator_claims removed in P-002 (claim machinery deleted)
        'harness_shared.harness_status',
        'papercusp_auth.magic_link_requests',
        'papercusp_auth.sessions',
      ]),
    );
  });

  it('configures harness_status to MARK running rows stalled (not delete)', () => {
    registerAllExpirables(); // idempotent; reuses the first registration
    const statusReg = registerExpirable.mock.calls
      .map((c) => c[0] as { table: string; onExpire?: Record<string, unknown> })
      .find((r) => r.table === 'harness_shared.harness_status');
    expect(statusReg?.onExpire).toMatchObject({
      kind: 'mark-status',
      column: 'status',
      from: 'running',
      to: 'stalled',
    });
  });
});
