/**
 * callPlansReadRaw contract pins (WI-5078).
 *
 * The in-process plans READ dispatch feeds the admin Plans routes and the
 * @papercusp/sync named-query resolvers — i.e. the operator UI. Those
 * consumers have no model-context budget and no MCP result cap, so the
 * dispatch must request the EXPLICIT full payload tier: without it, the
 * payload-tier HARD CEILING force-trims any >30KB shaper-tool result, and
 * plans:attention (~1.1MB) came back as item-less group summaries that
 * normalizeAttentionGroups dropped — blanking the Queue, the Overview
 * needs-you tiles, and the left-sidebar Inbox (EI-13037).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  calls: [] as Array<{ pathname: string; body: Record<string, unknown> }>,
  /** When set, the mock returns this JSON as the tool's text envelope for the
   *  next call (else the default `{ ok: true }`). */
  nextResult: null as unknown,
}));

vi.mock('@papercusp/agent-mcp', () => ({
  handleHttpToolRequest: vi.fn(async (req: { pathname: string; body: Record<string, unknown> }) => {
    H.calls.push({ pathname: req.pathname, body: req.body });
    const payload = H.nextResult ?? { ok: true };
    H.nextResult = null;
    return {
      status: 200,
      body: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    };
  }),
}));
// The real module side-effect-imports the whole first-party tool catalog —
// irrelevant to this contract and heavy; stub it.
vi.mock('../index', () => ({}));
vi.mock('../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));

import { callPlansReadRaw } from './read-dispatch';

beforeEach(() => {
  H.calls = [];
  H.nextResult = null;
});

describe('callPlansReadRaw payload-tier contract (WI-5078)', () => {
  it('requests the EXPLICIT full tier so the hard ceiling cannot trim UI reads', async () => {
    await callPlansReadRaw('attention', {});
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].pathname).toBe('/api/agent-tools/plans/attention');
    expect(H.calls[0].body.payloadTier).toBe('full');
  });

  it('keeps a caller-specified payloadTier (opt-in shaped reads stay possible)', async () => {
    await callPlansReadRaw('attention', { payloadTier: 'trimmed' });
    expect(H.calls[0].body.payloadTier).toBe('trimmed');
  });
});

describe('callPlansReadRaw UI display projection (P-005)', () => {
  it('applies the plans:items slim (clips item.text, drops coverage) to the returned data', async () => {
    H.nextResult = {
      items: [
        { plan: 'p', archived: false, coverage: { level: 'full' }, item: { id: 'P-1', text: 'y'.repeat(1000) } },
      ],
    };
    const r = await callPlansReadRaw('items', {});
    const data = r.data as { items: Array<{ coverage?: unknown; item: { text: string } }> };
    expect(data.items[0]).not.toHaveProperty('coverage');
    expect(data.items[0].item.text.length).toBe(280);
    expect(data.items[0].item.text).toMatch(/…$/);
  });

  it('leaves plans:attention data unprojected (WI-5078 — bodies must survive)', async () => {
    const att = { groups: [{ key: 'g', items: [{ id: 'a', body: 'z'.repeat(2000) }] }] };
    H.nextResult = att;
    const r = await callPlansReadRaw('attention', {});
    expect(r.data).toEqual(att);
  });
});
