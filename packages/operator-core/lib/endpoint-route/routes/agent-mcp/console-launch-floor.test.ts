/**
 * console-launch-floor.test.ts — the interactive-launch safety floor
 * (unify-agent-spawn-chokepoint P-012 / D-013 residual 3, "waiver-with-safety-floor").
 *
 * A human-initiated console WAIVES brain admission but STILL passes the
 * deterministic safety floor (the absolute concurrency ceiling). These lock:
 *   - headroom available → ok (launch proceeds, admission waived);
 *   - over ceiling → refused with an actionable reason (the floor has teeth);
 *   - headroom read throws → fail-OPEN (never block a human on a floor-read error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSpawnHeadroomMock } = vi.hoisted(() => ({ getSpawnHeadroomMock: vi.fn() }));

// The helper lazy-imports fleet/operator-spawn; mock it (same relative path the
// source uses, since this test is colocated under routes/agent-mcp/).
vi.mock('../../../fleet/operator-spawn', () => ({ getSpawnHeadroom: getSpawnHeadroomMock }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { checkInteractiveSafetyFloor } from './console-launch';

beforeEach(() => getSpawnHeadroomMock.mockReset());

describe('checkInteractiveSafetyFloor (P-012 / D-013 residual 3)', () => {
  it('passes when there is headroom (admission waived, floor clear)', async () => {
    getSpawnHeadroomMock.mockResolvedValue({ ceiling: 16, running: 4, headroom: 12 });
    const r = await checkInteractiveSafetyFloor();
    expect(r.ok).toBe(true);
    expect(getSpawnHeadroomMock).toHaveBeenCalledWith('ws-test');
  });

  it('REFUSES at the absolute ceiling (headroom 0) with an actionable reason', async () => {
    getSpawnHeadroomMock.mockResolvedValue({ ceiling: 16, running: 16, headroom: 0 });
    const r = await checkInteractiveSafetyFloor();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('safety floor');
    expect(r.reason).toContain('maxSimultaneousAgents');
    expect(r.reason).toContain('16'); // running ≥ ceiling surfaced
  });

  it('fails OPEN when the headroom read fails (never block a human)', async () => {
    // A bad/failed floor read (here undefined → reading `.headroom` throws inside
    // the try) must fail OPEN so a PG hiccup never wedges a human-initiated launch.
    getSpawnHeadroomMock.mockResolvedValue(undefined);
    const r = await checkInteractiveSafetyFloor();
    expect(r.ok).toBe(true);
  });
});
