/**
 * scheduler:get_claim_spec — arg-schema tests (EI-7678).
 *
 * The refine mirrors set_claim_spec's exactly-one-of beeId|fleet gate.
 */
import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import getClaimSpecTool from './get_claim_spec';

const args = (getClaimSpecTool as { args: ZodTypeAny }).args;

describe('scheduler:get_claim_spec — args', () => {
  it('accepts beeId alone', () => {
    expect(args.safeParse({ beeId: 'su-bee-1' }).success).toBe(true);
  });

  it('accepts fleet alone', () => {
    expect(args.safeParse({ fleet: 'my-fleet' }).success).toBe(true);
  });

  it('rejects neither beeId nor fleet', () => {
    expect(args.safeParse({}).success).toBe(false);
  });

  it('rejects BOTH beeId and fleet (ambiguous target)', () => {
    expect(args.safeParse({ beeId: 'su-bee-1', fleet: 'my-fleet' }).success).toBe(false);
  });

  it('accepts an optional workspace override alongside beeId', () => {
    expect(args.safeParse({ beeId: 'su-bee-1', workspace: 'ws-1' }).success).toBe(true);
  });
});
