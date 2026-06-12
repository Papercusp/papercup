/**
 * Coverage for admin-test-suites' pure registry helpers: listAdminTestSuites,
 * expandAdminTestSuiteSelection ('all-safe' → the safeDefault subset, else the
 * single id), and the isAdminTestSuiteId guard.
 */
import { describe, expect, it } from 'vitest';
import {
  listAdminTestSuites,
  expandAdminTestSuiteSelection,
  isAdminTestSuiteId,
  pickBridgePid,
} from './admin-test-suites';

const suites = listAdminTestSuites();

describe('listAdminTestSuites', () => {
  it('returns a non-empty registry, each with an id + safeDefault flag', () => {
    expect(suites.length).toBeGreaterThan(0);
    for (const s of suites) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.safeDefault).toBe('boolean');
    }
  });
});

describe('expandAdminTestSuiteSelection', () => {
  it("'all-safe' expands to exactly the safeDefault suites", () => {
    const expanded = expandAdminTestSuiteSelection('all-safe');
    const expectedSafe = suites.filter((s) => s.safeDefault).map((s) => s.id).sort();
    expect([...expanded].sort()).toEqual(expectedSafe);
  });

  it('a specific id expands to just that id', () => {
    const id = suites[0].id;
    expect(expandAdminTestSuiteSelection(id)).toEqual([id]);
  });
});

describe('isAdminTestSuiteId', () => {
  it('accepts a registered id, rejects anything else', () => {
    expect(isAdminTestSuiteId(suites[0].id)).toBe(true);
    expect(isAdminTestSuiteId('definitely-not-a-suite')).toBe(false);
  });
});

/**
 * pickBridgePid — the suite runner's instance-pinning decision. On a box
 * running several Tauri desktops (the owner's seat + agents' Xvfb instances)
 * an unpinned run would let tauri-agent-tools' discoverBridge() pick an
 * arbitrary window; these cases pin the contract.
 */
describe('pickBridgePid (suite-run bridge pinning)', () => {
  const noAncestors = new Set<number>();

  it('explicit request pin wins over everything', () => {
    expect(pickBridgePid({ explicit: 42, envPid: 7, live: [1, 2, 3], ancestors: noAncestors })).toBe(42);
  });

  it('env pin wins when no explicit pin', () => {
    expect(pickBridgePid({ explicit: null, envPid: 7, live: [1, 2], ancestors: noAncestors })).toBe(7);
  });

  it('no live bridge → null (checks surface the normal bridge-unreachable error)', () => {
    expect(pickBridgePid({ explicit: null, envPid: null, live: [], ancestors: noAncestors })).toBeNull();
  });

  it('exactly one live bridge → pinned to it', () => {
    expect(pickBridgePid({ explicit: null, envPid: null, live: [123], ancestors: noAncestors })).toBe(123);
  });

  it('multiple bridges → the one on the operator ancestry (dev-shell sidecar) wins', () => {
    expect(pickBridgePid({ explicit: null, envPid: null, live: [10, 20, 30], ancestors: new Set([5, 20]) })).toBe(20);
  });

  it('multiple bridges, none ours → throws instead of driving an arbitrary window', () => {
    expect(() => pickBridgePid({ explicit: null, envPid: null, live: [10, 20], ancestors: noAncestors })).toThrow(/refusing to drive/i);
  });
});
