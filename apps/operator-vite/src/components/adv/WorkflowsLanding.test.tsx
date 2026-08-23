// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import WorkflowsLanding from './WorkflowsLanding';
import type { LandingSourceInput, LandingWorkflowInput, NeedsYouItem } from './workflows-landing-model';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

function source(overrides: Partial<LandingSourceInput> = {}): LandingSourceInput {
  return {
    id: 'src-gmail',
    kind: 'google-gmail',
    status: 'connected',
    lastError: null,
    failedDeliveries24h: 0,
    bindingCount: 2,
    ...overrides,
  };
}

function workflow(overrides: Partial<LandingWorkflowInput> = {}): LandingWorkflowInput {
  return {
    id: 'wf-1',
    label: 'Meeting prep brief',
    running: false,
    paused: false,
    needsAttention: false,
    lastAt: NOW - 12 * 60_000,
    spendLabel: '$1.64',
    chainKinds: ['calendar', 'plan'],
    ...overrides,
  };
}

function renderLanding(
  props: Partial<React.ComponentProps<typeof WorkflowsLanding>> = {},
  search = '',
) {
  const merged: React.ComponentProps<typeof WorkflowsLanding> = {
    workflows: [workflow()],
    sources: [source()],
    nowMs: NOW,
    onOpenWorkflow: vi.fn(),
    onNeedsYouAction: vi.fn(),
    onInstallFromCupboard: vi.fn(),
    onComposeWorkflow: vi.fn(),
    ...props,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NuqsTestingAdapter searchParams={search}>{children}</NuqsTestingAdapter>
  );
  return { ...render(<WorkflowsLanding {...merged} />, { wrapper }), props: merged };
}

afterEach(() => cleanup());

describe('WorkflowsLanding — the needs-you strip (D-018)', () => {
  it('renders NOTHING at all when nothing needs the operator', () => {
    // Not an "all good" card, not an empty frame — nothing. An always-present interrupt
    // region is what D-018 rejects, because an operator who sees it daily stops reading it.
    renderLanding();
    expect(screen.queryByTestId('workflows-needs-you')).toBeNull();
    expect(screen.queryByText(/Needs you/)).toBeNull();
  });

  it('appears when a bound source is disconnected, with its action', () => {
    // Held as a typed local rather than read back off props: the prop is declared as a plain
    // function, so `props.onNeedsYouAction.mock` does not typecheck.
    const onNeedsYouAction = vi.fn<(item: NeedsYouItem) => void>();
    renderLanding({
      sources: [source({ status: 'disconnected', bindingCount: 3 })],
      onNeedsYouAction,
    });
    const strip = screen.getByTestId('workflows-needs-you');
    expect(within(strip).getByText(/Gmail is disconnected/)).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: 'Reconnect' }));
    expect(onNeedsYouAction).toHaveBeenCalledTimes(1);
    expect(onNeedsYouAction.mock.calls[0][0]).toMatchObject({ kind: 'reconnect' });
  });

  it('appears for dead-letter deliveries with a Review runs action', () => {
    renderLanding({ sources: [source({ failedDeliveries24h: 2 })] });
    const strip = screen.getByTestId('workflows-needs-you');
    expect(within(strip).getByText(/2 failed deliveries/)).toBeTruthy();
    expect(within(strip).getByRole('button', { name: 'Review runs' })).toBeTruthy();
  });
});

describe('WorkflowsLanding — composer hero', () => {
  it('offers only chips derived from connected sources', () => {
    renderLanding({
      sources: [source({ kind: 'google-gmail' }), source({ id: 's2', kind: 'slack', status: 'disconnected' })],
    });
    const chips = screen.getByTestId('workflows-chips');
    expect(within(chips).getByText('When an email from a client arrives…')).toBeTruthy();
    // No Slack connected ⇒ no Slack suggestion; the chip would invite an unbuildable workflow.
    expect(within(chips).queryByText(/Slack/)).toBeNull();
  });

  it('renders no chip rail at all when no source is connected', () => {
    renderLanding({ sources: [source({ status: 'disconnected' })] });
    expect(screen.queryByTestId('workflows-chips')).toBeNull();
  });

  it('seeds the composer from a chip', () => {
    renderLanding();
    fireEvent.click(screen.getByText('When an email from a client arrives…'));
    expect((screen.getByLabelText(/What should happen automatically/) as HTMLInputElement).value).toBe(
      'When an email from a client arrives…',
    );
  });

  it('hands a typed prompt to the agent and clears the field', () => {
    const { props } = renderLanding();
    const input = screen.getByLabelText(/What should happen automatically/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Before my next meeting, brief me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wire it' }));
    expect(props.onComposeWorkflow).toHaveBeenCalledWith('Before my next meeting, brief me');
    expect(input.value).toBe('');
  });

  it('refuses to submit an empty or whitespace prompt', () => {
    const { props } = renderLanding();
    const submit = screen.getByRole('button', { name: 'Wire it' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    const input = screen.getByLabelText(/What should happen automatically/);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(props.onComposeWorkflow).not.toHaveBeenCalled();
  });
});

describe('WorkflowsLanding — active now', () => {
  it('lists a recently-fired workflow and opens it on click', () => {
    const { props } = renderLanding();
    fireEvent.click(screen.getByRole('button', { name: /Meeting prep brief/ }));
    expect(props.onOpenWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('says fires were not counted rather than showing 0', () => {
    // "0 fires today" is a measurement; "not counted" is the truth when none was taken.
    renderLanding({ firesToday: null });
    expect(screen.getByText(/fires not counted/)).toBeTruthy();
    cleanup();
    renderLanding({ firesToday: 0 });
    expect(screen.getByText(/0 fires today/)).toBeTruthy();
  });

  it('explains an empty active list instead of showing a blank region', () => {
    renderLanding({ workflows: [workflow({ lastAt: null, running: false })] });
    expect(screen.getByText(/Nothing has fired recently/)).toBeTruthy();
  });

  it('surfaces a needs-attention workflow on its card', () => {
    renderLanding({ workflows: [workflow({ needsAttention: true })] });
    expect(screen.getByText(/review with the agent/)).toBeTruthy();
  });
});

describe('WorkflowsLanding — all-workflows ledger', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    workflow({ id: `wf-${i}`, label: `Workflow ${i}`, lastAt: NOW - (i + 1) * 60_000 }),
  );

  it('previews a bounded slice and says how many more there are', () => {
    renderLanding({ workflows: many });
    expect(screen.getByText('All workflows · 8')).toBeTruthy();
    expect(screen.getByText('3 more in the full ledger')).toBeTruthy();
  });

  it('expands via the URL so the state is agent-visible', async () => {
    const onUrlChange = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NuqsTestingAdapter searchParams="" onUrlUpdate={onUrlChange}>
        {children}
      </NuqsTestingAdapter>
    );
    render(
      <WorkflowsLanding
        workflows={many}
        sources={[source()]}
        nowMs={NOW}
        onOpenWorkflow={vi.fn()}
        onNeedsYouAction={vi.fn()}
        onInstallFromCupboard={vi.fn()}
        onComposeWorkflow={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /Open full ledger/ }));
    // nuqs batches its URL writes, so the update lands after the click returns.
    await waitFor(() => expect(onUrlChange).toHaveBeenCalled());
    const url = onUrlChange.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
    expect(url.searchParams.get('wfLedger')).toBe('open');
  });

  it('shows every row when the URL says the ledger is open', () => {
    renderLanding({ workflows: many }, '?wfLedger=open');
    expect(screen.queryByText('3 more in the full ledger')).toBeNull();
    expect(screen.getByRole('button', { name: /Show fewer/ })).toBeTruthy();
  });

  it('renders an em dash for a workflow that has never fired', () => {
    renderLanding({ workflows: [workflow({ lastAt: null })] });
    const table = screen.getByRole('table');
    expect(within(table).getByText('—')).toBeTruthy();
  });

  it('reports an empty install honestly', () => {
    renderLanding({ workflows: [] });
    expect(screen.getByText('No workflows installed yet.')).toBeTruthy();
    expect(screen.getByText('All workflows · 0')).toBeTruthy();
  });
});

describe('WorkflowsLanding — masthead', () => {
  it('wires Install from Cupboard', () => {
    const { props } = renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Install from Cupboard' }));
    expect(props.onInstallFromCupboard).toHaveBeenCalledTimes(1);
  });

  it('titles the surface Workflows, not Automations', () => {
    renderLanding();
    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeTruthy();
  });
});
