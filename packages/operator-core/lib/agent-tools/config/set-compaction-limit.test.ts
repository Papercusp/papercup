/**
 * set-compaction-limit.test.ts — the model-aware clamp (context-trimming-tiers
 * D-001: `limit × 1.2 ≤ window − margin`, spec resolved best-effort; an
 * unresolvable spec clamps to the [1m] ceiling, NOT the conservative 200k → 158k
 * (WI-3383, owner directive 2026-07-08).
 *
 * Since 2026-08-08 this verb is the DELIBERATE SELF-SET path, so its ceiling is
 * `selfSetCeilingForSpec` (825k on [1m]) rather than the SEEDED default
 * (`COMPACTION_LIMIT_DEFAULT_1M_CAP`, 400k) — the two were one constant until then,
 * so "raise it for wide-context work" (this verb's stated purpose) silently clamped
 * back to 400k on the fleet's default spec. Seeding is unchanged at 400k.
 *
 * The self-set ceiling also has a FLEET-ROLE dimension (WI-10002013): a fleet MEMBER
 * is capped at the role cap its leader governs, while a leader/solo session gets the
 * full 825k. Until this was threaded through, `fleetMember` was omitted at both the
 * cap and the spec-clamp call, so `roleCap` resolved to POSITIVE_INFINITY for members
 * and an over-cap request returned ok:true and PERSISTED { explicit: true } — then was
 * silently rewritten to the role cap later by compaction-compliance-watchdog. The
 * FALSE SUCCESS is the defect under test here; the ceiling itself is deliberate policy.
 *
 * Run: testing:run { files: ['packages/operator-core/lib/agent-tools/config/set-compaction-limit.test.ts'] }
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP } from '../../agent-config-constants';

const { setLimitMock, getPresenceMock, specMock, windowMock, fleetMock } = vi.hoisted(() => ({
  // Args typed so `.mock.calls.at(-1)?.[1]` (the echo in beforeEach) typechecks.
  setLimitMock: vi.fn(async (_owner: string, _limit: number) => {}),
  getPresenceMock: vi.fn(),
  specMock: vi.fn(),
  windowMock: vi.fn(),
  fleetMock: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test' }),
}));
vi.mock('../coordination/presence', () => ({
  setCompactionLimit: setLimitMock,
  getPresence: getPresenceMock,
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: fleetMock,
}));
vi.mock('../../compaction-usage', () => ({
  resolveModelSpecForOwner: specMock,
  estimateContextWindowForOwner: windowMock,
}));

const tool = (await import('./set-compaction-limit')).default;
type ToolOut = { data: Record<string, unknown> };

/**
 * The self-set ceiling on a `[1m]` window: `floor((1M − 10k) / 1.2)`. Pinned as a
 * LITERAL rather than derived from `selfSetCeilingForSpec`, so these assertions can
 * actually fail if the helper regresses (mirrors `agent-config-constants.test.ts`).
 */
const SELF_SET_1M_CEILING = 825_000;

/** presence-fleet map for the CALLER themself, shaped as `fetchPresenceFleet` returns it. */
function selfFleetMap(fleetSlug: string | null, fleetRole: string | null) {
  return new Map(fleetSlug ? [['su-test', { fleetSlug, fleetRole }]] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
  windowMock.mockResolvedValue(null);
  // Default: a FLEETLESS session (no row for the caller) ⇒ fleetMember false ⇒ the
  // leader/solo ceiling. Mocked explicitly rather than left to the real module: the
  // production call is `.catch(() => new Map())`, so an unmocked seam would land on
  // the same branch only by THROWING, which makes a green run prove nothing.
  fleetMock.mockResolvedValue(new Map());
  getPresenceMock.mockImplementation(async () => ({
    compactionLimit: setLimitMock.mock.calls.at(-1)?.[1] ?? null,
  }));
});

describe('config:set-compaction-limit runtime validation', () => {
  it('an unresolvable spec rejects a request above the 825k [1m] self-set ceiling, without writing a clamp (WI-3383)', async () => {
    specMock.mockResolvedValue(null);
    const out = (await tool.handler({ limit: 900_000 }, {} as never)) as ToolOut;
    // Still the WI-3383 property: an unknown spec is an opus[1m] session, so the
    // reported ceiling must NOT fall back to the haiku-sized 158k. The runtime
    // setter rejects instead of storing a different value under ok:true.
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(out.data.ok).toBe(false);
    expect(out.data.error).toBe('limit_exceeds_cap');
    expect(out.data.requested).toBe(900_000);
    expect(out.data.cap).toBe(SELF_SET_1M_CEILING);
    expect(out.data.compactionLimit).toBeUndefined();
  });

  it('uses the measured effective window when it is narrower than the spec-derived ceiling', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    windowMock.mockResolvedValue(828_400);
    const out = (await tool.handler({ limit: 800_000 }, {} as never)) as ToolOut;

    // The spec suggests an 825k self-set ceiling, but the live Codex rollout's
    // 828.4k effective window safely permits only 682k after margin/overshoot.
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(out.data).toMatchObject({
      ok: false,
      error: 'limit_exceeds_cap',
      requested: 800_000,
      cap: 682_000,
    });
    expect(out.data.compactionLimit).toBeUndefined();
  });

  it('a [1m] spec allows an ask ABOVE the 400k seeded default: 700k persists verbatim', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    // 700k is the regression this verb's 2026-08-08 fix targets: above the seeded
    // 400k default, inside the 825k window ceiling. Asking below 400k would pass
    // under the OLD clamp too, so it could not detect the defect at all.
    const out = (await tool.handler({ limit: 700_000 }, {} as never)) as ToolOut;
    expect(setLimitMock).toHaveBeenCalledWith('su-test', 700_000, { explicit: true });
    expect(out.data.ok).toBe(true);
    expect(out.data.clamped).toBeUndefined();
    expect(out.data.compactionLimit).toBe(700_000);
  });
});

/**
 * WI-10002013 — the caller's OWN fleet role must reach the self-set ceiling.
 *
 * These three cases are a MIRROR SET and only mean something together: the member
 * case alone would also pass if the verb rejected 700k for everybody, so the leader
 * and fleetless cases are what prove the refusal is role-derived rather than a blanket
 * lowering of the ceiling. Before `fleetMember` was threaded through, the member case
 * returned ok:true and wrote the value — that is the exact assertion that flips.
 */
const OVER_MEMBER_CAP = 700_000;

/**
 * The member-refusal assertion, factored out so that ONE assertion can be run
 * against two subjects: the real handler (which must pass it) and the
 * deliberately-wrong controls below (which must fail it). That pairing is what
 * makes this guard demonstrably falsifiable — see the control block at the
 * bottom of this file.
 *
 * `wrote` is passed rather than read off the mock so a control can exercise the
 * no-write half without having to drive the real module at all.
 */
function assertHonestMemberRefusal(data: unknown, wrote: boolean): void {
  // The no-write half is the point: the pre-fix bug was not a wrong number in the
  // response, it was ok:true PLUS a persisted { explicit: true } value the watchdog
  // then quietly rewrote. A refusal that still wrote would reproduce the defect.
  expect(wrote).toBe(false);
  expect(data).toMatchObject({
    ok: false,
    error: 'limit_exceeds_cap',
    requested: OVER_MEMBER_CAP,
    cap: COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
  });
  expect((data as { compactionLimit?: number }).compactionLimit).toBeUndefined();
}

describe('config:set-compaction-limit fleet-role ceiling (WI-10002013)', () => {
  it('a fleet MEMBER self-raising above the member cap is refused WITHOUT a write', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    fleetMock.mockResolvedValue(selfFleetMap('rocket', 'member'));

    const out = (await tool.handler({ limit: OVER_MEMBER_CAP }, {} as never)) as ToolOut;

    // CALIBRATION for the control block below: the real subject must PASS the very
    // assertion the wrong implementations fail. Without this, controls that pass
    // for the wrong reason would look like a working guard.
    assertHonestMemberRefusal(out.data, setLimitMock.mock.calls.length > 0);
  });

  it('a fleet LEADER at the same value still succeeds (the cap is role-derived, not a blanket lowering)', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    fleetMock.mockResolvedValue(selfFleetMap('rocket', 'leader'));

    const out = (await tool.handler({ limit: OVER_MEMBER_CAP }, {} as never)) as ToolOut;

    expect(setLimitMock).toHaveBeenCalledWith('su-test', OVER_MEMBER_CAP, { explicit: true });
    expect(out.data.ok).toBe(true);
    expect(out.data.compactionLimit).toBe(OVER_MEMBER_CAP);
  });

  it('a FLEETLESS session at the same value still succeeds (no fleet row ⇒ not a member)', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    fleetMock.mockResolvedValue(new Map()); // explicit: the caller has no presence-fleet row

    const out = (await tool.handler({ limit: OVER_MEMBER_CAP }, {} as never)) as ToolOut;

    expect(setLimitMock).toHaveBeenCalledWith('su-test', OVER_MEMBER_CAP, { explicit: true });
    expect(out.data.ok).toBe(true);
    expect(out.data.compactionLimit).toBe(OVER_MEMBER_CAP);
  });
});

/**
 * FALSIFIABILITY CONTROLS — permanent. Do not delete; they are the only evidence
 * that the member-refusal guard above can fail at all.
 *
 * A guard that has never failed is a guard nobody has tested. The repo's usual
 * proof (scripts/mutation-probe.sh) CANNOT reach this subject: the test binds the
 * module with a relative dynamic import (`await import('./set-compaction-limit')`),
 * and every probe tier that substitutes a PATH has no seam to redirect — so the
 * mutant survives and the probe reports "your guard is weak" when in truth it never
 * measured anything. That false-negative instrument reading is recorded as plan
 * decision D-042 on frontier-remediation-...-60d3a8-2026-09-20.
 *
 * So the control lives here instead, which is what CLAUDE.md prescribes for an
 * imported module: keep a deliberately-wrong implementation permanently in the
 * test file, plus a calibration case the real subject must pass (the MEMBER case
 * above calls the identical assertion).
 *
 * Each control reproduces one historically-real way the refusal was dishonest.
 */
describe('config:set-compaction-limit member-refusal guard is falsifiable (controls)', () => {
  it('CONTROL: the pre-fix behaviour (ok:true + a write) FAILS the member assertion', () => {
    // Exactly what the self-set path did before `fleetMember` was threaded through:
    // the member dimension was never consulted, so an over-cap ask was accepted and
    // persisted — and the watchdog silently reverted it afterwards.
    const preFix = { ok: true, compactionLimit: OVER_MEMBER_CAP };

    expect(() => assertHonestMemberRefusal(preFix, true)).toThrow();
  });

  it('CONTROL: a correctly-shaped refusal that STILL WROTE fails it too', () => {
    // The subtler regression: the response says no while the value is persisted
    // anyway. Response-only assertions would pass this; the no-write half is what
    // catches it, so it is asserted separately here.
    const refusedButWrote = {
      ok: false,
      error: 'limit_exceeds_cap',
      requested: OVER_MEMBER_CAP,
      cap: COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
    };

    expect(() => assertHonestMemberRefusal(refusedButWrote, true)).toThrow();
  });

  it('CONTROL: refusing with the WRONG cap (the leader/1m ceiling) fails it', () => {
    // A refusal that quotes 825k tells a member the wrong number, which is the
    // dishonest-refusal defect this work-item exists to fix — not merely a
    // cosmetic difference.
    const wrongCap = {
      ok: false,
      error: 'limit_exceeds_cap',
      requested: OVER_MEMBER_CAP,
      cap: 825_000,
    };

    expect(() => assertHonestMemberRefusal(wrongCap, false)).toThrow();
  });
});
