// @vitest-environment jsdom
/**
 * ChatActionBar — verifies the registry-driven bar + the params/confirm/run
 * flow through askUserLocal, LocalCardHost-rendered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { z } from 'zod';

import { ChatActionBar } from './ChatActionBar';
import { LocalCardHost } from './LocalCardHost';
import { _resetAskUserLocalForTests } from '@/lib/chat-cards/ask-user-local';
import { _resetChatActionsForTests, registerChatAction } from '@/lib/chat-actions/registry';
import type { ChatActionContext } from '@/lib/chat-actions/types';

const ctx: ChatActionContext = { sessionOwnerId: 'su-1', ownerLabel: 'su-1' };

afterEach(() => {
  cleanup();
  _resetAskUserLocalForTests();
  _resetChatActionsForTests();
});

describe('ChatActionBar', () => {
  it('renders nothing when no action is available', () => {
    const { container } = render(<ChatActionBar ctx={ctx} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only available() actions', () => {
    registerChatAction({ id: 'shown', label: 'Shown', available: () => true, run: vi.fn() });
    registerChatAction({ id: 'hidden', label: 'Hidden', available: () => false, run: vi.fn() });
    render(<ChatActionBar ctx={ctx} />);
    expect(screen.getByText('Shown')).toBeTruthy();
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('a zero-param action runs immediately on click', async () => {
    const run = vi.fn();
    registerChatAction({ id: 'zero', label: 'Zero param', available: () => true, run });
    render(<ChatActionBar ctx={ctx} />);
    fireEvent.click(screen.getByText('Zero param'));
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx, undefined));
  });

  it('params() opens a card via LocalCardHost; submitting it calls run with the payload', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'with-params',
      label: 'With params',
      available: () => true,
      params: async () => ({
        prompt: 'Pick one',
        dataSchema: z.object({ picks: z.tuple([z.enum(['a', 'b'])]) }),
        presentation: {
          kind: 'radio',
          options: [
            { id: 'a', label: 'Option A' },
            { id: 'b', label: 'Option B' },
          ],
        },
      }),
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('With params'));
    await waitFor(() => expect(screen.getByText('Pick one')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx, { picks: ['a'] }));
  });

  it('declining the params card does NOT call run', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'declinable',
      label: 'Declinable',
      available: () => true,
      params: async () => ({
        prompt: 'q',
        dataSchema: z.object({ picks: z.tuple([z.enum(['x'])]) }),
        presentation: { kind: 'radio', options: [{ id: 'x', label: 'X' }] },
      }),
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('Declinable'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Skip this question/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Skip this question/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it('confirm step: Confirm click runs; run is not called without confirming', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'confirm-me',
      label: 'Dangerous',
      available: () => true,
      confirm: { message: 'Are you sure?', confirmLabel: 'Yes, do it' },
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('Dangerous'));
    await waitFor(() => expect(screen.getByText('Are you sure?')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Yes, do it/i }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx, undefined));
  });

  it('skipping the confirm card cancels — run is never called', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'confirm-skip',
      label: 'Dangerous2',
      available: () => true,
      confirm: { message: 'Sure?' },
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('Dangerous2'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Skip this question/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Skip this question/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it('groups render as separate clusters, in first-seen order', () => {
    registerChatAction({ id: 'b1', label: 'B1', group: 'beta', available: () => true, run: vi.fn() });
    registerChatAction({ id: 'a1', label: 'A1', group: 'alpha', available: () => true, run: vi.fn() });
    const { container } = render(<ChatActionBar ctx={ctx} />);
    const groups = container.querySelectorAll('.chat-action-bar-group');
    expect(groups.length).toBe(2);
    expect(groups[0].getAttribute('data-group')).toBe('beta');
    expect(groups[1].getAttribute('data-group')).toBe('alpha');
  });

  it('a run() rejection surfaces an error without crashing the bar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerChatAction({
      id: 'boom',
      label: 'Boom',
      available: () => true,
      run: () => {
        throw new Error('kaboom');
      },
    });
    render(<ChatActionBar ctx={ctx} />);
    fireEvent.click(screen.getByText('Boom'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/kaboom/));
    warn.mockRestore();
  });
});
