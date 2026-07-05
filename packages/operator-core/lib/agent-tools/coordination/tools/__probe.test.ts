import { describe, it, vi } from 'vitest';
import { composeOrient } from './orient';

const foldFactsMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../../agent-facts/store', () => ({ foldFacts: foldFactsMock }));

function fakeCall(handlers: Record<string, (a: any) => any>) {
  const calls: { name: string; args: any }[] = [];
  const call = async (name: string, args: any) => { calls.push({ name, args }); const h = handlers[name]; if (!h) throw new Error(`unexpected: ${name}`); return h(args); };
  return { call, calls };
}
const CORE = {
  'fleet:assignments': () => ({ ok: true, summary: { agents: 1 }, agents: [{ ownerId: 'me' }] }),
  'work_items:list': () => [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'todo' }],
  'coord:inbox': () => ({ summary: { total: 3 }, entries: [{ msg_id: 'm1' }] }),
  'coord:whoami': () => ({ fleetSlug: null }),
};
describe('probe', () => {
  it('measures', async () => {
    const bigText = 'x'.repeat(5000);
    const manyEvents = Array.from({ length: 100 }, (_, i) => ({ i }));
    const { call } = fakeCall({
      ...CORE,
      'coord:plan-events': () => ({ events: manyEvents, total: 100, truncated: true }),
      'memory:search': () => ({ ok: true, results: [{ id: 'm', memory: bigText, score: 0.5 }] }),
      'coord:declare-intent': () => ({ ok: true }),
    });
    const r = await composeOrient({ intent: 'big' }, call as any, 'me');
    console.log('SERIALIZED_LENGTH=', JSON.stringify(r).length);
    console.log('PAYLOAD=', JSON.stringify(r));
  });
});
