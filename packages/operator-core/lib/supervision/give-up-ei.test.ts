/**
 * give-up-ei.test.ts — the supervision give-up EI binding (EI-19966318801100410). The shared
 * escalator factory's own behavior (dedup, VITEST gate, resolve-all) is exhaustively pinned by
 * escalation/episodic-ei.test.ts; this thin wrapper test only pins THIS binding's config
 * wiring: the stable title, body content, and that file/resolve correctly delegate through
 * injected deps — mirroring the convention set by precision-alert-ei.test.ts /
 * replication-stall-ei.ts's binding.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileSupervisionGiveUpEi,
  resolveSupervisionGiveUpEi,
  supervisionGiveUpEiTitle,
  SUPERVISION_GIVE_UP_TOPIC,
  RECOVERY_OWNER,
  _resetSupervisionGiveUpEiForTests,
  type SupervisionGiveUpEiDeps,
  type SupervisionGiveUpEpisode,
} from './give-up-ei';

function episode(over: Partial<SupervisionGiveUpEpisode> = {}): SupervisionGiveUpEpisode {
  return {
    unit: 'papercup-staging-api',
    restartsInWindow: 6,
    causeSuffix: ' Cause: Process: 904863 ExecStartPre=/x/bundle-host.sh (code=exited, status=1/FAILURE)',
    ...over,
  };
}

function fakeDeps(open: Array<{ id: string; title: string }>) {
  const created: Array<{ title: string; body: string; severity: string; topics: string[]; createdBy: string }> = [];
  const resolved: Array<{ id: string; note: string }> = [];
  const deps: SupervisionGiveUpEiDeps = {
    listOpenByTopic: async () => open,
    create: async (input) => {
      created.push({ title: input.title, body: input.body, severity: input.severity, topics: input.topics, createdBy: input.createdBy });
      return { id: 'EI-999' };
    },
    resolve: async (id, note) => {
      resolved.push({ id, note });
    },
  };
  return { deps, created, resolved };
}

describe('give-up-ei (supervision give-up EI binding, EI-19966318801100410)', () => {
  afterEach(() => {
    _resetSupervisionGiveUpEiForTests();
  });

  it('the stable title keys ONLY on unit — not the restart count or cause (so repeated give-ups for the same unit stay one EI)', () => {
    const t1 = supervisionGiveUpEiTitle({ unit: 'papercup-staging-api' });
    const t2 = supervisionGiveUpEiTitle({ unit: 'papercup-staging-api' });
    expect(t1).toBe(t2);
    expect(t1).toContain('papercup-staging-api');
  });

  it('different units get different titles (no cross-unit dedup collision)', () => {
    expect(supervisionGiveUpEiTitle({ unit: 'papercup-staging-api' })).not.toBe(
      supervisionGiveUpEiTitle({ unit: 'papercup-mcp-proxy' }),
    );
  });

  it('files with the supervision-give-up topic, critical severity, and a body carrying the cause + restart count', async () => {
    const { deps, created } = fakeDeps([]);
    const id = await fileSupervisionGiveUpEi(episode(), deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
    expect(created[0]!.topics).toEqual(expect.arrayContaining([SUPERVISION_GIVE_UP_TOPIC]));
    expect(created[0]!.severity).toBe('critical');
    expect(created[0]!.createdBy).toBe('system:supervision-reconciler');
    expect(created[0]!.body).toContain('papercup-staging-api');
    expect(created[0]!.body).toContain('6 restarts');
    expect(created[0]!.body).toContain('bundle-host.sh');
  });

  it('dedupes against an already-open EI for the same unit', async () => {
    const { deps, created } = fakeDeps([{ id: 'EI-1', title: supervisionGiveUpEiTitle({ unit: 'papercup-staging-api' }) }]);
    const id = await fileSupervisionGiveUpEi(episode(), deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a give-up for a DIFFERENT unit is not suppressed by an open EI for another unit', async () => {
    const { deps, created } = fakeDeps([{ id: 'EI-1', title: supervisionGiveUpEiTitle({ unit: 'papercup-mcp-proxy' }) }]);
    const id = await fileSupervisionGiveUpEi(episode({ unit: 'papercup-staging-api' }), deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
  });

  it('resolves every open EI for the unit with a recovery note naming it recovered', async () => {
    const { deps, resolved } = fakeDeps([{ id: 'EI-1', title: supervisionGiveUpEiTitle({ unit: 'papercup-staging-api' }) }]);
    const ids = await resolveSupervisionGiveUpEi({ unit: 'papercup-staging-api' }, deps);
    expect(ids).toEqual(['EI-1']);
    expect(resolved[0]!.note).toContain('papercup-staging-api');
    expect(resolved[0]!.note).toContain('recovered');
  });

  it('resolve no-ops when nothing is open for this unit', async () => {
    const { deps, resolved } = fakeDeps([]);
    const ids = await resolveSupervisionGiveUpEi({ unit: 'papercup-staging-api' }, deps);
    expect(ids).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('RECOVERY_OWNER is a stable system identity distinct from a real human resolver', () => {
    expect(RECOVERY_OWNER).toBe('system:supervision-reconciler');
  });

  it('the VITEST gate refuses to file/resolve against real PG when no deps are injected', async () => {
    expect(await fileSupervisionGiveUpEi(episode())).toBeNull();
    expect(await resolveSupervisionGiveUpEi({ unit: 'papercup-staging-api' })).toEqual([]);
  });
});
