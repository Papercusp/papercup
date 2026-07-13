// @vitest-environment jsdom
/**
 * LocalCardHost — verifies the askUserLocal subscriber path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LocalCardHost } from './LocalCardHost';
import {
  _resetAskUserLocalForTests,
  askUserLocal,
} from '@/lib/chat-cards/ask-user-local';
import { z } from 'zod';

afterEach(() => {
  cleanup();
  _resetAskUserLocalForTests();
});

describe('LocalCardHost', () => {
  beforeEach(() => _resetAskUserLocalForTests());

  it('renders nothing when no askUserLocal calls', () => {
    const { container } = render(<LocalCardHost />);
    expect(container.firstChild).toBeNull();
  });

  it('subscribes on mount; renders an incoming radio card; submit resolves caller', async () => {
    render(<LocalCardHost />);
    const promise = askUserLocal({
      prompt: 'Pick one',
      dataSchema: z.object({ picks: z.tuple([z.enum(['a', 'b'])]) }),
      presentation: {
        kind: 'radio',
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' },
        ],
      },
    });
    // Microtask for subscriber + setState.
    await waitFor(() => {
      expect(screen.getByText('Pick one')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    const r = await promise;
    expect(r).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('submit/decline/cancel actions flow through to askUserLocal caller', async () => {
    render(<LocalCardHost />);
    const promise = askUserLocal({
      prompt: 'q',
      dataSchema: z.object({ picks: z.tuple([z.enum(['x'])]) }),
      presentation: { kind: 'radio', options: [{ id: 'x', label: 'X' }] },
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Skip this question/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Skip this question/i }));
    expect(await promise).toEqual({ action: 'decline' });
  });

  it('text presentation: renders InputCard, submits value', async () => {
    render(<LocalCardHost />);
    const promise = askUserLocal({
      prompt: 'Name?',
      dataSchema: z.object({ value: z.string() }),
      presentation: { kind: 'text', placeholder: 'name' },
    });
    await waitFor(() => {
      expect(screen.getByText('Name?')).toBeTruthy();
    });
    const input = screen.getByLabelText('response') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await promise).toEqual({
      action: 'submit',
      payload: { value: 'alice' },
    });
  });

  it('queue: second concurrent call surfaces only after the first resolves', async () => {
    render(<LocalCardHost />);
    const firstPromise = askUserLocal({
      prompt: 'First',
      dataSchema: z.object({ picks: z.tuple([z.enum(['ok'])]) }),
      presentation: { kind: 'radio', options: [{ id: 'ok', label: 'OK' }] },
    });
    const secondPromise = askUserLocal({
      prompt: 'Second',
      dataSchema: z.object({ picks: z.tuple([z.enum(['ok'])]) }),
      presentation: { kind: 'radio', options: [{ id: 'ok', label: 'OK' }] },
    });
    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy();
      expect(screen.getByText(/1 more card after this/)).toBeTruthy();
    });
    // Only First is interactive; submit it.
    fireEvent.click(screen.getByRole('button', { name: /^OK$/i }));
    expect(await firstPromise).toEqual({ action: 'submit', payload: { picks: ['ok'] } });
    // Now Second surfaces.
    await waitFor(() => {
      expect(screen.getByText('Second')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^OK$/i }));
    expect(await secondPromise).toEqual({ action: 'submit', payload: { picks: ['ok'] } });
  });

  it('unknown presentation: dismiss button cancels', async () => {
    render(<LocalCardHost />);
    const promise = askUserLocal({
      prompt: 'Mystery',
      dataSchema: z.object({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      presentation: undefined as any,
      fallbackText: 'No renderer',
    });
    await waitFor(() => {
      expect(screen.getByText(/^No renderer$|^Mystery$/)).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(await promise).toEqual({ action: 'cancel' });
  });
});
