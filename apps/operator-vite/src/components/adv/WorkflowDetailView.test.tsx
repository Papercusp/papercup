// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import WorkflowDetailView from './WorkflowDetailView';
import type { WorkflowBindingInput } from './workflow-graph-model';

const H = vi.hoisted(() => ({
  layout: vi.fn<(graph: unknown) => Promise<unknown>>(),
  chatMounts: [] as Array<{ slug: string; chatId: string; context?: string }>,
}));

// The real ChatPanel opens an EventSource and hits the network; the Conversations tab's own
// tests stub it the same way. What matters here is WHICH chat we mount, not its internals.
vi.mock('@/app/harness/ChatPanel', () => ({
  default: (props: { slug: string; chatId: string; context?: string }) => {
    H.chatMounts.push({ slug: props.slug, chatId: props.chatId, context: props.context });
    return <div data-testid="chat-panel-stub" />;
  },
}));

// elkjs is a ~1MB GWT bundle. Stub the shared seam so these tests exercise OUR rendering,
// not ELK's layout quality — but keep the call observable so the contract with it is still
// asserted below.
vi.mock('@/app/adv/elk-layout', () => ({
  getElk: async () => ({ layout: H.layout }),
  ELK_LAYERED_LR_OPTIONS: { 'elk.algorithm': 'layered' },
}));

function binding(overrides: Partial<WorkflowBindingInput> = {}): WorkflowBindingInput {
  return {
    id: 'bind-1',
    sourceKind: 'google-calendar',
    eventPattern: 'calendar.event.starts-in-30m',
    eventFilter: { 'attendees.0': { exists: true } },
    action: {},
    stormPolicy: { maxRuns: 5, windowSeconds: 300 },
    planSlug: 'meeting-prep-brief',
    planHarnessSlug: 'papercusp',
    armed: false,
    lastRun: null,
    ...overrides,
  };
}

function renderView(props: Partial<React.ComponentProps<typeof WorkflowDetailView>> = {}, search = '') {
  const merged: React.ComponentProps<typeof WorkflowDetailView> = {
    workflowLabel: 'Meeting prep brief',
    planSlug: 'meeting-prep-brief',
    harnessSlug: 'papercusp',
    binding: binding(),
    bindingLoaded: true,
    busy: null,
    onBack: vi.fn(),
    onToggleArm: vi.fn(),
    onTest: vi.fn(),
    ...props,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NuqsTestingAdapter searchParams={search}>{children}</NuqsTestingAdapter>
  );
  return { ...render(<WorkflowDetailView {...merged} />, { wrapper }), props: merged };
}

beforeEach(() => {
  H.chatMounts.length = 0;
  H.layout.mockReset();
  // Deterministic left-to-right positions, one column per node.
  H.layout.mockImplementation(async (graph: unknown) => {
    const g = graph as { children: Array<{ id: string; width: number; height: number }> };
    return {
      children: g.children.map((child, index) => ({ id: child.id, x: index * 260, y: 0 })),
      width: g.children.length * 260,
      height: 120,
    };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: 'chat-1' }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkflowDetailView — read-only topology (D-016)', () => {
  it('renders one node per derived step and no editing affordance', async () => {
    renderView();
    await waitFor(() => expect(screen.getByRole('button', { name: /Only when/ })).toBeTruthy());

    // trigger + filter + plan, per the binding above.
    expect(screen.getByRole('button', { name: /Calendar event/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Only when/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Meeting prep brief/ })).toBeTruthy();

    // D-016: structural editing is agent-mediated. No delete/connect/add control may exist.
    expect(screen.queryByRole('button', { name: /delete|remove|add step|connect/i })).toBeNull();
  });

  it('passes the layered options and one elk child per node', async () => {
    renderView();
    await waitFor(() => expect(H.layout).toHaveBeenCalled());
    const arg = H.layout.mock.calls[0][0] as {
      layoutOptions: Record<string, string>;
      children: Array<{ id: string }>;
      edges: Array<{ sources: string[]; targets: string[] }>;
    };
    expect(arg.layoutOptions['elk.algorithm']).toBe('layered');
    expect(arg.children.map((c) => c.id)).toEqual(['trigger', 'filter', 'plan']);
    expect(arg.edges).toHaveLength(2);
    expect(arg.edges[0]).toMatchObject({ sources: ['trigger'], targets: ['filter'] });
  });

  it("draws source to operation to the actual canonical target", async () => {
    renderView({
      planSlug: null,
      binding: binding({
        planHarnessSlug: null,
        planSlug: null,
        action: {
          type: "blueprint-operation",
          operationHarnessSlug: "papercusp",
          operationId: "triage-message",
        },
      }),
      operationTarget: { kind: "work-item", id: "WI-41", status: "done" },
    });
    await waitFor(() => expect(H.layout).toHaveBeenCalled());
    const arg = H.layout.mock.calls[0][0] as {
      children: Array<{ id: string }>;
      edges: Array<{ sources: string[]; targets: string[] }>;
    };
    expect(arg.children.map((child) => child.id)).toEqual([
      "trigger",
      "filter",
      "operation",
      "outcome",
    ]);
    expect(arg.edges.at(-1)).toMatchObject({
      sources: ["operation"],
      targets: ["outcome"],
    });
    expect(screen.getByRole("button", { name: /WI-41/ })).toBeTruthy();
  });

  it('surfaces a layout failure instead of rendering a blank canvas', async () => {
    // A silently empty graph is indistinguishable from "this workflow does nothing".
    H.layout.mockRejectedValue(new Error('elk exploded'));
    renderView();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/elk exploded/));
  });

  it('says WHY the canvas is empty rather than showing nothing', async () => {
    renderView({ binding: null, bindingLoaded: true });
    await waitFor(() => expect(screen.getByText(/no external trigger binding/i)).toBeTruthy());
  });

  it('distinguishes a pending snapshot from an unwired workflow', async () => {
    renderView({ binding: null, bindingLoaded: false });
    await waitFor(() => expect(screen.getByText(/Loading topology/i)).toBeTruthy());
    expect(screen.queryByText(/no external trigger binding/i)).toBeNull();
  });
});

describe('WorkflowDetailView — selection is URL state', () => {
  it('writes the clicked node to the wfNode search param', async () => {
    const onUrlChange = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NuqsTestingAdapter searchParams="" onUrlUpdate={onUrlChange}>
        {children}
      </NuqsTestingAdapter>
    );
    render(
      <WorkflowDetailView
        workflowLabel="Meeting prep brief"
        planSlug="meeting-prep-brief"
        harnessSlug="papercusp"
        binding={binding()}
        bindingLoaded
        busy={null}
        onBack={vi.fn()}
        onToggleArm={vi.fn()}
        onTest={vi.fn()}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Calendar event/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Calendar event/ }));

    // Selection must be in the URL — ui:get_state/ui:dispatch read the URL, so a selection
    // in useState would be invisible to the very agent this view exists to talk to.
    await waitFor(() => expect(onUrlChange).toHaveBeenCalled());
    const url = onUrlChange.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
    expect(url.searchParams.get('wfNode')).toBe('trigger');
  });

  it('reflects a preselected node from the URL into the agent context strip', async () => {
    renderView({}, '?wfNode=plan');
    await waitFor(() => expect(screen.getByTestId('workflow-agent-context')).toBeTruthy());
    expect(screen.getByTestId('workflow-agent-context').textContent).toMatch(/Meeting prep brief/);
  });

  it('shows no context strip when nothing is selected', async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId('chat-panel-stub')).toBeTruthy());
    expect(screen.queryByTestId('workflow-agent-context')).toBeNull();
  });
});

describe('WorkflowDetailView — direct controls stay with the operator', () => {
  it('offers exactly arm/disarm and test, and wires them', async () => {
    const { props } = renderView({ binding: binding({ armed: false }) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Arm workflow' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Arm workflow' }));
    expect(props.onToggleArm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Test with last event' }));
    expect(props.onTest).toHaveBeenCalledTimes(1);
  });

  it('flips the arm control to Disarm when the binding is armed', async () => {
    renderView({ binding: binding({ armed: true }) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disarm workflow' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Arm workflow' })).toBeNull();
  });

  it('disables arming when the arm state is unknown rather than guessing', async () => {
    renderView({ binding: null });
    await waitFor(() => expect(screen.getByText(/Arm state unknown/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Arm workflow' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Test with last event' }).hasAttribute('disabled')).toBe(true);
  });

  it('disables both controls while one is in flight', async () => {
    renderView({ busy: 'arm' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Working…' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Test with last event' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps the agent/operator division visible in the footer', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText(/Structural edits go through the agent/)).toBeTruthy());
  });

  it('renders the queued last-event trigger run while Activity catches up', async () => {
    renderView({ lastTestRunId: '33333333-3333-4333-8333-333333333333' });
    expect((await screen.findByRole('status')).textContent).toContain(
      'Test run 33333333 queued from the last provider event',
    );
  });
});

describe('WorkflowDetailView — the agent chat is the existing one', () => {
  it('creates a harness-scoped agent chat and mounts the standard ChatPanel', async () => {
    renderView();
    await waitFor(() => expect(H.chatMounts).toHaveLength(1));
    expect(H.chatMounts[0]).toMatchObject({ slug: 'papercusp', chatId: 'chat-1' });
    const context = JSON.parse(H.chatMounts[0].context ?? '{}') as {
      surface?: string;
      workflow?: { label?: string; harness?: string; planSlug?: string };
      binding?: { id?: string; eventPattern?: string; armed?: boolean };
      selectedNode?: unknown;
    };
    expect(context).toMatchObject({
      surface: 'workflows-detail',
      workflow: { label: 'Meeting prep brief', harness: 'papercusp', planSlug: 'meeting-prep-brief' },
      binding: { id: 'bind-1', eventPattern: 'calendar.event.starts-in-30m', armed: false },
      selectedNode: null,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('/api/harness/papercusp/agent-chats');
    expect(JSON.parse((call[1] as RequestInit).body as string).title).toBe('Workflow · Meeting prep brief');
  });

  it('updates the existing chat context when the selected workflow node changes', async () => {
    renderView({}, '?wfNode=plan');
    await waitFor(() => expect(H.chatMounts.length).toBeGreaterThan(0));
    const latest = H.chatMounts.at(-1);
    const context = JSON.parse(latest?.context ?? '{}') as {
      selectedNode?: { id?: string; kind?: string; label?: string };
    };
    expect(context.selectedNode).toMatchObject({
      id: 'plan',
      kind: 'plan',
      label: 'Meeting prep brief',
    });
  });

  it('explains rather than mounting a chat when the workflow has no harness', async () => {
    renderView({ harnessSlug: null });
    await waitFor(() => expect(screen.getByText(/no harness/i)).toBeTruthy());
    expect(H.chatMounts).toHaveLength(0);
  });

  it('surfaces a chat-creation failure instead of a silent empty panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    );
    renderView();
    await waitFor(() => expect(screen.getByText(/Could not start the workflow agent/)).toBeTruthy());
  });
});

describe('WorkflowDetailView — header', () => {
  it('shows the armed badge and wires the back control', async () => {
    const { container, props } = renderView({
      binding: binding({ armed: true }),
      lastFiredLabel: 'last fired 09:30',
    });
    // Scoped to the header badge on purpose: "Armed" legitimately appears twice (here and on
    // the agent panel's arm row), so an unscoped text query is ambiguous rather than wrong.
    await waitFor(() =>
      expect(container.querySelector('.pc-workflow-detail__badge')?.textContent).toBe('Armed'),
    );
    expect(container.querySelector('.pc-workflow-detail__badge')?.getAttribute('data-armed')).toBe('true');
    expect(screen.getByText('last fired 09:30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Workflows/ }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('reports an unwired workflow as Unwired, not as Disarmed', async () => {
    // "Disarmed" would claim a binding exists and is switched off. It does not exist.
    renderView({ binding: null });
    await waitFor(() => expect(screen.getByText('Unwired')).toBeTruthy());
    expect(screen.queryByText('Disarmed')).toBeNull();
  });
});
