import { describe, expect, it } from 'vitest';
import { ensureBootstrap, getResource, getTxPool, registerResource, _resetForTests } from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const unique = () => `runtime-register-${Date.now()}-${seq++}`;

describe('resource registry registration', async () => {
  const live = await dbLive();

  it.skipIf(!live)('creates once and never rewrites a concurrent registration policy', async () => {
    await ensureBootstrap();
    const resource = unique();

    const first = await inWorkspaceTxn('register-resource-test', 'A', (tx) =>
      registerResource(tx, {
        resource,
        description: 'first policy',
        rule_text: 'Acquire exclusive before the action.',
        enforcement: 'enforced',
      }),
    );
    expect(first.created).toBe(true);
    expect(first.resource.description).toBe('first policy');

    const second = await inWorkspaceTxn('register-resource-test', 'B', (tx) =>
      registerResource(tx, {
        resource,
        description: 'conflicting policy',
        rule_text: 'This must not replace the first policy.',
        enforcement: 'advisory',
        max_holders: 2,
      }),
    );
    expect(second.created).toBe(false);
    expect(second.resource.description).toBe('first policy');
    expect(second.resource.enforcement).toBe('enforced');
    expect(second.resource.max_holders).toBeNull();
    expect((await getResource(getTxPool(), resource))?.rule_text).toBe('Acquire exclusive before the action.');

    await _resetForTests();
  });
});
