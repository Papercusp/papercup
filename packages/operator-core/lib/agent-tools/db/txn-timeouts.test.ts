/**
 * db:txn-timeouts metadata — keep the discriminated read shape discoverable.
 *
 * The live schema rejects `{}` before the handler runs, so the read path must
 * teach callers to send `{ op: 'get' }` rather than merely saying "get".
 */
import { describe, expect, it } from 'vitest';
import tool from './txn-timeouts';

describe('db:txn-timeouts tool contract', () => {
  it('documents and accepts the required op discriminator for reads', () => {
    const when = tool.guidance?.when ?? '';

    expect(when).toContain('db:txn-timeouts');
    expect(when).toContain('{ op: "get" }');
    expect(when).toMatch(/op is required/i);
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ op: 'get' }).success).toBe(true);
  });
});
