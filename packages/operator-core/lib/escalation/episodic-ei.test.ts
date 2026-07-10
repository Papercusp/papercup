/**
 * episodic-ei.test.ts — the shared episodic durable-EI escalator seam (EI-9030a).
 *
 * The two production bindings (replication-stall-ei.ts, own-log-fork-ei.ts) pin
 * the full behavior contract through their own suites; this file pins the
 * config plumbing the factory owns and the bindings don't isolate: the
 * topics = [topic, ...extraTopics] default, recoveryOwner defaulting to
 * createdBy, severity/provenance passthrough, and per-instance in-flight
 * isolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEpisodicEscalator, type EpisodicEiDeps } from './episodic-ei';

type Ep = { key: string; detail: string };
type Rec = { key: string; detail: string };

const title = (x: Ep | Rec) => `[demo] key=${x.key}`;

function fakeDeps(open: Array<{ id?: string; title: string }>): {
  deps: EpisodicEiDeps<'major'>;
  created: Array<Parameters<EpisodicEiDeps<'major'>['create']>[0]>;
  resolved: Array<{ id: string; note: string }>;
} {
  const created: Array<Parameters<EpisodicEiDeps<'major'>['create']>[0]> = [];
  const resolved: Array<{ id: string; note: string }> = [];
  return {
    created,
    resolved,
    deps: {
      listOpenByTopic: async () => open.map((o) => ({ id: o.id ?? 'EI-OPEN', title: o.title })),
      create: async (input) => {
        created.push(input);
        return { id: 'EI-777' };
      },
      resolve: async (id, note) => {
        resolved.push({ id, note });
      },
    },
  };
}

const make = (over: Partial<Parameters<typeof createEpisodicEscalator<Ep, Rec, 'major'>>[0]> = {}) =>
  createEpisodicEscalator<Ep, Rec, 'major'>({
    topic: 'demo-topic',
    stableTitle: title,
    buildBody: (e) => `body for ${e.key}: ${e.detail}`,
    resolveNote: (r) => `recovered — ${r.detail}`,
    severity: 'major',
    createdBy: 'system:demo',
    foundDuring: 'demo-detector',
    ...over,
  });

describe('createEpisodicEscalator config plumbing', () => {
  let reset: (() => void) | null = null;
  afterEach(() => {
    reset?.();
    reset = null;
  });

  it('tags topics = [topic, ...extraTopics] (default federation) and stamps severity/provenance', async () => {
    const esc = make();
    reset = esc._resetForTests;
    const { deps, created } = fakeDeps([]);
    const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
    expect(id).toBe('EI-777');
    expect(created[0]!.topics).toEqual(['demo-topic', 'federation']);
    expect(created[0]!.severity).toBe('major');
    expect(created[0]!.createdBy).toBe('system:demo');
    expect(created[0]!.foundDuring).toBe('demo-detector');
    expect(created[0]!.title).toBe(title({ key: 'k1', detail: 'd' }));
    expect(created[0]!.body).toBe('body for k1: d');
  });

  it('honors an explicit extraTopics override', async () => {
    const esc = make({ extraTopics: ['a', 'b'] });
    reset = esc._resetForTests;
    const { deps, created } = fakeDeps([]);
    await esc.file({ key: 'k1', detail: 'd' }, deps);
    expect(created[0]!.topics).toEqual(['demo-topic', 'a', 'b']);
  });

  it('exposes topic + recoveryOwner; recoveryOwner defaults to createdBy', () => {
    expect(make().recoveryOwner).toBe('system:demo');
    expect(make({ recoveryOwner: 'system:other' }).recoveryOwner).toBe('system:other');
    expect(make().topic).toBe('demo-topic');
  });

  it('dedupes against an open EI with the same title', async () => {
    const esc = make();
    reset = esc._resetForTests;
    const { deps, created } = fakeDeps([{ title: title({ key: 'k1', detail: 'x' }) }]);
    const id = await esc.file({ key: 'k1', detail: 'd' }, deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('the VITEST gate returns null (file) / [] (resolve) without deps', async () => {
    const esc = make();
    reset = esc._resetForTests;
    expect(await esc.file({ key: 'k1', detail: 'd' })).toBeNull();
    expect(await esc.resolve({ key: 'k1', detail: 'd' })).toEqual([]);
  });

  it('resolve closes ALL matching open EIs with the resolveNote', async () => {
    const esc = make();
    reset = esc._resetForTests;
    const t = title({ key: 'k1', detail: 'x' });
    const { deps, resolved } = fakeDeps([
      { id: 'EI-1', title: t },
      { id: 'EI-2', title: t },
    ]);
    const ids = await esc.resolve({ key: 'k1', detail: 'store reset' }, deps);
    expect(ids.sort()).toEqual(['EI-1', 'EI-2']);
    expect(resolved.map((r) => r.note)).toEqual(['recovered — store reset', 'recovered — store reset']);
  });

  it('two escalators keep independent in-flight guards', async () => {
    const a = make();
    const b = make();
    reset = () => {
      a._resetForTests();
      b._resetForTests();
    };
    // Hold a's create pending so its inFlight stays set, then confirm b is unaffected.
    let releaseA!: (v: { id: string }) => void;
    const pendingA = new Promise<{ id: string }>((r) => (releaseA = r));
    const depsA = fakeDeps([]).deps;
    depsA.create = () => pendingA;
    const pA = a.file({ key: 'k1', detail: 'd' }, depsA);
    const { deps: depsB, created: createdB } = fakeDeps([]);
    const idB = await b.file({ key: 'k1', detail: 'd' }, depsB);
    expect(idB).toBe('EI-777'); // b filed even though a holds the same title in-flight
    expect(createdB).toHaveLength(1);
    releaseA({ id: 'EI-777' });
    await pA;
  });
});
