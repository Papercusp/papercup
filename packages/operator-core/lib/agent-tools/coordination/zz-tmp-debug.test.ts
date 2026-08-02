import { describe, it, vi } from 'vitest';
import { premiseProbes } from './premise-probes';
import { resolvePremiseStamps } from './premise-resolve';

const getWorkItem = vi.fn();
vi.mock('./messages', () => ({ getMessageById: vi.fn() }));
vi.mock('../../work-items', () => ({ getWorkItem: (...a: unknown[]) => getWorkItem(...a) }));
vi.mock('../../work-item-dispatch-states', () => ({
  ISSUE_TERMINAL_STATES: ['resolved', 'closed', 'deprecated', 'done'],
}));

describe('debug', () => {
  it('shows what the probe actually returns', async () => {
    getWorkItem.mockResolvedValue({ state: 'open' });
    const probes = premiseProbes();
    console.log('PROBE RESULT:', JSON.stringify(await probes.workItem!('WI-6560')));
    console.log('getWorkItem calls:', JSON.stringify(getWorkItem.mock.calls));
    const stamps = await resolvePremiseStamps(['WI-6560', 'WI-6560#completion'], probes);
    console.log('STAMPS:', JSON.stringify(stamps));
  });
});
