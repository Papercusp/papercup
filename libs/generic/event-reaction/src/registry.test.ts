import { describe, it, expect } from 'vitest';
import { ReactionRegistry } from './registry';

// A synthetic event — proves the registry is generic (no host/papercusp coupling).
interface TestEvent {
  kind: string;
  payload?: { item?: string };
}

function reg() {
  return new ReactionRegistry<TestEvent>({ keyOf: (e) => e.kind });
}

describe('ReactionRegistry', () => {
  it('indexes rules by trigger key and matches', () => {
    const r = reg();
    r.add({ id: 'a', on: 'thing:done', fire: 'other:tool' });
    r.add({ id: 'b', on: 'other:thing', fire: 'x:y' });
    expect(r.rulesFor('thing:done').map((x) => x.id)).toEqual(['a']);
    const actions = r.match({ kind: 'thing:done' });
    expect(actions.map((x) => x.fire)).toEqual(['other:tool']);
  });

  it('re-adding the same id replaces, remove deletes', () => {
    const r = reg();
    r.add({ id: 'a', on: 'k', fire: 'v1' });
    r.add({ id: 'a', on: 'k', fire: 'v2' });
    expect(r.rulesFor('k')).toHaveLength(1);
    expect(r.match({ kind: 'k' })[0].fire).toBe('v2');
    expect(r.remove('a')).toBe(true);
    expect(r.remove('a')).toBe(false);
    expect(r.rules()).toHaveLength(0);
  });

  it('evaluates a declarative `when` and an arg template', () => {
    const r = reg();
    r.add({ id: 'a', on: 'k', when: { 'payload.item': { exists: true } }, fire: 'v', args: (e) => ({ echoed: e.payload?.item }) });
    r.add({ id: 'b', on: 'k', when: { 'payload.item': 'NOPE' }, fire: 'v' });
    const actions = r.match({ kind: 'k', payload: { item: 'WI-1' } });
    expect(actions).toHaveLength(1);
    expect(actions[0].args).toEqual({ echoed: 'WI-1' });
  });

  it('describe() returns on→fire edges; clear() empties', () => {
    const r = reg();
    r.add({ id: 'a', on: 'k1', fire: 'f1' });
    r.add({ id: 'b', on: 'k2', fire: 'f2' });
    expect(r.describe()).toEqual(
      expect.arrayContaining([
        { on: 'k1', ruleId: 'a', fire: 'f1' },
        { on: 'k2', ruleId: 'b', fire: 'f2' },
      ]),
    );
    r.clear();
    expect(r.rules()).toHaveLength(0);
  });
});
