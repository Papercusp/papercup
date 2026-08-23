// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => queryName === 'advRoster.list'
    ? { data: [{ active: [
        { ownerId: 'su-live', label: 'Builder', intent: 'Implementing Automations', sessionState: 'live' },
        { ownerId: 'su-parked', label: 'Parked', intent: 'Waiting', sessionState: 'parked' },
      ] }], loading: false }
    : { data: [{ overall: 'warn', evaluatedAt: Date.now(), panels: {
        deploy: { key: 'deploy', label: 'Git-sync / deploy', status: 'warn', summary: 'One gate needs attention', metrics: [], data: null },
        memory: { key: 'memory', label: 'Memory', status: 'ok', summary: 'Healthy', metrics: [], data: null },
      } }], loading: false },
}));
vi.mock('./AskAgentPane', () => ({ default: () => <div data-testid="ask-agent" /> }));
vi.mock('./PotFederationStatus', () => ({ default: () => <div data-testid="federation" /> }));
vi.mock('./PotPeerRoster', () => ({ default: () => <div data-testid="peer-roster" /> }));

import WorkspacePulseTab from './WorkspacePulseTab';

afterEach(cleanup);

describe('<WorkspacePulseTab>', () => {
  it('shows only live agents, health attention, preserved operational surfaces, and Automations navigation', async () => {
    const onUrlUpdate = vi.fn();
    render(<NuqsTestingAdapter onUrlUpdate={onUrlUpdate}><WorkspacePulseTab active /></NuqsTestingAdapter>);
    expect(screen.getByText('1 running')).toBeTruthy();
    expect(screen.getByText('1 warning')).toBeTruthy();
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.queryByText('Parked')).toBeNull();
    expect(screen.getByText('Git-sync / deploy')).toBeTruthy();
    expect(screen.getByTestId('ask-agent')).toBeTruthy();
    expect(screen.getByTestId('federation')).toBeTruthy();
    expect(screen.getByTestId('peer-roster')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Automations/ }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const last = onUrlUpdate.mock.calls.at(-1)?.[0]?.queryString ?? '';
    expect(last).toContain('tab=automations');
  });
});
