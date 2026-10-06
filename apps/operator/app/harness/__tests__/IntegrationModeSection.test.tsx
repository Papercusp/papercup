/**
 * @vitest-environment jsdom
 *
 * IntegrationModeSection — P-017 (pot-review-integration-mode-2026-10-05, D-007):
 * the pot-settings form of "Where should the agents' work go?" with guided
 * switching. Same conventions as EntryGithubUrlForm.test.tsx (no jest-dom matchers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { integrationModeQuestion } from '@papercusp/operator-core/lib/harness/git-sync/integration-mode-question';
import IntegrationModeSection, { switchExplanation } from '../IntegrationModeSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockFetch = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function getBody(opts: { current?: 'direct' | 'review' | null; hasTestSuite?: boolean; workingCopyUrl?: string | null } = {}) {
  return {
    question: integrationModeQuestion({ repoLabel: 'acme/widgets', hasTestSuite: opts.hasTestSuite }),
    current: opts.current ?? null,
    workingCopyUrl: opts.workingCopyUrl ?? null,
  };
}

function putCalls() {
  return mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IntegrationModeSection', () => {
  it('asks the owner-approved question with the repo name and marks the current answer', async () => {
    mockFetch.mockResolvedValueOnce(json(getBody({ current: null })));
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/harness/widgets/integration-mode');
    expect(screen.getByRole('heading').textContent).toBe("Where should the agents' work go?");
    const direct = screen.getByTestId('integration-mode-option-direct');
    const review = screen.getByTestId('integration-mode-option-review');
    expect(direct.textContent).toContain('Straight into acme/widgets');
    expect(direct.textContent).toContain('(current)');
    expect(review.textContent).toContain('Into a working copy of acme/widgets');
    expect((direct.querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  it('choosing the other answer shows a confirm step and sends nothing until Switch', async () => {
    mockFetch.mockResolvedValueOnce(json(getBody({ current: 'direct' })));
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    await userEvent.click(screen.getByTestId('integration-mode-option-review').querySelector('input')!);
    const panel = screen.getByTestId('integration-mode-confirm-panel');
    expect(panel.textContent).toContain('acme/widgets receives their combined work only through a PR');
    expect(putCalls()).toHaveLength(0);

    await userEvent.click(screen.getByTestId('integration-mode-cancel'));
    expect(screen.queryByTestId('integration-mode-confirm-panel')).toBeNull();
    expect((screen.getByTestId('integration-mode-option-direct').querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });

  it('Switch PUTs the new answer and shows the working copy it created', async () => {
    mockFetch
      .mockResolvedValueOnce(json(getBody({ current: 'direct' })))
      .mockResolvedValueOnce(json({ ok: true, mode: 'review', fork: { url: 'https://github.com/bot/widgets', created: true } }));
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    await userEvent.click(screen.getByTestId('integration-mode-option-review').querySelector('input')!);
    await userEvent.click(screen.getByTestId('integration-mode-confirm'));

    await waitFor(() => expect(screen.queryByTestId('integration-mode-confirm-panel')).toBeNull());
    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0]![0]).toBe('/api/harness/widgets/integration-mode');
    expect(JSON.parse((puts[0]![1] as RequestInit).body as string)).toEqual({ mode: 'review' });
    expect(screen.getByTestId('integration-mode-option-review').textContent).toContain('(current)');
    expect(screen.getByTestId('integration-mode-working-copy').textContent).toContain('https://github.com/bot/widgets');
  });

  it('a refused switch shows the server message and keeps the current answer', async () => {
    mockFetch
      .mockResolvedValueOnce(json(getBody({ current: 'direct' })))
      .mockResolvedValueOnce(
        json({ ok: false, error: 'upstream_remote_required', message: 'This pot has no GitHub repository to copy.' }, 409),
      );
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    await userEvent.click(screen.getByTestId('integration-mode-option-review').querySelector('input')!);
    await userEvent.click(screen.getByTestId('integration-mode-confirm'));

    const err = await screen.findByTestId('integration-mode-error');
    expect(err.textContent).toBe('This pot has no GitHub repository to copy.');
    expect(screen.getByTestId('integration-mode-option-direct').textContent).toContain('(current)');
  });

  it('without a test suite the working copy is disabled and says why', async () => {
    mockFetch.mockResolvedValueOnce(json(getBody({ current: 'direct', hasTestSuite: false })));
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    const review = screen.getByTestId('integration-mode-option-review');
    expect((review.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(review.textContent).toContain('This repository has no test suite');
  });

  it.each([404, 409])('renders nothing for a project that is not a pot (HTTP %i)', async (status) => {
    mockFetch.mockResolvedValueOnce(json({ error: 'not_a_pot' }, status));
    const { container } = render(<IntegrationModeSection slug="plain" />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});

describe('switchExplanation', () => {
  it('explains the working copy, naming it when it exists', () => {
    expect(switchExplanation('review', 'acme/widgets', 'https://github.com/bot/widgets')).toContain(
      'the working copy (https://github.com/bot/widgets)',
    );
    expect(switchExplanation('review', 'acme/widgets', null)).toContain('created for this pot');
  });

  it('switching back says the working copy is kept', () => {
    const text = switchExplanation('direct', 'acme/widgets', 'https://github.com/bot/widgets');
    expect(text).toContain('straight into acme/widgets');
    expect(text).toContain('nothing is deleted');
  });
});
