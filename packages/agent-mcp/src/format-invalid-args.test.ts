/**
 * Direct unit tests for `formatInvalidArgs` (server.ts) — the pure renderer
 * that turns Standard-Schema validation issues into the agent-facing
 * `invalid_args` message. No mocking needed: the function takes plain
 * issue/input data and returns a string, so these tests exercise it directly
 * rather than through the full `dispatch()` path (see server-dispatch.test.ts
 * for that; its own `too_big string` case is the precedent this mirrors).
 *
 * Kept mock-free deliberately: `server-dispatch.test.ts` mocks `standardValidate`
 * (a generic Standard-Schema function) via a bare `vi.fn()` module factory, which
 * cannot carry the real signature through `vi.mocked()` and forces every fixture
 * in that file through an `as never` escape — a file-wide baseline this repo's
 * `lint:mock-cast-escape` ratchet holds fixed (shrink-only). Testing the pure
 * renderer directly needs no such mock at all.
 */

import { describe, expect, it } from 'vitest';
import { formatInvalidArgs } from './server';

describe('formatInvalidArgs', () => {
  it('too_big number → states how far over + the usable ceiling (EI-21864057724720621)', () => {
    // Mirrors the pre-existing string too_big case in server-dispatch.test.ts:
    // a numeric ceiling (e.g. work_items:get's threadLimit, capped at 10) gets
    // the same "how far over, what to use instead" treatment instead of Zod's
    // bare "Too big: expected number to be <=10", which names the ceiling but
    // not the caller's actual value or how to fix it in one retry. Measured
    // recurring independently across 6+ sessions against this exact field.
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected number to be <=10',
          code: 'too_big',
          origin: 'number',
          maximum: 10,
          path: ['threadLimit'],
        },
      ],
      { threadLimit: 50 },
    );
    expect(message).toBe('threadLimit: too big — 40 over the 10 limit; use 10.');
  });

  it('too_big number without a numeric actual value at the issue path → falls back to the bare ceiling message', () => {
    // Defensive: the raw input can lack the offending value at the issue's
    // path (undefined/non-number). The rendered message must stay well-formed
    // rather than compute a NaN/garbage delta.
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected number to be <=10',
          code: 'too_big',
          origin: 'number',
          maximum: 10,
          path: ['threadLimit'],
        },
      ],
      {},
    );
    expect(message).toBe('threadLimit: too big — over the 10 limit; use 10.');
  });

  it('too_big number at exactly the maximum reads as "over" only when strictly greater', () => {
    // A too_big issue only fires when the value exceeds the max, so `over`
    // should never be reported as 0 or negative in practice — but guard the
    // arithmetic explicitly for a value equal to the maximum.
    const message = formatInvalidArgs(
      [{ message: 'Too big', code: 'too_big', origin: 'number', maximum: 10, path: ['n'] }],
      { n: 10 },
    );
    expect(message).toBe('n: too big — over the 10 limit; use 10.');
  });

  it('too_big string case is unaffected by the new number branch (regression guard)', () => {
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected string to have <=500 characters',
          code: 'too_big',
          origin: 'string',
          maximum: 500,
          path: ['goal'],
        },
      ],
      { goal: 'x'.repeat(912) },
    );
    expect(message).toBe('goal: too long — 412 chars over the 500-char limit; trim to 500.');
  });

  it('a non-too_big issue keeps its original path: message rendering', () => {
    const message = formatInvalidArgs([{ message: 'bad', path: ['x'] }], { x: 'no' });
    expect(message).toBe('x: bad');
  });

  it('multiple issues join with "; "', () => {
    const message = formatInvalidArgs(
      [
        {
          message: 'Too big: expected number to be <=10',
          code: 'too_big',
          origin: 'number',
          maximum: 10,
          path: ['threadLimit'],
        },
        { message: 'required', path: ['id'] },
      ],
      { threadLimit: 25 },
    );
    expect(message).toBe('threadLimit: too big — 15 over the 10 limit; use 10.; id: required');
  });
});
