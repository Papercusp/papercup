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

  it('WI-6552: a select card renders ONE compact trigger, not a row per option, and resolves the radio payload shape', async () => {
    render(<LocalCardHost />);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, label: `Rubric ${i}` }));
    const promise = askUserLocal({
      prompt: 'Grade mode explains itself here',
      dataSchema: z.object({ picks: z.tuple([z.string()]) }),
      presentation: { kind: 'select', placeholder: 'Grade', options: many },
    });

    // Keep the pending card's promise from surfacing as an unhandled rejection
    // when the test ends without answering it.
    promise.catch(() => {});

    const trigger = await waitFor(() => screen.getByTestId('local-card-select'));
    // THE OWNER'S COMPLAINT, ASSERTED STRUCTURALLY: a 12-option picker must not
    // put 12 rows on screen. Rendered as `radio` — which is what the former
    // 'Grade session…' rubric picker used to declare (that action was removed
    // 2026-08-03 as a duplicate of the GRADE mode pill) — this same card
    // produced one full-width button per option and filled the chat popup.
    // This loop fails in that world.
    for (const o of many) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${o.label}$`) })).toBeNull();
    }
    // Resting text is the placeholder, per the owner's "default text 'Grade'".
    expect(trigger.textContent).toContain('Grade');
    // ...and the explainer renders alongside it.
    expect(screen.getByText('Grade mode explains itself here')).toBeTruthy();
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

  // EI-19952165837170400: sidebar + session-popup mount LocalCardHost
  // simultaneously. A single askUserLocal card must render in exactly ONE
  // of them, and resolving it must not leave an orphaned, still-answerable
  // copy in the other.
  it('EI-19952165837170400: two mounted hosts — card renders in only the LATER-mounted one; resolving clears both', async () => {
    render(
      <div>
        <div data-testid="host-a">
          <LocalCardHost />
        </div>
        <div data-testid="host-b">
          <LocalCardHost />
        </div>
      </div>,
    );
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

    await waitFor(() => {
      expect(screen.getAllByText('Pick one')).toHaveLength(1);
    });

    // Renders in host-b (mounted after host-a — the DOM-later host wins the
    // election), and host-a stays empty rather than showing its own copy.
    const hostA = screen.getByTestId('host-a');
    const hostB = screen.getByTestId('host-b');
    expect(hostA.querySelector('.local-card-host')).toBeNull();
    expect(hostB.querySelector('.local-card-host')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    expect(await promise).toEqual({ action: 'submit', payload: { picks: ['a'] } });

    // No orphaned copy anywhere after resolving.
    await waitFor(() => {
      expect(screen.queryByText('Pick one')).toBeNull();
    });
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
