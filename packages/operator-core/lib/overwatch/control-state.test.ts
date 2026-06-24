/**
 * Unit tests for the overwatch control state (overwatch-role-2026-06-15 B-07).
 *
 * Pin the load-bearing control bit + cadence: the started flag round-trips, the
 * cadence clamps into [MIN, MAX], unset reads fall back to the default, and
 * listStartedOverwatches parses exactly the started (workspace, install) set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory KV standing in for harness_shared.operator_settings: a tagged-template
// `sql` that resolves SELECTs from `store` and applies the INSERT…ON CONFLICT upsert.
let store: Record<string, string> = {};
const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
  const text = strings.join('?');
  if (/SELECT value FROM/i.test(text)) {
    const key = values[0] as string;
    const v = store[key];
    return Promise.resolve(v === undefined ? [] : [{ value: v }]);
  }
  if (/SELECT key FROM/i.test(text)) {
    return Promise.resolve(
      Object.entries(store)
        .filter(([k, v]) => k.startsWith('overwatch_started:') && v === 'true')
        .map(([k]) => ({ key: k })),
    );
  }
  if (/INSERT INTO/i.test(text)) {
    store[values[0] as string] = String(values[1]);
    return Promise.resolve([]);
  }
  return Promise.resolve([]);
};
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: fakeSql }) };
});

// Pin WORKSPACE_COORDINATION OFF so these unit tests deterministically exercise
// the per-(workspace, install) keying path (the legacy/read-fallback scope) they
// were written for — independent of the production flag default, which graduated
// to ON (2026-06-23). The de-duped workspace-sentinel (ON) path is a separate
// surface (listStartedWorkspaceOverwatches). Keep the pure scope helpers real.
vi.mock('../workspace-brain-scope', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isWorkspaceCoordinationOn: () => Promise.resolve(false) };
});

import {
  clampOverwatchCadenceSec,
  getOverwatchStarted,
  setOverwatchStarted,
  getOverwatchCadenceSec,
  setOverwatchCadenceSec,
  listStartedOverwatches,
  DEFAULT_OVERWATCH_CADENCE_SEC,
  MIN_OVERWATCH_CADENCE_SEC,
  MAX_OVERWATCH_CADENCE_SEC,
} from './control-state';

beforeEach(() => {
  store = {};
});

describe('clampOverwatchCadenceSec', () => {
  it('clamps into [MIN, MAX] and rounds; non-finite → default', () => {
    expect(clampOverwatchCadenceSec(0)).toBe(MIN_OVERWATCH_CADENCE_SEC);
    expect(clampOverwatchCadenceSec(10)).toBe(MIN_OVERWATCH_CADENCE_SEC);
    expect(clampOverwatchCadenceSec(999_999)).toBe(MAX_OVERWATCH_CADENCE_SEC);
    expect(clampOverwatchCadenceSec(600)).toBe(600);
    expect(clampOverwatchCadenceSec(123.6)).toBe(124);
    expect(clampOverwatchCadenceSec(Number.NaN)).toBe(DEFAULT_OVERWATCH_CADENCE_SEC);
    expect(clampOverwatchCadenceSec(Number.POSITIVE_INFINITY)).toBe(DEFAULT_OVERWATCH_CADENCE_SEC);
  });
});

describe('started bit', () => {
  it('defaults false, round-trips true/false', async () => {
    expect(await getOverwatchStarted('ws-1', 'hiveA')).toBe(false);
    await setOverwatchStarted('ws-1', 'hiveA', true);
    expect(await getOverwatchStarted('ws-1', 'hiveA')).toBe(true);
    await setOverwatchStarted('ws-1', 'hiveA', false);
    expect(await getOverwatchStarted('ws-1', 'hiveA')).toBe(false);
  });

  it('is per (workspace, install)', async () => {
    await setOverwatchStarted('ws-1', 'hiveA', true);
    expect(await getOverwatchStarted('ws-1', 'hiveB')).toBe(false);
    expect(await getOverwatchStarted('ws-2', 'hiveA')).toBe(false);
  });
});

describe('cadence', () => {
  it('defaults to DEFAULT when unset', async () => {
    expect(await getOverwatchCadenceSec('ws-1', 'hiveA')).toBe(DEFAULT_OVERWATCH_CADENCE_SEC);
  });

  it('persists clamped + reads back clamped', async () => {
    const stored = await setOverwatchCadenceSec('ws-1', 'hiveA', 30); // below MIN
    expect(stored).toBe(MIN_OVERWATCH_CADENCE_SEC);
    expect(await getOverwatchCadenceSec('ws-1', 'hiveA')).toBe(MIN_OVERWATCH_CADENCE_SEC);

    await setOverwatchCadenceSec('ws-1', 'hiveA', 300);
    expect(await getOverwatchCadenceSec('ws-1', 'hiveA')).toBe(300);
  });
});

describe('listStartedOverwatches', () => {
  it('returns exactly the started (workspace, install) pairs, parsed on the first colon', async () => {
    await setOverwatchStarted('ws-1', 'hiveA', true);
    await setOverwatchStarted('ws-2', 'hive-b', true);
    await setOverwatchStarted('ws-1', 'hiveC', false); // paused — excluded
    await setOverwatchCadenceSec('ws-1', 'hiveA', 600); // a non-started row — excluded

    const started = await listStartedOverwatches();
    expect(started).toContainEqual({ workspaceId: 'ws-1', installSlug: 'hiveA' });
    expect(started).toContainEqual({ workspaceId: 'ws-2', installSlug: 'hive-b' });
    expect(started).not.toContainEqual({ workspaceId: 'ws-1', installSlug: 'hiveC' });
    expect(started).toHaveLength(2);
  });
});
