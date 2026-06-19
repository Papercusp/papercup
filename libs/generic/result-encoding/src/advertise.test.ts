/**
 * advertise.test.ts — advertisedArgsSchema decides what a tool's tools/list input
 * schema looks like to the model: a write-positional tool advertises a single `row`
 * string (so the model emits a positional row), everything else advertises its real
 * args unchanged. A bug here either hides a normal tool's args or advertises a `row`
 * for a tool whose shape can't actually be positional. registry is mocked.
 *
 * Borrowable-lib unit test (result-encoding, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/result-encoding && npx vitest run src/advertise.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isWritePositional: vi.fn<(n: string) => boolean>(() => false),
  getPrePromptEntry: vi.fn<(n: string) => { freeTextArg?: string } | undefined>(() => undefined),
}));
vi.mock('./registry', () => ({
  isWritePositional: (n: string) => h.isWritePositional(n),
  getPrePromptEntry: (n: string) => h.getPrePromptEntry(n),
}));

import { advertisedArgsSchema } from './advertise';

const FLAT_ARGS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' }, note: { type: 'string' } },
};
const NESTED_ARGS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' }, payload: { type: 'object' } }, // nested → not positional
};

afterEach(() => vi.clearAllMocks());

describe('advertisedArgsSchema', () => {
  it('returns the real args schema unchanged for a non-write-positional tool', () => {
    h.isWritePositional.mockReturnValue(false);
    expect(advertisedArgsSchema('plans:list', FLAT_ARGS)).toBe(FLAT_ARGS);
  });

  it('advertises a single `row` string for a write-positional tool that fits the shape', () => {
    h.isWritePositional.mockReturnValue(true);
    const out = advertisedArgsSchema('plans:set-status', FLAT_ARGS);
    expect(out).not.toBe(FLAT_ARGS);
    expect((out.properties as Record<string, unknown>).row).toBeDefined();
    expect(out.required).toEqual(['row']);
  });

  it('falls back to the real args when a write-positional tool does not fit (nested args)', () => {
    h.isWritePositional.mockReturnValue(true);
    expect(advertisedArgsSchema('plans:weird', NESTED_ARGS)).toBe(NESTED_ARGS);
  });
});
