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
    // EI-5678: interactive callers skip host-saturation shedding — a
    // brain-admission-style throttle, not the deterministic ceiling this
    // floor is documented to enforce.
    expect(getSpawnHeadroomMock).toHaveBeenCalledWith('ws-test', { skipHostSaturationShed: true });
  });

  it('REFUSES at the absolute ceiling (headroom 0) with an actionable reason', async () => {
    getSpawnHeadroomMock.mockResolvedValue({ ceiling: 16, running: 16, headroom: 0 });
    const r = await checkInteractiveSafetyFloor();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('safety floor');
    expect(r.reason).toContain('maxSimultaneousAgents');
    expect(r.reason).toContain('16'); // running ≥ ceiling surfaced
  });

  it('EI-5678: requests headroom with skipHostSaturationShed so a host-saturation shed can never produce a self-contradicting "0 ≥ ceiling" refusal', async () => {
    // Regression for the exact repro: getSpawnHeadroom would return
    // running:0, ceiling:8, headroom:0 (shed to zero by host saturation)
    // and the refusal message nonsensically read "0 agent(s) running ≥
    // ceiling 8". With shedding skipped for interactive callers, headroom
    // reaching 0 is only possible via the real count-based ceiling — so we
    // assert the call opts out, and that the mock is never asked to shed.
    getSpawnHeadroomMock.mockResolvedValue({ ceiling: 8, running: 8, headroom: 0 });
    const r = await checkInteractiveSafetyFloor();
    expect(getSpawnHeadroomMock).toHaveBeenCalledWith('ws-test', { skipHostSaturationShed: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('8 agent(s) running ≥ ceiling 8');
  });

  it('fails OPEN when the headroom read fails (never block a human)', async () => {
    // A bad/failed floor read (here undefined → reading `.headroom` throws inside
    // the try) must fail OPEN so a PG hiccup never wedges a human-initiated launch.
    getSpawnHeadroomMock.mockResolvedValue(undefined);
    const r = await checkInteractiveSafetyFloor();
    expect(r.ok).toBe(true);
  });
});
