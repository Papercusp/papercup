/**
 * Unit tests for `principalFromBearerToken` — the agent bearer-token
 * resolver INTERNALS.
 *
 * The composite `require-principal.test.ts` doesn't exercise this path at
 * all. The resolver's own logic is the header parse + delegation to
 * `resolveBearer` (the `harness_shared.token_index` lookup); the lookup
 * itself is mocked here so the test stays hermetic (no PG).
 *
 * NOTE on grounding: the real `from-bearer-token.ts` imports ONLY
 * `resolveBearer` from `@papercusp/agent-mcp` — it does not call
 * `activeWorkspaceId` (the workspace comes from the token_index row that
 * resolveBearer reads). So only `resolveBearer` is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  resolveBearer: vi.fn(async () => null),
}));

import { principalFromBearerToken } from './from-bearer-token';
import { resolveBearer } from '@papercusp/agent-mcp';

const h = (init: Record<string, string> = {}) => new Headers(init);

beforeEach(() => {
  vi.mocked(resolveBearer).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('principalFromBearerToken', () => {
  it('returns null with no Authorization header', async () => {
    expect(await principalFromBearerToken(h())).toBeNull();
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it('treats a bare "Bearer" (no token) as the raw value — the Headers API trims the trailing space, so it never matches the "Bearer " prefix; the lookup runs and returns null', async () => {
    // NOTE: the resolver's `if (!token) return null` empty-after-strip guard
    // is effectively unreachable through a Headers object: the web Headers
    // API normalizes "Bearer " → "Bearer" (trailing-space trim), which fails
    // the `startsWith('Bearer ')` test and is passed through verbatim as the
    // non-empty string "Bearer". So this lands in the lookup, not the guard.
    vi.mocked(resolveBearer).mockResolvedValue(null);
    const p = await principalFromBearerToken(h({ authorization: 'Bearer ' }));
    expect(p).toBeNull();
    expect(resolveBearer).toHaveBeenCalledWith('Bearer');
  });

  it('strips the "Bearer " prefix before the lookup', async () => {
    await principalFromBearerToken(h({ authorization: 'Bearer agent_tok' }));
    expect(resolveBearer).toHaveBeenCalledWith('agent_tok');
  });

  it('passes a raw (prefix-less) Authorization value through verbatim', async () => {
    await principalFromBearerToken(h({ authorization: 'raw_agent_tok' }));
    expect(resolveBearer).toHaveBeenCalledWith('raw_agent_tok');
  });

  it('returns null when the bearer resolves to no token_index row', async () => {
    vi.mocked(resolveBearer).mockResolvedValue(null);
    const p = await principalFromBearerToken(h({ authorization: 'Bearer unknown' }));
    expect(p).toBeNull();
  });

  it('returns the agent principal resolveBearer produces (kind: pi)', async () => {
    const principal = {
      kind: 'pi' as const,
      slug: 'agent-su-1',
      workspaceId: 'ws-active',
      authMethod: 'bearer-token' as const,
      trust: 'trusted' as const,
      capabilities: new Set(['harness:read', 'harness:write']),
      label: 'agent su-1',
    };
    vi.mocked(resolveBearer).mockResolvedValue(principal);
    const p = await principalFromBearerToken(h({ authorization: 'Bearer agent_tok' }));
    expect(p).toBe(principal);
    expect(p!.kind).toBe('pi');
    expect(p!.slug).toBe('agent-su-1');
  });

  it('returns the system principal resolveBearer produces (kind: system)', async () => {
    const principal = {
      kind: 'system' as const,
      slug: 'system:operator',
      workspaceId: 'ws-active',
      authMethod: 'bearer-token' as const,
      trust: 'trusted' as const,
      capabilities: new Set(['*']),
      label: 'operator self',
    };
    vi.mocked(resolveBearer).mockResolvedValue(principal);
    const p = await principalFromBearerToken(h({ authorization: 'Bearer sys_tok' }));
    expect(p).toBe(principal);
    expect(p!.kind).toBe('system');
  });
});
