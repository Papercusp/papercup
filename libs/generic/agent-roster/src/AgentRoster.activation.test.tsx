// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRoster } from './AgentRoster';
import type { RosterAgent } from './types';

const agent: RosterAgent = {
  ownerId: 'su-portal-agent',
  label: 'su · portal',
  agent: 'codex',
  role: 'worker',
  intent: 'checking the portal',
  feature: null,
  currentPlanSlug: null,
  liveness: 'live',
  sessionState: 'live',
  heartbeatAt: '2026-08-31T19:00:00.000Z',
  lastActiveAt: '2026-08-31T19:00:00.000Z',
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AgentRoster host-owned row activation', () => {
  it('activates a row even when the host has no transcript handle', () => {
    const onRowActivate = vi.fn();
    render(<AgentRoster agents={[agent]} nowMs={Date.parse('2026-08-31T19:01:00.000Z')} onRowActivate={onRowActivate} />);

    fireEvent.click(screen.getByTestId('agent-row-su-portal-agent'));

    expect(onRowActivate).toHaveBeenCalledTimes(1);
    expect(onRowActivate).toHaveBeenCalledWith(agent);
  });

  it('uses the same host action for keyboard activation', () => {
    const onRowActivate = vi.fn();
    render(<AgentRoster agents={[agent]} nowMs={Date.parse('2026-08-31T19:01:00.000Z')} onRowActivate={onRowActivate} />);
    const row = screen.getByTestId('agent-row-su-portal-agent');

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onRowActivate).toHaveBeenCalledTimes(2);
  });
});
