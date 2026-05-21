/**
 * Tests for the locks-side `readIdentity` adapter. The interesting
 * behaviour lives in `resolveAgentIdentity` (covered by
 * `coordination/__tests__/identity.test.ts`); these tests verify only
 * that the adapter correctly projects the unified shape into
 * `SuAgentIdentity`.
 */

import { describe, expect, it } from 'vitest';
import { readIdentity } from '../identity';

describe('locks readIdentity adapter', () => {
  it('projects the principal branch and preserves coordinationDomain', () => {
    const id = readIdentity({
      principal: {
        kind: 'harness',
        slug: 'restart',
        workspaceId: 'ws-7',
      },
    });
    expect(id.ownerId).toBe('restart');
    expect(id.ownerLabel).toBe('harness · restart');
    expect(id.coordinationDomain).toBe('ws-7');
  });

  it('substitutes "default" coordinationDomain for a null coordination result', () => {
    const id = readIdentity({
      isSuperuser: true,
      uiClientId: 'sess-abc12345',
    });
    expect(id.ownerId).toBe('sess-abc12345');
    expect(id.coordinationDomain).toBe('default');
  });

  it('inherits the power-user branch from resolveAgentIdentity', () => {
    // Pre-refactor: power-user fell through to the superuser branch.
    // Post-refactor: power-user is first-class — ownerId is the
    // auth_session_id and the label uses the omp prefix.
    const id = readIdentity({
      isPowerUser: true,
      isSuperuser: true,
      uiClientId: 'pus-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
      workspaceId: 'ws-42',
    });
    expect(id.ownerId).toBe('pus-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d');
    expect(id.ownerLabel.startsWith('omp · pus-')).toBe(true);
    expect(id.coordinationDomain).toBe('ws-42');
  });

  it('propagates resolveAgentIdentity errors', () => {
    expect(() => readIdentity({})).toThrow(/cannot be attributed/);
  });
});
