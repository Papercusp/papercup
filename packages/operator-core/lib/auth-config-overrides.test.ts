/**
 * auth-config-overrides.test.ts — live-configurability-audit-2026-06-20 P-019.
 *
 * The DARK §G auth/sandbox override cache: flag-OFF ⇒ byte-identical (empty getters, resolver falls
 * through), flag-ON ⇒ overrides apply; the testing-full-access kill-switch; tighten-only semantics —
 * all PG-free via mocked operator-state + flag IO, with the installed gate-bypass resolver captured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';

// vi.hoisted: the resolver is captured DURING module import (auth-config-overrides installs it at
// load), which ESM-hoists above plain `let` decls → TDZ. A hoisted holder runs before everything.
const h = vi.hoisted(() => ({
  storedRow: {} as Record<string, unknown>,
  flagState: {} as Record<string, boolean>,
  capturedResolver: undefined as ((role: string | null | undefined) => boolean | null | undefined) | undefined,
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async (key: string) => h.flagState[key] ?? false),
  onFlagChange: () => {},
}));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => h.storedRow),
  writeOperatorState: vi.fn(async (_t: string, p: Record<string, unknown>) => {
    h.storedRow = p;
  }),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  setTestingFullAccessResolver: (fn: typeof h.capturedResolver) => {
    h.capturedResolver = fn;
  },
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'sys' }));

import {
  refreshAuthConfigOverrides,
  authSafeToolsRemoveSet,
  authSandboxMaskAdditions,
  authSandboxDenyAllEgressOverride,
  setFullAccessRoles,
  setSafeToolsRemove,
  setSandboxPolicy,
  readAuthConfigOverrides,
} from './auth-config-overrides';

async function boot(opts: { overrides?: boolean; testingFullAccess?: boolean; row?: Record<string, unknown> } = {}) {
  h.flagState[FLAGS.AUTH_CONFIG_OVERRIDES] = opts.overrides ?? false;
  h.flagState[FLAGS.TESTING_FULL_ACCESS] = opts.testingFullAccess ?? true;
  h.storedRow = opts.row ?? {};
  await refreshAuthConfigOverrides();
}

beforeEach(async () => {
  await boot();
});

describe('flag OFF (default) ⇒ byte-identical', () => {
  it('every getter is empty and the resolver falls through to the baked set (null)', async () => {
    await boot({ overrides: false, row: { fullAccessRoles: ['x'], safeToolsRemove: ['a:b'], sandboxMaskAdditions: ['.foo'], sandboxDenyAllEgress: true } });
    expect(authSafeToolsRemoveSet().size).toBe(0);
    expect(authSandboxMaskAdditions()).toEqual([]);
    expect(authSandboxDenyAllEgressOverride()).toBeUndefined();
    // resolver: kill-switch on, no active override ⇒ null (fall through to baked TESTING_FULL_ACCESS_ROLES)
    expect(h.capturedResolver?.('operator')).toBeNull();
  });
});

describe('testing-full-access kill-switch (papercusp-testing-full-access)', () => {
  it('flag OFF ⇒ the resolver returns false for every role (globally disabled)', async () => {
    await boot({ testingFullAccess: false });
    expect(h.capturedResolver?.('operator')).toBe(false);
    expect(h.capturedResolver?.('bee')).toBe(false);
  });
  it('flag ON ⇒ falls through to baked when no override is set', async () => {
    await boot({ testingFullAccess: true });
    expect(h.capturedResolver?.('operator')).toBeNull();
  });
});

describe('dark flag ON ⇒ overrides apply', () => {
  it('fullAccessRoles REPLACES the baked set (resolver returns membership in the override)', async () => {
    await boot({ overrides: true, row: { fullAccessRoles: ['operator'] } });
    expect(h.capturedResolver?.('operator')).toBe(true);
    expect(h.capturedResolver?.('bee')).toBe(false); // bee is in the BAKED set but NOT the override
  });

  it('safeToolsRemove is exposed as the narrow-only remove-set', async () => {
    await boot({ overrides: true, row: { safeToolsRemove: ['memory:remember'] } });
    expect(authSafeToolsRemoveSet().has('memory:remember')).toBe(true);
    expect(authSafeToolsRemoveSet().has('memory:search')).toBe(false);
  });

  it('sandbox mask additions + denyAllEgress are exposed', async () => {
    await boot({ overrides: true, row: { sandboxMaskAdditions: ['.config/foo'], sandboxDenyAllEgress: true } });
    expect(authSandboxMaskAdditions()).toEqual(['.config/foo']);
    expect(authSandboxDenyAllEgressOverride()).toBe(true);
  });

  it('kill-switch OFF wins even with an override set (returns false, not membership)', async () => {
    await boot({ overrides: true, testingFullAccess: false, row: { fullAccessRoles: ['operator'] } });
    expect(h.capturedResolver?.('operator')).toBe(false);
  });
});

describe('set* round-trips (persist → refresh)', () => {
  it('setFullAccessRoles is reflected by the resolver once the dark flag is on', async () => {
    await boot({ overrides: true });
    await setFullAccessRoles(['queen']);
    expect(h.capturedResolver?.('queen')).toBe(true);
    expect((await readAuthConfigOverrides()).fullAccessRoles).toEqual(['queen']);
    await setFullAccessRoles(null); // clear
    expect(h.capturedResolver?.('queen')).toBeNull();
  });

  it('setSafeToolsRemove + setSandboxPolicy round-trip and sanitize', async () => {
    await boot({ overrides: true });
    await setSafeToolsRemove(['t:a', 't:a', '']); // dedupe + drop empty
    expect([...authSafeToolsRemoveSet()]).toEqual(['t:a']);
    await setSandboxPolicy({ maskAdditions: ['.x'], denyAllEgress: true });
    expect(authSandboxMaskAdditions()).toEqual(['.x']);
    expect(authSandboxDenyAllEgressOverride()).toBe(true);
  });
});
