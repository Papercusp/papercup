/**
 * typed-mock.test.ts — the typed alternative to `.mock*(... as never)` (EI-19282401068515102).
 *
 * Two things are worth pinning here: the helpers forward correctly at RUNTIME (no
 * behavior change vs calling the vitest method directly), and — the entire point of
 * this file existing — a fixture missing a required field is a COMPILE ERROR, not a
 * silent runtime pass. `@ts-expect-error` on the stale-fixture case fails the build if
 * that stops being true (e.g. if someone "fixes" a type by loosening it).
 */
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import {
  mockImplementationTyped,
  mockRejectedTyped,
  mockResolvedOnceTyped,
  mockResolvedTyped,
  mockReturnOnceTyped,
  mockReturnTyped,
} from './typed-mock';

interface Widget {
  id: string;
  name: string;
}

type FetchWidget = (id: string) => Promise<Widget>;
type GetLabel = () => string;

// A real vitest mock, typed as-if produced by `vi.mocked(realFn)` — that is the one
// legitimate cast this file needs, to stand in for the real function's inferred type.
const asyncMock = vi.fn() as unknown as Mock<FetchWidget>;
const syncMock = vi.fn() as unknown as Mock<GetLabel>;

describe('typed-mock helpers', () => {
  it('mockResolvedTyped forwards to mockResolvedValue and resolves the given value', async () => {
    mockResolvedTyped(asyncMock, { id: 'w1', name: 'Widget One' });
    await expect(asyncMock('w1')).resolves.toEqual({ id: 'w1', name: 'Widget One' });
  });

  it('mockResolvedOnceTyped forwards to mockResolvedValueOnce (one-shot)', async () => {
    mockResolvedTyped(asyncMock, { id: 'default', name: 'Default' });
    mockResolvedOnceTyped(asyncMock, { id: 'w2', name: 'Widget Two' });
    await expect(asyncMock('w2')).resolves.toEqual({ id: 'w2', name: 'Widget Two' });
    await expect(asyncMock('w2')).resolves.toEqual({ id: 'default', name: 'Default' });
  });

  it('mockReturnTyped forwards to mockReturnValue', () => {
    mockReturnTyped(syncMock, 'a label');
    expect(syncMock()).toBe('a label');
  });

  it('mockReturnOnceTyped forwards to mockReturnValueOnce (one-shot)', () => {
    mockReturnTyped(syncMock, 'default label');
    mockReturnOnceTyped(syncMock, 'one-shot label');
    expect(syncMock()).toBe('one-shot label');
    expect(syncMock()).toBe('default label');
  });

  it('mockImplementationTyped forwards to mockImplementation', async () => {
    mockImplementationTyped(asyncMock, async (id) => ({ id, name: `computed-${id}` }));
    await expect(asyncMock('w3')).resolves.toEqual({ id: 'w3', name: 'computed-w3' });
  });

  it('mockRejectedTyped forwards to mockRejectedValue', async () => {
    mockRejectedTyped(asyncMock, new Error('boom'));
    await expect(asyncMock('w4')).rejects.toThrow('boom');
  });

  it('COMPILE-TIME: a fixture missing a required field is a type error, not a silent pass', () => {
    // @ts-expect-error — `name` is required on Widget; this is exactly the WI-6673 shape
    // (a fixture that goes stale when a shared interface gains a required field) and it
    // MUST fail to compile here, not fail at runtime in some unrelated file.
    mockResolvedTyped(asyncMock, { id: 'incomplete' });
    expect(true).toBe(true);
  });
});
