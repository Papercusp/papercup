import { describe, it, expect } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import {
  POT_KIND,
  describePot,
  isPotProject,
  liveAgentCountByHarness,
  type PotWakeView,
} from './_resolve';

const WAKE: PotWakeView = {
  active: false,
  nextFireAt: null,
  lastFiredAt: null,
  subscriptions: [],
  lastWakeAt: null,
};

describe('isPotProject', () => {
  it('is true only for harness_kind === pot', () => {
    expect(isPotProject({ slug: 'h', path: '/h', harness_kind: 'hive' })).toBe(true);
    expect(isPotProject({ slug: 'c', path: '/c', harness_kind: 'coding' })).toBe(false);
    expect(isPotProject({ slug: 'x', path: '/x' })).toBe(false);
  });
});

describe('describePot', () => {
  it('passes through slug/path, stamps kind, keeps the wake view', () => {
    const d = describePot({ slug: 'pot-home', path: '/p', harness_kind: 'hive' }, WAKE);
    expect(d.slug).toBe('pot-home');
    expect(d.path).toBe('/p');
    expect(d.kind).toBe(POT_KIND);
    expect(d.wake).toBe(WAKE);
  });

  it('defaults deployment to local and deployed=false / potId=undefined for a local pot', () => {
    const d = describePot({ slug: 'h', path: '/h', harness_kind: 'hive' }, WAKE);
    expect(d.deployment).toEqual({ target: 'local' });
    expect(d.deployed).toBe(false);
    expect(d.potId).toBeUndefined();
  });

  it('surfaces potId from the deployment frame and passes the deployment through', () => {
    const p = {
      slug: 'h',
      path: '/h',
      harness_kind: 'hive',
      deployment: { target: 'cloud-test' },
      deploymentFrame: { hive_id: 'hive_abc' },
    } as unknown as ProjectEntry;
    const d = describePot(p, WAKE);
    expect(d.deployed).toBe(true);
    expect(d.potId).toBe('hive_abc');
    expect(d.deployment).toEqual({ target: 'cloud-test' });
  });
});

describe('liveAgentCountByHarness', () => {
  const row = (holderAlive: boolean, harnessSlug: string | null, agentId: string | null) => ({
    holderAlive,
    harnessSlug,
    agentId,
  });

  it('counts distinct live agents per harness, ignoring dead/null rows', () => {
    const counts = liveAgentCountByHarness([
      row(true, 'potA', 'su-1'),
      row(true, 'potA', 'su-1'), // duplicate agent → one
      row(true, 'potA', 'su-2'),
      row(false, 'potA', 'su-3'), // dead → ignored
      row(true, 'potB', 'su-4'),
      row(true, null, 'su-5'), // null harness → ignored
      row(true, 'potB', null), // null agent → ignored
    ]);
    expect(counts.get('potA')).toBe(2);
    expect(counts.get('potB')).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('returns an empty map for no rows', () => {
    expect(liveAgentCountByHarness([]).size).toBe(0);
  });
});
