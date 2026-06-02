/**
 * Tests for resolveBearer — the single bearer-token → Principal gatekeeper
 * every MCP tool call passes through. It had ZERO coverage.
 *
 * PG is mocked (@papercusp/db-org): getOrgPg().sql returns the token_index
 * row; withWorkspace runs its callback with a tx that returns the principal
 * row. We exercise resolveBearer's branching, NOT the SQL filters (those
 * belong to the live-PG cross-workspace-probe integration test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Closure-configured fake result sets, set per test.
let tokenIndexRows: Array<Record<string, unknown>> = [];
let principalRows: Array<Record<string, unknown>> = [];
let withWorkspaceCalls = 0;

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    // tagged-template: sql`...` → sql(strings, ...values)
    sql: (..._args: unknown[]) => Promise.resolve(tokenIndexRows),
  }),
  withWorkspace: (_ws: string, cb: (tx: unknown) => unknown) => {
    withWorkspaceCalls++;
    const tx = (..._a: unknown[]) => Promise.resolve(principalRows);
    return cb(tx);
  },
}));

import { createHash } from 'node:crypto';
import { resolveBearer, invalidate, _resetAuthCacheForTests } from './auth';

const hashOf = (bearer: string) => createHash('sha256').update(bearer).digest('hex');

beforeEach(() => {
  _resetAuthCacheForTests();
  tokenIndexRows = [];
  principalRows = [];
  withWorkspaceCalls = 0;
});

afterEach(() => vi.clearAllMocks());

describe('resolveBearer', () => {
  it('returns null for an empty bearer (no PG lookup)', async () => {
    expect(await resolveBearer('')).toBeNull();
    expect(withWorkspaceCalls).toBe(0);
  });

  it('returns null when the bearer is not in token_index', async () => {
    tokenIndexRows = [];
    expect(await resolveBearer('unknown-token')).toBeNull();
  });

  it("returns null for a kind='harness' bearer (harness bearers are out of scope for v1)", async () => {
    tokenIndexRows = [
      { token: 'h', kind: 'harness', harness_slug: 'papercup', workspace_id: 'ws1' },
    ];
    expect(await resolveBearer('h')).toBeNull();
    // Never reaches capability load.
    expect(withWorkspaceCalls).toBe(0);
  });

  it('resolves a valid system principal to a trusted bearer-token Principal', async () => {
    const bearer = 'system-bearer-token-abcdef';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

    const p = await resolveBearer(bearer);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('system');
    expect(p!.slug).toBe('system:operator');
    expect(p!.workspaceId).toBe('ws1');
    expect(p!.authMethod).toBe('bearer-token');
    expect(p!.trust).toBe('trusted');
    expect(p!.capabilities.has('*')).toBe(true);
  });

  it('returns null when the stored bearer_hash does not match (tampered/forged token)', async () => {
    const bearer = 'system-bearer-token-abcdef';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    // Row exists but its hash is for a *different* secret — the only guard
    // against a token-table row being replayed with the wrong bearer.
    principalRows = [{ bearer_hash: hashOf('a-totally-different-secret'), capabilities: ['*'] }];

    expect(await resolveBearer(bearer)).toBeNull();
  });

  it('returns null for an ended pi session even with a matching hash', async () => {
    const bearer = 'pi-bearer-token-abcdef12';
    tokenIndexRows = [
      { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
    ];
    principalRows = [
      { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], ended_at: new Date() },
    ];
    expect(await resolveBearer(bearer)).toBeNull();
  });

  it('resolves an active pi session (ended_at null) with a matching hash', async () => {
    const bearer = 'pi-bearer-token-abcdef12';
    tokenIndexRows = [
      { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
    ];
    principalRows = [
      { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], ended_at: null },
    ];
    const p = await resolveBearer(bearer);
    expect(p!.kind).toBe('pi');
    expect(p!.capabilities.has('harness:read')).toBe(true);
  });

  it('serves a cached principal without re-loading capabilities, and re-loads after invalidate()', async () => {
    const bearer = 'system-bearer-token-abcdef';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

    const first = await resolveBearer(bearer);
    expect(first).not.toBeNull();
    expect(withWorkspaceCalls).toBe(1);

    // Capability source now empty — a cache HIT must NOT re-query it.
    principalRows = [];
    const second = await resolveBearer(bearer);
    expect(second).not.toBeNull();
    expect(withWorkspaceCalls).toBe(1); // unchanged → served from cache

    // After invalidation the next call re-loads and now fails (revoked).
    invalidate('ws1', 'system:operator');
    const third = await resolveBearer(bearer);
    expect(third).toBeNull();
    expect(withWorkspaceCalls).toBe(2);
  });
});
