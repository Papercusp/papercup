/**
 * @vitest-environment jsdom
 *
 * RTL tests for useFormWith — the Zod-resolver wrapper around react-hook-form.
 * Run with: cd apps/operator && npx vitest run lib/forms/useFormWith.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { z } from 'zod';
import { useFormWith } from './useFormWith';

afterEach(cleanup);

const Schema = z.object({ email: z.string().email(), age: z.number().min(0) });

describe('useFormWith', () => {
  it('exposes the wrapped react-hook-form API', () => {
    const { result } = renderHook(() => useFormWith(Schema));
    for (const k of ['register', 'reset', 'setValue', 'setError', 'getValues', 'watch', 'submit']) {
      expect(typeof (result.current as unknown as Record<string, unknown>)[k]).toBe('function');
    }
    expect(result.current.control).toBeTypeOf('object'); // RHF control is an object, not a fn
    expect(result.current.methods).toBeTypeOf('object');
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.errors).toEqual({});
  });

  it('blocks submit and surfaces a Zod error on invalid input', async () => {
    const { result } = renderHook(() => useFormWith(Schema));
    const onValid = vi.fn();
    await act(async () => {
      await result.current.submit(onValid)();
    });
    expect(onValid).not.toHaveBeenCalled();
    expect(result.current.errors.email).toBeDefined();
  });

  it('calls the valid handler with parsed data when input passes', async () => {
    const { result } = renderHook(() =>
      useFormWith(Schema, { defaultValues: { email: 'a@b.com', age: 3 } as never }),
    );
    const onValid = vi.fn();
    await act(async () => {
      await result.current.submit(onValid)();
    });
    expect(onValid).toHaveBeenCalledTimes(1);
    expect(onValid.mock.calls[0][0]).toMatchObject({ email: 'a@b.com', age: 3 });
  });
});
