/**
 * EI-19452830964505931 — the ISSUES_PER_WORKSPACE cache must be keyed BY WORKSPACE.
 *
 * THE TRAP THIS PINS: `getFlag(FLAGS.ISSUES_PER_WORKSPACE, systemDistinctId())` LOOKS
 * workspace-independent, because `systemDistinctId()` is machine-stable
 * (`papercusp-host-<hostname>`) — there is no per-workspace targeting in the distinctId. But the PG
 * override store underneath is installed with `cacheKey: () => activeWorkspaceId()` and loads
 * `WHERE workspace_id = activeWorkspaceId()`, so getFlag's ANSWER is workspace-dependent even
 * though its ARGUMENTS are not. Caching that answer in one process-global boolean therefore lets
 * whichever workspace refreshed last serve its value to every other one — re-creating one layer up
 * the exact cross-workspace bleed that store's cacheKey exists to prevent.
 *
 * This is not hypothetical: measured 2026-08-03, `papercusp-issues-per-workspace` is overridden
 * false in 'generic-test' and true in 'shared-hive-test-aviynw' in the same database.
 *
 * The mock below models exactly that: getFlag consults the CURRENT ambient workspace, ignoring its
 * distinctId argument — which is what the real override store does.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/issues-engineer.flag-workspace-scope.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS_ON = 'ws-flag-on';
const WS_OFF = 'ws-flag-off';
const LEGACY = 'default'; // DEFAULT_COORD_WORKSPACE

const h = vi.hoisted(() => ({
  active: 'ws-flag-on',
  // Models the override store: the answer depends on the AMBIENT workspace, not the distinctId.
  getFlag: vi.fn(async () => h.active !== 'ws-flag-off'),
  handlers: [] as Array<(key: string | null) => void>,
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: h.getFlag,
  onFlagChange: (handler: (key: string | null) => void) => {
    h.handlers.push(handler);
    return () => {};
  },
}));

vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => h.active,
  DEFAULT_WORKSPACE_ID: 'default',
}));

import { resolveIssuesScopeWorkspace } from './issues-engineer';

/** Let the fire-and-forget `void refreshIssuesPerWorkspace()` settle, then read again. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  h.getFlag.mockClear();
});

describe('issues-engineer flag cache is keyed by workspace, not process-global', () => {
  it('an OFF override in one workspace is not served to another', async () => {
    // Warm WS_ON: first call arms + seeds, kicks the async refresh, then settles to a real read.
    h.active = WS_ON;
    resolveIssuesScopeWorkspace();
    await settle();
    expect(resolveIssuesScopeWorkspace()).toBe(WS_ON);

    // Warm WS_OFF, whose override resolves the flag OFF → the legacy shared partition.
    h.active = WS_OFF;
    resolveIssuesScopeWorkspace();
    await settle();
    expect(resolveIssuesScopeWorkspace()).toBe(LEGACY);

    // THE ASSERTION THAT MATTERS. Against the old process-global boolean, WS_OFF's refresh had just
    // overwritten the single cached value (and the single readAtMs, so this read is not even stale),
    // so WS_ON resolved to the legacy partition too — issue rows landing in the wrong partition.
    h.active = WS_ON;
    expect(resolveIssuesScopeWorkspace()).toBe(WS_ON);
  });

  it('keeps both workspaces stable across repeated interleaved reads', async () => {
    h.active = WS_ON;
    resolveIssuesScopeWorkspace();
    await settle();
    h.active = WS_OFF;
    resolveIssuesScopeWorkspace();
    await settle();

    // Interleave without awaiting: entries are already warm, so no refresh should be needed to keep
    // them apart. A global cache flips on every switch here; a keyed one does not.
    for (let i = 0; i < 5; i += 1) {
      h.active = WS_ON;
      expect(resolveIssuesScopeWorkspace()).toBe(WS_ON);
      h.active = WS_OFF;
      expect(resolveIssuesScopeWorkspace()).toBe(LEGACY);
    }
  });

  it('an unseeded workspace serves FLAG_DEFAULTS, never a hardcoded literal', async () => {
    // A workspace the arm never seeded has no entry at all. The reader falls back to
    // FLAG_DEFAULTS[ISSUES_PER_WORKSPACE] (true) rather than to `false` — the distinction that made
    // the FIRST migration attempt of this module wrong (it resolved scope to the near-dead 'default'
    // partition while the flag was held ON).
    h.active = 'ws-never-seen-before';
    expect(resolveIssuesScopeWorkspace()).toBe('ws-never-seen-before');
  });
});
