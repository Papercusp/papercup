/**
 * scheduler:get_claim_spec — arg-schema tests (EI-7678).
 *
 * The refine mirrors set_claim_spec's exactly-one-of cupId|fleet gate.
 */
import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import getClaimSpecTool from './get_claim_spec';

const args = (getClaimSpecTool as { args: ZodTypeAny }).args;

describe('scheduler:get_claim_spec — args', () => {
  it('opts out of the dispatcher ambient workspace transaction', () => {
    expect((getClaimSpecTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('accepts cupId alone', () => {
    expect(args.safeParse({ cupId: 'su-bee-1' }).success).toBe(true);
  });

  it('accepts fleet alone', () => {
    expect(args.safeParse({ fleet: 'my-fleet' }).success).toBe(true);
  });

  it('rejects neither cupId nor fleet', () => {
    expect(args.safeParse({}).success).toBe(false);
  });

  it('rejects BOTH cupId and fleet (ambiguous target)', () => {
    expect(args.safeParse({ cupId: 'su-bee-1', fleet: 'my-fleet' }).success).toBe(false);
  });

  it('accepts an optional workspace override alongside cupId', () => {
    expect(args.safeParse({ cupId: 'su-bee-1', workspace: 'ws-1' }).success).toBe(true);
  });

  it('rejects generic wake-context keys instead of accepting them as selectors', () => {
    for (const key of ['harness', 'planSlug']) {
      const parsed = args.safeParse({ fleet: 'my-fleet', [key]: 'context-value' });
      expect(parsed.success, `unexpectedly accepted ${key}`).toBe(false);
    }
  });

  it('accepts a bounded history window', () => {
    expect(args.safeParse({ fleet: 'my-fleet', history: 5 }).success).toBe(true);
    expect(args.safeParse({ cupId: 'su-bee-1', history: 1 }).success).toBe(true);
  });

  it('rejects a history window outside the bound (an unbounded read of a jsonb column)', () => {
    for (const history of [0, -1, 21, 2.5]) {
      expect(args.safeParse({ fleet: 'my-fleet', history }).success, `accepted ${history}`).toBe(
        false,
      );
    }
  });

  it('guidance warns fleet callers about the selector-only contract', () => {
    const when = getClaimSpecTool.guidance?.when ?? '';
    expect(when).toMatch(/selector-only/i);
    expect(when).toContain('harness');
    expect(when).toContain('planSlug');
    expect(when).toMatch(/rejected/i);
  });
});
