/**
 * Tests for the locks-side `readIdentity` adapter. The interesting
 * behaviour lives in `resolveAgentIdentity` (covered by
 * `coordination/__tests__/identity.test.ts`); these tests verify only
 * that the adapter correctly projects the unified shape into
 * `SuAgentIdentity`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIdentity } from '../identity';
import { __resetLockCoordinationDomain } from '../coordination-domain';

// Pin the lock domain so the assertions don't depend on the test runner's CWD /
// realpath. The CONTRACT under test (D-015) is that coordinationDomain is the
// repo-root lock domain and is INDEPENDENT of the caller's workspaceId.
const DOMAIN = '/repo/papercup';

describe('locks readIdentity adapter', () => {
  beforeEach(() => {
    __resetLockCoordinationDomain();
    process.env.PAPERCUSP_LOCK_DOMAIN = DOMAIN;
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_LOCK_DOMAIN;
    __resetLockCoordinationDomain();
  });

  it('projects the principal branch; coordinationDomain is the repo-root domain, NOT the workspace', () => {
    const id = readIdentity({
      principal: { kind: 'harness', slug: 'restart', workspaceId: 'ws-7' },
    });
    expect(id.ownerId).toBe('restart');
    expect(id.ownerLabel).toBe('harness · restart');
    // D-015: workspace 'ws-7' is ignored for the lock domain.
    expect(id.coordinationDomain).toBe(DOMAIN);
  });

  it('coordinationDomain is workspace-INDEPENDENT — every caller gets the same domain', () => {
    const a = readIdentity({ principal: { kind: 'harness', slug: 'a', workspaceId: 'ws-1' } });
    const b = readIdentity({ principal: { kind: 'harness', slug: 'b', workspaceId: 'ws-2' } });
    const c = readIdentity({ isSuperuser: true, uiClientId: 'sess-abc12345' });
    expect(a.coordinationDomain).toBe(DOMAIN);
    expect(b.coordinationDomain).toBe(DOMAIN);
    expect(c.coordinationDomain).toBe(DOMAIN);
  });

  it('inherits the power-user branch from resolveAgentIdentity (owner identity unchanged)', () => {
    const id = readIdentity({
      isPowerUser: true,
      isSuperuser: true,
      uiClientId: 'pus-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
      workspaceId: 'ws-42',
    });
    expect(id.ownerId).toBe('pus-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d');
    expect(id.ownerLabel.startsWith('omp · pus-')).toBe(true);
    expect(id.coordinationDomain).toBe(DOMAIN); // workspace ws-42 ignored
  });

  it('propagates resolveAgentIdentity errors', () => {
    expect(() => readIdentity({})).toThrow(/cannot be attributed/);
  });
});
