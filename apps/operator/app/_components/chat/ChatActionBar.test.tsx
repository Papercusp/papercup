// @vitest-environment jsdom
/**
 * ChatActionBar — verifies the registry-driven bar + the params/confirm/run
 * flow through askUserLocal, LocalCardHost-rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { z } from 'zod';

import { ChatActionBar, withTimeout, PARAMS_TIMEOUT_MS } from './ChatActionBar';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@papercusp/sync';
import { LocalCardHost } from './LocalCardHost';
import { _resetAskUserLocalForTests } from '@/lib/chat-cards/ask-user-local';
import { _resetChatActionsForTests, registerChatAction } from '@/lib/chat-actions/registry';
import type { ChatActionContext } from '@/lib/chat-actions/types';

const ctx: ChatActionContext = { sessionOwnerId: 'su-1', ownerLabel: 'su-1' };

// Reset BEFORE each test too, not only after. ChatActionBar now imports the
// chat-actions BARREL (WI-6450 — importing the registry directly is what left
// the bar empty in the real app), so the concrete posture/grade/session actions
// are registered as a side effect of importing the component under test. Every
// case here builds its own registry from scratch, so the first test would
// otherwise inherit those real actions and see a populated bar.
beforeEach(() => {
  _resetChatActionsForTests();
});

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

  // WI-6552: the guard for the hang observed LIVE on 2026-07-27 — Grade's
  // params() fetches rubrics.list through the sync in-flight gate, which
  // queued behind the HUD's other queries and never resolved OR rejected,
  // leaving the button aria-busy + disabled with no card and no error.
  // Tested on `withTimeout` directly rather than by driving the bar: faking
  // timers deadlocks testing-library's findBy* (which needs real ones), and
  // the real 12s ceiling is far too long to wait out in a unit test.
  describe('WI-6552 withTimeout — a never-settling params() must not hang the bar', () => {
    it('rejects with the given message when the promise never settles', async () => {
      await expect(
        withTimeout(new Promise(() => {}), 10, 'Grade could not load its options in time — try again.'),
      ).rejects.toThrow(/could not load its options/i);
    });

    it('passes a value through untouched when it settles in time', async () => {
      await expect(withTimeout(Promise.resolve('ok'), 5_000, 'nope')).resolves.toBe('ok');
    });

    it('propagates the original rejection rather than masking it as a timeout', async () => {
      await expect(
        withTimeout(Promise.reject(new Error('real failure')), 5_000, 'timeout msg'),
      ).rejects.toThrow('real failure');
    });
  });

  it('WI-6552: a successful action reports success, so it is never silent', async () => {
    registerChatAction({
      id: 'quiet',
      label: 'Quiet',
      available: () => true,
      run: vi.fn(async () => {}),
    });
    render(<ChatActionBar ctx={ctx} />);
    fireEvent.click(screen.getByTestId('chat-action-quiet'));
    // [owner 2026-07-27] "I also selected one of the rubrics and nothing
    // happaned." Success used to render nothing at all, so a working action
    // and a dead click looked identical.
    const done = await screen.findByTestId('chat-action-bar-done');
    expect(done.textContent).toMatch(/Quiet/);
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

  // P-009 / D-003. This ordering is LOAD-BEARING and was previously expressed
  // only as prose in another package's comment, where nothing could enforce it.
  //
  // The sync layer rejects a request that cannot get a gate slot at
  // DEFAULT_REQUEST_TIMEOUT_MS with a specific, actionable message ('sync query
  // "<name>" timed out after 20000ms waiting for a request slot'). If the bar's
  // own ceiling fired first it would replace that message with a generic
  // timeout, which is exactly the opacity WI-6559 was filed for — the failure
  // would still be visible, but no longer diagnosable.
  describe('P-009 the params ceiling stays above the sync layer ceiling', () => {
    it('is derived from the sync layer ceiling, not a hardcoded number', () => {
      expect(PARAMS_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    });

    it('leaves headroom for the layer rejection to propagate and render', () => {
      // Enough slack that a rejection at the layer ceiling reliably surfaces
      // first, without reverting to the old arbitrary 30s (which was justified
      // by a measurement OF WI-6559 — a bug now fixed, so the number outlived
      // its own rationale).
      expect(PARAMS_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
      expect(PARAMS_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    });
  });
});
