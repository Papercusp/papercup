/**
 * Unit tests for launchAgent dispatch (Phase 4 / P-030): omp keeps the
 * proven launchOmpAgent path; claude/codex route through launch-su.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchOmpAgentMock = vi.fn(async () => ({ ok: true }));
vi.mock('./native-omp-launch', () => ({
  launchOmpAgent: (...a: unknown[]) => launchOmpAgentMock(...a),
}));

import { launchAgent } from './launch-agent';

const origFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  launchOmpAgentMock.mockResolvedValue({ ok: true });
  // Fresh Response per call — a Response body can only be read once, and
  // launchAgent retries across fallback endpoints (real fetch returns a
  // new response each time).
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = origFetch; });

describe('launchAgent', () => {
  it('defaults to omp → delegates to launchOmpAgent (no fetch)', async () => {
    const r = await launchAgent({ slug: 'papercup', planSlug: 'p', model: 'opus' });
    expect(r.ok).toBe(true);
    expect(launchOmpAgentMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'papercup', planSlug: 'p', model: 'opus' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explicit omp → launchOmpAgent', async () => {
    await launchAgent({ agent: 'omp', slug: null });
    expect(launchOmpAgentMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('claude → POST launch-su with agent + harness + plan', async () => {
    const r = await launchAgent({ agent: 'claude', slug: 'papercup', planSlug: 'my-plan' });
    expect(r.ok).toBe(true);
    expect(launchOmpAgentMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
  });

  it('codex → launch-su; maps psu_not_installed to an install hint', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'error', code: 'psu_not_installed', error: 'no psu' }), { status: 200 }));
    const r = await launchAgent({ agent: 'codex', slug: 'papercup' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('omp_not_installed');
    expect(r.installCmd).toMatch(/install-standalone-mcp/);
  });

  it('claude → surfaces a server error', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'error', error: 'boom' }), { status: 500 }));
    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });
});
