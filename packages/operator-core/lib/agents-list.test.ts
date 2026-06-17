/**
 * F-C2 (app-wide-load-traps): the no-slug agent walk must BOUND its fan-out.
 * It was a serial for-loop (70 round-trips back-to-back), then an unbounded
 * `Promise.all` (70 simultaneous loopback fetches, each an agent_chats:list
 * query). listAgentsAcrossWorkspace now caps concurrency at 8.
 *
 * `loopback-fetch` is mocked to count simultaneous in-flight per-slug fetches
 * and record the peak; the projects endpoint feeds the slug list. The module's
 * 10s cross-call cache is reset between tests (it lives on a Symbol.for key).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inFlight: 0,
  peak: 0,
  slugs: [] as string[],
  responder: (_slug: string): Array<{ role: string; updated_at: string }> => [
    { role: 'worker', updated_at: '2026-01-01' },
  ],
}));

vi.mock('./loopback-fetch', () => ({
  loopbackFetch: async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/harness/projects')) return { ok: true } as unknown as Response;
    const m = u.match(/\/api\/harness\/([^/]+)\/agent-chats/);
    const slug = m ? decodeURIComponent(m[1]) : '';
    h.inFlight++;
    h.peak = Math.max(h.peak, h.inFlight);
    // Hold the "connection" open so concurrent fetches genuinely overlap.
    await new Promise((r) => setTimeout(r, 5));
    h.inFlight--;
    return { ok: true, json: async () => ({ chats: h.responder(slug) }) } as unknown as Response;
  },
  readJsonBody: async () => ({ projects: h.slugs.map((slug) => ({ slug })) }),
}));

import { listAgentsAcrossWorkspace } from './agents-list';

const CACHE_KEY = Symbol.for('papercusp.agentsAcrossWorkspaceCache');
function resetCache() {
  const g = globalThis as unknown as Record<symbol, { expires: number; inflight: unknown; value: unknown } | undefined>;
  const c = g[CACHE_KEY];
  if (c) {
    c.expires = 0;
    c.inflight = null;
    c.value = null;
  }
}

beforeEach(() => {
  h.inFlight = 0;
  h.peak = 0;
  h.slugs = [];
  h.responder = () => [{ role: 'worker', updated_at: '2026-01-01' }];
  resetCache();
});

describe('listAgentsAcrossWorkspace — bounded fan-out (F-C2)', () => {
  it('caps concurrent per-slug fetches at 8 for a large registry', async () => {
    for (let i = 0; i < 70; i++) h.slugs.push(`h${i}`);
    const rows = await listAgentsAcrossWorkspace({ limit: 1000 });
    // Genuinely parallel (not serial-one-at-a-time) ...
    expect(h.peak).toBeGreaterThan(1);
    // ... but never blows past the cap.
    expect(h.peak).toBeLessThanOrEqual(8);
    // Aggregation still ran end-to-end: one AgentRow per slug.
    expect(rows.length).toBe(70);
  });

  it('single-slug path aggregates by role + tracks max last_active', async () => {
    h.responder = () => [
      { role: 'worker', updated_at: '2026-01-02' },
      { role: 'worker', updated_at: '2026-01-05' },
      { role: 'scoper', updated_at: '2026-01-03' },
    ];
    const rows = await listAgentsAcrossWorkspace({ slug: 'sheets', limit: 10 });
    const worker = rows.find((r) => r.role === 'worker');
    const scoper = rows.find((r) => r.role === 'scoper');
    expect(worker?.chat_count).toBe(2);
    expect(worker?.last_active).toBe('2026-01-05'); // max, not last-seen
    expect(scoper?.chat_count).toBe(1);
    // sorted by last_active desc → worker (01-05) before scoper (01-03)
    expect(rows[0].role).toBe('worker');
  });
});
