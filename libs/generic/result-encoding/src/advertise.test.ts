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
  getPrePromptEntry: vi.fn<
    (n: string) =>
      | {
          freeTextArg?: string;
          writeColumnNames?: readonly string[];
          writeRequiredColumnNames?: readonly string[];
          writeKeyedFallback?: boolean;
        }
      | undefined
  >(() => undefined),
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
const BULK_ARGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    state: { type: 'string' },
    harness: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } } } },
  },
};

afterEach(() => {
  vi.clearAllMocks();
  h.getPrePromptEntry.mockReturnValue(undefined);
});

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

  it('advertises row OR full keyed args for bulk tools with explicit row columns', () => {
    h.isWritePositional.mockReturnValue(true);
    h.getPrePromptEntry.mockReturnValue({
      writeColumnNames: ['id', 'state', 'harness'],
      writeRequiredColumnNames: ['id', 'state'],
      writeKeyedFallback: true,
    });
    const out = advertisedArgsSchema('work_items:set_state', BULK_ARGS);
    const oneOf = (out as { oneOf?: unknown[] }).oneOf;
    expect(oneOf).toHaveLength(2);
    const rowProps = (oneOf![0] as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(rowProps)).toEqual(['row']);
    expect((rowProps.row as { description?: string }).description).toContain('id, state, harness?');
    expect(oneOf![1]).toBe(BULK_ARGS);
    // WI-3290: the MCP spec requires inputSchema.type === 'object'. A bare
    // top-level oneOf made strict clients (Claude Code, ptool) reject the
    // ENTIRE tool catalog — sessions booted with zero tools.
    expect(out.type).toBe('object');
  });

  it('is idempotent for a row+keyed oneOf advertisement', () => {
    h.isWritePositional.mockReturnValue(true);
    h.getPrePromptEntry.mockReturnValue({
      writeColumnNames: ['id', 'state'],
      writeRequiredColumnNames: ['id', 'state'],
      writeKeyedFallback: true,
    });
    const once = advertisedArgsSchema('work_items:set_state', BULK_ARGS);
    expect(advertisedArgsSchema('work_items:set_state', once)).toBe(once);
  });
});
