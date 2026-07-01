/**
 * Unit tests for launchAgent dispatch (agent-launch unification; P-032
 * converged ALL agents onto one path). Every backend POSTs to launch-su
 * with agent + harness + plan + model/resume/kickoff threaded through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchAgent } from './launch-agent';

const origFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh Response per call — a Response body can only be read once, and
  // launchAgent retries across fallback endpoints (real fetch returns a
  // new response each time).
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = origFetch; });

function firstBody(): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

describe('launchAgent', () => {
  it('agent-less launch sends agent:null — launch-su resolves the CONFIGURED backend', async () => {
    const r = await launchAgent({ slug: 'papercup', planSlug: 'p' });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const body = firstBody();
    expect(body.agent).toBeNull();
    expect(body.harness_slug).toBe('papercup');
    expect(body.plan_slug).toBe('p');
  });

  it('omp threads model / resume / kickoff through the body (P-032 parity)', async () => {
    await launchAgent({ agent: 'omp', slug: 'papercup', model: 'opus', resumeSessionId: 's-42', kickoff: { kind: 'new-plan' } });
    const body = firstBody();
    expect(body).toEqual({
      agent: 'omp',
      harness_slug: 'papercup',
      plan_slug: null,
      model: 'opus',
      resume_session_id: 's-42',
      kickoff: { kind: 'new-plan' },
      defer_spawn: false,
      context_size: null,
    });
  });

  it('deferSpawn → body carries defer_spawn:true and returns advSessionId (D-006)', async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok', deferred: true, advSessionId: 77 }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await launchAgent({ agent: 'claude', slug: null, planSlug: 'my-plan', deferSpawn: true });
    expect(r.ok).toBe(true);
    expect(r.advSessionId).toBe(77);
    expect(firstBody().defer_spawn).toBe(true);
  });

  it('claude → POST launch-su', async () => {
    const r = await launchAgent({ agent: 'claude', slug: 'papercup', planSlug: 'my-plan' });
    expect(r.ok).toBe(true);
    const body = firstBody();
    expect(body.agent).toBe('claude');
    expect(body.harness_slug).toBe('papercup');
    expect(body.plan_slug).toBe('my-plan');
  });

  it('codex → launch-su; maps psu_not_installed to an install hint', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'error', code: 'psu_not_installed', error: 'no psu' }), { status: 200 }));
    const r = await launchAgent({ agent: 'codex', slug: 'papercup' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('omp_not_installed');
    expect(r.installCmd).toMatch(/install-standalone-mcp/);
  });

  it('surfaces a server error', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'error', error: 'boom' }), { status: 500 }));
    const r = await launchAgent({ agent: 'claude', slug: 'papercup' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });
});
