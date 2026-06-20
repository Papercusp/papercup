/**
 * workspace-brain-scope.test.ts — the shared K1 keying logic
 * (workspace-scoped-coordination-2026-06-20 D-006). Pure functions; the flag-read
 * (isWorkspaceCoordinationOn) is integration-covered via its consumers.
 */
import { describe, it, expect } from 'vitest';
import { workspaceBrainScopeKey, workspaceBrainReadKeys } from './workspace-brain-scope';

const WS = 'papercusp-workspace';
const HIVE = 'papercusp';

describe('workspaceBrainScopeKey (K1 write key)', () => {
  it('OFF → legacy per-hive slug (byte-identical to today)', () => {
    expect(workspaceBrainScopeKey(WS, HIVE, false)).toBe(HIVE);
  });
  it('ON → workspace sentinel (= workspaceId)', () => {
    expect(workspaceBrainScopeKey(WS, HIVE, true)).toBe(WS);
  });
  it('ON → sentinel regardless of which hive emitted it (one row per workspace)', () => {
    expect(workspaceBrainScopeKey(WS, 'other-hive', true)).toBe(WS);
    expect(workspaceBrainScopeKey(WS, 'spreadsheet-hive', true)).toBe(WS);
  });
});

describe('workspaceBrainReadKeys (K1 read-fallback order)', () => {
  it('OFF → only the per-hive row', () => {
    expect(workspaceBrainReadKeys(WS, HIVE, false)).toEqual([HIVE]);
  });
  it('ON → prefer the workspace sentinel, then fall back to the per-hive row', () => {
    expect(workspaceBrainReadKeys(WS, HIVE, true)).toEqual([WS, HIVE]);
  });
  it('ON + workspace==hive shape → de-duplicates to a single key', () => {
    expect(workspaceBrainReadKeys(WS, WS, true)).toEqual([WS]);
  });
  it('ON + no per-hive slug → just the sentinel', () => {
    expect(workspaceBrainReadKeys(WS, '', true)).toEqual([WS]);
  });
  it('OFF + no per-hive slug → empty (nothing to read)', () => {
    expect(workspaceBrainReadKeys(WS, '', false)).toEqual([]);
  });
});
