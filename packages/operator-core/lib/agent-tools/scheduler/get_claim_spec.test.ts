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
});
