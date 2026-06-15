// @vitest-environment jsdom
//
// RunDetailPanel — the per-run transcript + continue panel (P-023). The genuine
// logic: mount/unmount gated on the `run` nuqs key, the stale badge (run's
// planContentHash vs the plan's current hash), the empty/loading/turns
// surfaces, and the resume (Continue) flow. plans-api's fetch/launch/resume are
// mocked; AgentsPanel.launchErrorLabel is the real pure helper (imported).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { PlanRunTranscriptResult } from './plans-api';

const { api } = vi.hoisted(() => ({
  api: {
    fetchPlanRunTranscript: vi.fn(),
    launchPlanRunConsole: vi.fn(),
    resumePlanAgent: vi.fn(),
  },
}));

vi.mock('./plans-api', () => ({
  fetchPlanRunTranscript: api.fetchPlanRunTranscript,
  launchPlanRunConsole: api.launchPlanRunConsole,
  resumePlanAgent: api.resumePlanAgent,
}));

import RunDetailPanel from './RunDetailPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function transcript(over: Partial<PlanRunTranscriptResult> = {}): PlanRunTranscriptResult {
  return {
    runId: 7,
    planSlug: 'p',
    sessionId: 'sess-1',
    status: 'idle',
    planContentHash: 'hashA',
    turns: [],
    nextCursor: null,
    query: null,
    ...over,
  };
}

function renderPanel(
  props: Partial<Parameters<typeof RunDetailPanel>[0]> = {},
  searchParams = '?run=7',
) {
  return render(
    <RunDetailPanel planSlug="p" planTitle="My Plan" currentContentHash="hashA" {...props} />,
    { wrapper: withNuqsTestingAdapter({ searchParams }) },
  );
}

describe('<RunDetailPanel /> mount gate', () => {
  it('renders nothing when the `run` key is unset', () => {
    const { container } = renderPanel({}, '?');
    expect(container.firstChild).toBeNull();
    expect(api.fetchPlanRunTranscript).not.toHaveBeenCalled();
  });
});

describe('<RunDetailPanel /> transcript', () => {
  it('renders the plan title, run id, and status pill once the transcript loads', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript({ status: 'idle' }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    expect(screen.getByText('My Plan')).toBeTruthy();
    expect(screen.getByText('idle')).toBeTruthy();
  });

  it('shows the empty-state when there are no turns', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript({ turns: [] }));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/no turns recorded yet/i)).toBeTruthy());
  });

  it('renders a row per turn with its role and content', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(
      transcript({
        turns: [
          { seq: 1, role: 'user', content: 'do it', createdAt: Date.now() },
          { seq: 2, role: 'assistant', content: 'done', createdAt: Date.now() },
        ],
      }),
    );
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll('.pc-rev-convo-turn')).toHaveLength(2));
    expect(screen.getByText('do it')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('shows the stale badge when the run hash differs from the plan hash', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript({ planContentHash: 'hashOLD' }));
    renderPanel({ currentContentHash: 'hashNEW' });
    await waitFor(() => expect(screen.getByText(/⚠ stale/)).toBeTruthy());
  });

  it('does NOT show the stale badge when the hashes match', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript({ planContentHash: 'same' }));
    renderPanel({ currentContentHash: 'same' });
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    expect(screen.queryByText(/stale/)).toBeNull();
  });

  it('surfaces a fetch error in the error slot', async () => {
    api.fetchPlanRunTranscript.mockRejectedValue(new Error('transcript boom'));
    renderPanel();
    await waitFor(() => expect(screen.getByText('transcript boom')).toBeTruthy());
  });
});

describe('<RunDetailPanel /> continue', () => {
  it('disables Continue until the message is non-empty', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript());
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    const btn = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/send a follow-up/i), { target: { value: 'more' } });
    expect(btn.disabled).toBe(false);
  });

  it('calls resumePlanAgent and reloads on a successful continue', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript());
    api.resumePlanAgent.mockResolvedValue({ ok: true });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/send a follow-up/i), { target: { value: 'keep going' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.resumePlanAgent).toHaveBeenCalledWith({ runId: 7, message: 'keep going' }));
  });

  it('shows the launchErrorLabel-formatted busy error when resume reports a conflict', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript());
    api.resumePlanAgent.mockResolvedValue({ error: 'busy', busy: [{ owner_label: 'Queen', intent: 'planning' }] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/send a follow-up/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText(/Plan busy — Queen \(planning\)/)).toBeTruthy());
  });

  it('surfaces a thrown resume error in the send-error slot', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript());
    api.resumePlanAgent.mockRejectedValue(new Error('resume down'));
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/send a follow-up/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText('resume down')).toBeTruthy());
  });
});

describe('<RunDetailPanel /> console + navigation', () => {
  it('Open agent console launches with the sessionId, plan slug, and plan title as label', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript({ sessionId: 'sess-9' }));
    api.launchPlanRunConsole.mockResolvedValue({ ok: true });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /open agent console/i }));
    await waitFor(() =>
      expect(api.launchPlanRunConsole).toHaveBeenCalledWith({ sessionId: 'sess-9', planSlug: 'p', label: 'My Plan' }),
    );
  });

  it('surfaces a console launch failure in the error slot', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript());
    api.launchPlanRunConsole.mockRejectedValue(new Error('no terminal'));
    renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /open agent console/i }));
    await waitFor(() => expect(screen.getByText('no terminal')).toBeTruthy());
  });

  it('the ← Runs back button clears the run key and unmounts the panel', async () => {
    api.fetchPlanRunTranscript.mockResolvedValue(transcript());
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText('Run #7')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /back to runs list/i }));
    // run=null → the mount gate returns null
    await waitFor(() => expect(container.querySelector('.pc-run-detail')).toBeNull());
  });

  it('Load more appends the next page and consumes the cursor', async () => {
    api.fetchPlanRunTranscript
      .mockResolvedValueOnce(
        transcript({ turns: [{ seq: 1, role: 'user', content: 'first', createdAt: Date.now() }], nextCursor: 1 }),
      )
      .mockResolvedValueOnce(
        transcript({ turns: [{ seq: 2, role: 'assistant', content: 'second', createdAt: Date.now() }], nextCursor: null }),
      );
    renderPanel();
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    // both turns are now present; the cursor was exhausted (no more button)
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    // the 2nd fetch carried the cursor
    expect(api.fetchPlanRunTranscript).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 1, runId: 7 }));
  });
});
