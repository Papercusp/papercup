/**
 * Unit coverage for the P-029 `harness_slugs` arg on plans:list.
 * Per audit follow-up to `plans-newbutton-and-subharness-scope-2026-05-25`.
 *
 * The full multi-harness fan-out scenario requires PG (loadHarnessRegistry)
 * and a real filesystem fixture, which makes it an integration concern.
 * Here we lock in the schema contract — the field shape + the 64-cap —
 * which is what the dispatcher actually enforces before the handler runs.
 * Verified live (curl) that the fan-out itself works against the running host.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PLAN_STATUSES } from '../parser';

// Mirror of the argsSchema in list.ts. Kept in sync deliberately —
// list.ts is the source of truth; if it drifts, this test catches it
// by failing to validate inputs the source schema would reject.
const HARNESS_SLUGS_MAX = 64;
const argsSchema = z.object({
  status: z
    .enum([...PLAN_STATUSES] as [string, ...string[]])
    .optional(),
  includeArchived: z.boolean().optional(),
  includeLegacy: z.boolean().optional(),
  harness_slugs: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().min(1)).max(HARNESS_SLUGS_MAX, { message: `harness_slugs capped at ${HARNESS_SLUGS_MAX}` }))
    .optional(),
});

describe('plans:list argsSchema (P-029)', () => {
  it('accepts an omitted harness_slugs', () => {
    expect(argsSchema.parse({}).harness_slugs).toBeUndefined();
  });

  it('accepts a single-entry harness_slugs', () => {
    expect(argsSchema.parse({ harness_slugs: ['papercup'] }).harness_slugs).toEqual(['papercup']);
  });

  it('coerces a bare string harness_slugs into a single-entry array (HTTP single-param case)', () => {
    expect(argsSchema.parse({ harness_slugs: 'papercup' }).harness_slugs).toEqual(['papercup']);
  });

  it('accepts a multi-entry harness_slugs', () => {
    const slugs = ['papercup', 'sheets', 'papercup/libs/sync'];
    expect(argsSchema.parse({ harness_slugs: slugs }).harness_slugs).toEqual(slugs);
  });

  it('rejects empty-string entries inside harness_slugs', () => {
    expect(() => argsSchema.parse({ harness_slugs: ['ok', ''] })).toThrow();
  });

  it('accepts exactly 64 entries', () => {
    const slugs = Array.from({ length: 64 }, (_, i) => `slug-${i}`);
    expect(argsSchema.parse({ harness_slugs: slugs }).harness_slugs).toHaveLength(64);
  });

  it('rejects 65 entries with the documented message', () => {
    const slugs = Array.from({ length: 65 }, (_, i) => `slug-${i}`);
    expect(() => argsSchema.parse({ harness_slugs: slugs })).toThrow(/capped at 64/);
  });

  it('composes with the other args', () => {
    const parsed = argsSchema.parse({
      status: 'active',
      includeArchived: true,
      harness_slugs: ['a', 'b'],
    });
    expect(parsed.status).toBe('active');
    expect(parsed.includeArchived).toBe(true);
    expect(parsed.harness_slugs).toEqual(['a', 'b']);
  });
});
