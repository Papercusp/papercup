import { describe, expect, it } from 'vitest';
import { getRegistryEntryV2, MAX_SCHEDULED_OCCURRENCES_WINDOW_MS } from './index';

const schema = getRegistryEntryV2('plans.scheduledOccurrences')?.argsSchema;

describe('plans.scheduledOccurrences argument guard', () => {
  it('rejects zero, negative, fractional, and unsafe millisecond bounds', () => {
    expect(schema).toBeDefined();
    expect(() => schema!.parse({ rangeStartMs: 0, rangeEndMs: 1 })).toThrow();
    expect(() => schema!.parse({ rangeStartMs: -1, rangeEndMs: 1 })).toThrow();
    expect(() => schema!.parse({ rangeStartMs: 1.5, rangeEndMs: 2 })).toThrow();
    expect(() => schema!.parse({ rangeStartMs: Number.MAX_SAFE_INTEGER + 1, rangeEndMs: 2 })).toThrow();
  });

  it('rejects inverted and pathological multi-year windows', () => {
    expect(schema).toBeDefined();
    expect(() => schema!.parse({ rangeStartMs: 2_000, rangeEndMs: 1_000 })).toThrow(
      'rangeEndMs must be greater than or equal to rangeStartMs',
    );
    expect(() =>
      schema!.parse({ rangeStartMs: 1_000, rangeEndMs: 1_000 + MAX_SCHEDULED_OCCURRENCES_WINDOW_MS + 1 }),
    ).toThrow('scheduled occurrence windows may not exceed three years');
  });

  it('accepts a normal calendar window, including an exact three-year boundary', () => {
    const rangeStartMs = Date.parse('2026-01-01T00:00:00.000Z');
    expect(schema!.parse({
      rangeStartMs,
      rangeEndMs: rangeStartMs + MAX_SCHEDULED_OCCURRENCES_WINDOW_MS,
      harnessSlug: 'papercusp',
    })).toMatchObject({ harnessSlug: 'papercusp' });
  });
});
