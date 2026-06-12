/**
 * @vitest-environment jsdom
 *
 * AgentDetail — the `agent:*` Detail-pane view (Agents panel row click). The
 * load-bearing contracts: agent identity + presence render, and the work
 * cross-links (head-of-line item, queue, claims) drive the same `?sel`
 * routing the F-*/WI-* details use — but ONLY for work-item-shaped ids;
 * plan-item/lock claims must render inert, not navigate to a dead selection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AgentDetail } from './DetailPanel';
import type { WorkingAgent } from './AdvAgentsPanel';

afterEach(() => cleanup());

function makeAgent(partial: Partial<WorkingAgent> = {}): WorkingAgent {
  return {
    agentId: 'su-ab123',
    label: 'su · ab123',
    name: 'Claude (psu)',
    present: true,
    alive: true,
    heartbeatAt: new Date(Date.now() - 30_000).toISOString(),
    intent: 'Greening the Tests tab',
    claims: [],
    orphaned: false,
    declaredUnclaimed: false,
    doing: { id: 'WI-42', title: 'Fix the flaky gate', rank: 1 },
    queued: [],
    load: 2,
    agentPaneKind: 'su',
    driveMode: 'interactive',
    ...partial,
  };
}

describe('AgentDetail', () => {
  it('renders the agent identity, kind chip, intent, and liveness', () => {
    render(<AgentDetail agent={makeAgent()} onSelect={() => {}} />);
    expect(screen.getByText('Claude (psu)')).toBeTruthy();
    expect(screen.getByText('su-ab123')).toBeTruthy();
    expect(screen.getByText('Greening the Tests tab')).toBeTruthy();
    // The kind chip renders the canonical SU label (header + field row).
    expect(screen.getAllByText('SU').length).toBeGreaterThan(0);
    // 30s-old heartbeat → live.
    expect(screen.getByText('live')).toBeTruthy();
  });

  it('clicking the head-of-line work item drives onSelect with its id', () => {
    const onSelect = vi.fn();
    render(<AgentDetail agent={makeAgent()} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('agent-detail-doing'));
    expect(onSelect).toHaveBeenCalledWith('WI-42');
  });

  it('a non-work-item doing id renders disabled and does NOT navigate', () => {
    const onSelect = vi.fn();
    render(
      <AgentDetail
        agent={makeAgent({ doing: { id: 'P-007', title: 'plan item lane', rank: null } })}
        onSelect={onSelect}
      />,
    );
    const btn = screen.getByTestId('agent-detail-doing') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('queued work-item chips cross-link via onSelect', () => {
    const onSelect = vi.fn();
    render(
      <AgentDetail
        agent={makeAgent({ queued: [{ id: 'WI-77' }, { id: 'F-012' }] })}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('WI-77'));
    fireEvent.click(screen.getByText('F-012'));
    expect(onSelect).toHaveBeenNthCalledWith(1, 'WI-77');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'F-012');
  });

  it('shows the empty state when the agent has nothing claimed', () => {
    render(<AgentDetail agent={makeAgent({ doing: null, load: 0 })} onSelect={() => {}} />);
    expect(screen.getByText('Nothing claimed right now.')).toBeTruthy();
  });

  it('surfaces orphaned-claims and declared-unclaimed warning chips', () => {
    render(
      <AgentDetail
        agent={makeAgent({ orphaned: true, declaredUnclaimed: true })}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('orphaned claims')).toBeTruthy();
    expect(screen.getByText('declared, unclaimed')).toBeTruthy();
  });

  it('renders claims with linkable ids as cross-links and others as text', () => {
    const onSelect = vi.fn();
    render(
      <AgentDetail
        agent={makeAgent({
          claims: [
            { id: 'WI-9', type: 'work_item', detail: 'claimed via work_items:claim' },
            { id: null, type: 'lock', detail: 'apps/operator/app/x.tsx' },
          ],
        })}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('WI-9'));
    expect(onSelect).toHaveBeenCalledWith('WI-9');
    // The lock claim renders its type as the id-less fallback, inert.
    expect(screen.getByText('apps/operator/app/x.tsx')).toBeTruthy();
  });
});
