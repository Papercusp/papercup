import { describe, it, vi } from 'vitest';
import { premiseProbes } from './premise-probes';

const getWorkItem = vi.fn();
vi.mock('./messages', () => ({ getMessageById: vi.fn() }));
vi.mock('../../work-items', () => ({ getWorkItem: (...a: unknown[]) => getWorkItem(...a) }));
vi.mock('../../work-item-dispatch-states', () => ({
  ISSUE_TERMINAL_STATES: ['resolved', 'closed', 'deprecated', 'done'],
}));

describe('debug', () => {
  it('sequential calls', async () => {
    getWorkItem.mockResolvedValue({ state: 'open' });
    const p = premiseProbes();
    console.log('SEQ1:', JSON.stringify(await p.workItem!('WI-6560')));
    console.log('SEQ2:', JSON.stringify(await p.workItem!('WI-6560')));
    console.log('SEQ3:', JSON.stringify(await p.workItem!('WI-6560')));
    console.log('SEQ mock calls:', getWorkItem.mock.calls.length);
  });

  it('concurrent calls', async () => {
    getWorkItem.mockResolvedValue({ state: 'open' });
    const p = premiseProbes();
    const r = await Promise.all([p.workItem!('WI-6560'), p.workItem!('WI-6560')]);
    console.log('CONC:', JSON.stringify(r));
    console.log('CONC mock calls:', getWorkItem.mock.calls.length);
  });
});
