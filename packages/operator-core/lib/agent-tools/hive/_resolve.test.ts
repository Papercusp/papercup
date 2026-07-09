import { describe, it, expect } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import {
  HIVE_KIND,
  describeHive,
  isHiveProject,
  liveAgentCountByHarness,
  type HiveWakeView,
} from './_resolve';

const WAKE: HiveWakeView = {
  active: false,
  nextFireAt: null,
  lastFiredAt: null,
  subscriptions: [],
  lastWakeAt: null,
};

describe('isHiveProject', () => {
  it('is true only for harness_kind === hive', () => {
    expect(isHiveProject({ slug: 'h', path: '/h', harness_kind: 'hive' })).toBe(true);
    expect(isHiveProject({ slug: 'c', path: '/c', harness_kind: 'coding' })).toBe(false);
    expect(isHiveProject({ slug: 'x', path: '/x' })).toBe(false);
  });
});

describe('describeHive', () => {
  it('passes through slug/path, stamps kind, keeps the wake view', () => {
    const d = describeHive({ slug: 'hive-home', path: '/p', harness_kind: 'hive' }, WAKE);
    expect(d.slug).toBe('hive-home');
    expect(d.path).toBe('/p');
    expect(d.kind).toBe(HIVE_KIND);
    expect(d.wake).toBe(WAKE);
  });

  it('defaults deployment to local and deployed=false / potId=undefined for a local hive', () => {
    const d = describeHive({ slug: 'h', path: '/h', harness_kind: 'hive' }, WAKE);
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
    const d = describeHive(p, WAKE);
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
      row(true, 'hiveA', 'su-1'),
      row(true, 'hiveA', 'su-1'), // duplicate agent → one
      row(true, 'hiveA', 'su-2'),
      row(false, 'hiveA', 'su-3'), // dead → ignored
      row(true, 'hiveB', 'su-4'),
      row(true, null, 'su-5'), // null harness → ignored
      row(true, 'hiveB', null), // null agent → ignored
    ]);
    expect(counts.get('hiveA')).toBe(2);
    expect(counts.get('hiveB')).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('returns an empty map for no rows', () => {
    expect(liveAgentCountByHarness([]).size).toBe(0);
  });
});
