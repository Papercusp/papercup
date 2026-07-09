/**
 * owner-steering — contract C-1 store (queen-steering-panel-2026-06-15 B-01).
 *
 * The hive_settings KV is mocked at the module boundary, so this exercises the C-1
 * DECODE / DEFAULT / normalize logic + the write-patch fan-out without PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `...args` so the mock factory's `(...a) => fn(...a)` spreads type-check + `.mock.calls` index.
const listHiveSettings = vi.fn<(...a: unknown[]) => unknown>();
const setHiveSetting = vi.fn(async (..._a: unknown[]) => ({}));
const deleteHiveSetting = vi.fn(async (..._a: unknown[]) => {});

vi.mock('./hive-settings-store', () => ({
  listHiveSettings: (...a: unknown[]) => listHiveSettings(...a),
  setHiveSetting: (...a: unknown[]) => setHiveSetting(...a),
  deleteHiveSetting: (...a: unknown[]) => deleteHiveSetting(...a),
}));

import {
  getOwnerSteering,
  setOwnerSteering,
  isPausedNow,
  DEFAULT_OWNER_STEERING,
  OWNER_STEERING_KEYS,
  effectiveCadenceFloorSec,
  effectiveMaxBees,
  idleActivityEnabled,
  isAutoScaleOutEnabled,
  hasActiveThrottle,
  IDLE_ACTIVITY_KINDS,
  directiveSuggestsResume,
  steeringLooksInconsistent,
  type OwnerSteering,
} from './owner-steering';

function rows(map: Record<string, unknown>) {
  return Object.entries(map).map(([settingKey, value]) => ({ settingKey, value }));
}

beforeEach(() => {
  listHiveSettings.mockReset();
  setHiveSetting.mockReset().mockResolvedValue({});
  deleteHiveSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('getOwnerSteering — decode + defaults', () => {
  it('an un-steered Hive (no keys) returns the default no-restriction state', async () => {
    listHiveSettings.mockResolvedValue([]);
    expect(await getOwnerSteering('ws', 'hive')).toEqual(DEFAULT_OWNER_STEERING);
  });

  it('includeUnplannedWork: absent ⇒ true (loose work placed); explicit false ⇒ false', async () => {
    listHiveSettings.mockResolvedValue([]);
    expect((await getOwnerSteering('ws', 'hive')).includeUnplannedWork).toBe(true);
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.includeUnplannedWork]: false }));
    expect((await getOwnerSteering('ws', 'hive')).includeUnplannedWork).toBe(false);
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.includeUnplannedWork]: true }));
    expect((await getOwnerSteering('ws', 'hive')).includeUnplannedWork).toBe(true);
  });

  it('setOwnerSteering persists includeUnplannedWork:false', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { includeUnplannedWork: false });
    expect(setHiveSetting).toHaveBeenCalledWith(
      expect.objectContaining({ settingKey: OWNER_STEERING_KEYS.includeUnplannedWork, value: false }),
      undefined,
    );
  });

  it('decodes a fully-set steering state', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.directive]: 'focus on the migration',
        [OWNER_STEERING_KEYS.eligiblePlans]: ['plan-a', 'plan-b'],
        [OWNER_STEERING_KEYS.pauseNewWork]: true,
        [OWNER_STEERING_KEYS.pausedUntil]: 1_900_000_000_000,
      }),
    );
    expect(await getOwnerSteering('ws', 'hive')).toEqual({
      directive: 'focus on the migration',
      eligiblePlans: ['plan-a', 'plan-b'],
      eligibleHives: [],
      includeUnplannedWork: true,
      pauseNewWork: true,
      pausedUntil: 1_900_000_000_000,
      modelTiers: null,
      tierCeilings: null,
      cadenceFloorSec: null,
      maxBees: null,
      idleActivities: null,
      autoScaleOut: null,
      decomposition: null,
      modelOverrides: null,
      federatedPriming: null,
    } satisfies OwnerSteering);
  });

  it('decodes per-role model overrides (sentinel/overwatch), dropping blank specs', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.modelOverrides]: { sentinel: 'opus:high', overwatch: 'sonnet', queen: '  ' },
      }),
    );
    // Blank/whitespace specs are dropped; valid ones are trimmed-through.
    expect((await getOwnerSteering('ws', 'hive')).modelOverrides).toEqual({
      sentinel: 'opus:high',
      overwatch: 'sonnet',
    });
  });

  it('treats an empty / all-blank model-override map as no override (null)', async () => {
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.modelOverrides]: { queen: '' } }));
    expect((await getOwnerSteering('ws', 'hive')).modelOverrides).toBeNull();
  });

  it('decodes a model-tier session override (D-006) + drops malformed tiers', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.modelTiers]: [{ name: 'fast', spec: 'haiku' }, { name: 'bad' }, { spec: 'no-name' }],
        [OWNER_STEERING_KEYS.tierCeilings]: { worker: 'opus', '': '', queen: 7 },
      }),
    );
    const s = await getOwnerSteering('ws', 'hive');
    expect(s.modelTiers).toEqual([{ name: 'fast', spec: 'haiku' }]);
    expect(s.tierCeilings).toEqual({ worker: 'opus' });
  });

  it('writes the model-tier override when provided (D-006)', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { modelTiers: [{ name: 'fast', spec: 'opus:xhigh' }] });
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', potHomeSlug: 'hive', settingKey: OWNER_STEERING_KEYS.modelTiers, value: [{ name: 'fast', spec: 'opus:xhigh' }] },
      undefined,
    );
  });

  it('decodes eligibleHives (the placement scope, B-04 round-2)', async () => {
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.eligibleHives]: ['hive-a', 'hive-b'] }));
    expect((await getOwnerSteering('ws', 'hive')).eligibleHives).toEqual(['hive-a', 'hive-b']);
  });

  it('is fail-soft on junk values — each bad key falls back to its default', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.directive]: '   ', // whitespace-only ⇒ null
        [OWNER_STEERING_KEYS.eligiblePlans]: 'not-an-array', // ⇒ []
        [OWNER_STEERING_KEYS.pauseNewWork]: 'true', // string, not boolean true ⇒ false
        [OWNER_STEERING_KEYS.pausedUntil]: 'whenever', // ⇒ null
      }),
    );
    expect(await getOwnerSteering('ws', 'hive')).toEqual(DEFAULT_OWNER_STEERING);
  });

  it('keeps only string entries in eligiblePlans', async () => {
    listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.eligiblePlans]: ['ok', 3, null, 'also'] }));
    expect((await getOwnerSteering('ws', 'hive')).eligiblePlans).toEqual(['ok', 'also']);
  });
});

describe('setOwnerSteering — write fan-out', () => {
  it('writes ONLY the provided fields (omitted left untouched)', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { pauseNewWork: true });
    expect(setHiveSetting).toHaveBeenCalledTimes(1);
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', potHomeSlug: 'hive', settingKey: OWNER_STEERING_KEYS.pauseNewWork, value: true },
      undefined,
    );
    expect(deleteHiveSetting).not.toHaveBeenCalled();
  });

  it('EI-8277: a bare pause write clears a stale resume-language directive', async () => {
    listHiveSettings
      .mockResolvedValueOnce(
        rows({
          [OWNER_STEERING_KEYS.directive]:
            'Gate hold lifted at 2026-07-05T21:36Z; resume normal autonomous placement',
          [OWNER_STEERING_KEYS.pauseNewWork]: false,
        }),
      )
      .mockResolvedValueOnce([]);

    await setOwnerSteering('ws', 'hive', { pauseNewWork: true });

    const wrote = Object.fromEntries(
      setHiveSetting.mock.calls.map((c) => [
        (c[0] as { settingKey: string }).settingKey,
        (c[0] as { value: unknown }).value,
      ]),
    );
    expect(wrote[OWNER_STEERING_KEYS.directive]).toBeNull();
    expect(wrote[OWNER_STEERING_KEYS.pauseNewWork]).toBe(true);
  });

  it('EI-8277: an explicit directive is honored even when pausing', async () => {
    listHiveSettings.mockResolvedValue([]);

    await setOwnerSteering('ws', 'hive', {
      directive: 'Incident hold: start no new work.',
      pauseNewWork: true,
    });

    const wrote = Object.fromEntries(
      setHiveSetting.mock.calls.map((c) => [
        (c[0] as { settingKey: string }).settingKey,
        (c[0] as { value: unknown }).value,
      ]),
    );
    expect(wrote[OWNER_STEERING_KEYS.directive]).toBe('Incident hold: start no new work.');
    expect(wrote[OWNER_STEERING_KEYS.pauseNewWork]).toBe(true);
  });

  it('writes every provided field with the normalized value', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', {
      directive: 'x',
      eligiblePlans: ['p1'],
      pauseNewWork: false,
      pausedUntil: 123,
    });
    const wrote = setHiveSetting.mock.calls.map((c) => [(c[0] as { settingKey: string }).settingKey, (c[0] as { value: unknown }).value]);
    expect(wrote).toEqual([
      [OWNER_STEERING_KEYS.directive, 'x'],
      [OWNER_STEERING_KEYS.eligiblePlans, ['p1']],
      [OWNER_STEERING_KEYS.pauseNewWork, false],
      [OWNER_STEERING_KEYS.pausedUntil, 123],
    ]);
  });

  it('writes eligibleHives (the placement scope) when provided (B-04 round-2)', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { eligibleHives: ['hive-a', 'hive-b'] });
    expect(setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', potHomeSlug: 'hive', settingKey: OWNER_STEERING_KEYS.eligibleHives, value: ['hive-a', 'hive-b'] },
      undefined,
    );
  });

  it('normalizes a blank directive + bad pausedUntil to the cleared value on write', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { directive: '  ', pausedUntil: Number.NaN });
    const wrote = Object.fromEntries(setHiveSetting.mock.calls.map((c) => [(c[0] as { settingKey: string }).settingKey, (c[0] as { value: unknown }).value]));
    expect(wrote[OWNER_STEERING_KEYS.directive]).toBeNull();
    expect(wrote[OWNER_STEERING_KEYS.pausedUntil]).toBeNull();
  });

  it('clear:true deletes ALL steering keys and returns the default', async () => {
    const out = await setOwnerSteering('ws', 'hive', { clear: true });
    expect(deleteHiveSetting).toHaveBeenCalledTimes(Object.keys(OWNER_STEERING_KEYS).length);
    expect(deleteHiveSetting.mock.calls.map((c) => c[2])).toEqual(Object.values(OWNER_STEERING_KEYS));
    expect(setHiveSetting).not.toHaveBeenCalled();
    expect(out).toEqual(DEFAULT_OWNER_STEERING);
  });
});

describe('isPausedNow', () => {
  const base = DEFAULT_OWNER_STEERING;
  it('explicit pauseNewWork pauses regardless of time', () => {
    expect(isPausedNow({ ...base, pauseNewWork: true }, 1_000)).toBe(true);
  });
  it('an un-expired pausedUntil pauses; an elapsed one does not', () => {
    expect(isPausedNow({ ...base, pausedUntil: 2_000 }, 1_000)).toBe(true);
    expect(isPausedNow({ ...base, pausedUntil: 2_000 }, 2_000)).toBe(false);
    expect(isPausedNow({ ...base, pausedUntil: 2_000 }, 3_000)).toBe(false);
  });
  it('the default state is never paused', () => {
    expect(isPausedNow(base, 9_999)).toBe(false);
  });
});

// ── Throttle knobs (queen-steering-panel P-006 / P-009) ──────────────────────

describe('throttle-knob decode (P-006)', () => {
  it('decodes a fully-set throttle steering state', async () => {
    listHiveSettings.mockResolvedValue(
      rows({
        [OWNER_STEERING_KEYS.cadenceFloorSec]: 420,
        [OWNER_STEERING_KEYS.maxBees]: 5,
        [OWNER_STEERING_KEYS.idleActivities]: { gym: false, scout: true, curation: false },
        [OWNER_STEERING_KEYS.autoScaleOut]: false,
        [OWNER_STEERING_KEYS.decomposition]: 'parallel',
      }),
    );
    const s = await getOwnerSteering('ws', 'hive');
    expect(s.cadenceFloorSec).toBe(420);
    expect(s.maxBees).toBe(5);
    expect(s.idleActivities).toEqual({ gym: false, scout: true, curation: false });
    expect(s.autoScaleOut).toBe(false);
    expect(s.decomposition).toBe('parallel');
  });

  it('cadenceFloorSec: a positive number decodes; 0 / negative / NaN ⇒ null', async () => {
    const read = async (v: unknown) => {
      listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.cadenceFloorSec]: v }));
      return (await getOwnerSteering('ws', 'hive')).cadenceFloorSec;
    };
    expect(await read(420)).toBe(420);
    expect(await read(0)).toBeNull();
    expect(await read(-5)).toBeNull();
    expect(await read('420')).toBeNull();
  });

  it('maxBees: a finite int ≥1 decodes (floored); <1 / non-finite ⇒ null', async () => {
    const read = async (v: unknown) => {
      listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.maxBees]: v }));
      return (await getOwnerSteering('ws', 'hive')).maxBees;
    };
    expect(await read(5)).toBe(5);
    expect(await read(5.9)).toBe(5); // floored
    expect(await read(0)).toBeNull();
    expect(await read(-3)).toBeNull();
    expect(await read('5')).toBeNull();
  });

  it('idleActivities: keeps only boolean known-kind entries; empty/junk ⇒ null', async () => {
    const read = async (v: unknown) => {
      listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.idleActivities]: v }));
      return (await getOwnerSteering('ws', 'hive')).idleActivities;
    };
    expect(await read({ gym: false, scout: 'yes', other: true })).toEqual({ gym: false });
    expect(await read({})).toBeNull();
    expect(await read([])).toBeNull();
    expect(await read('nope')).toBeNull();
  });

  it('autoScaleOut: a boolean decodes; anything else ⇒ null (default enabled)', async () => {
    const read = async (v: unknown) => {
      listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.autoScaleOut]: v }));
      return (await getOwnerSteering('ws', 'hive')).autoScaleOut;
    };
    expect(await read(false)).toBe(false);
    expect(await read(true)).toBe(true);
    expect(await read('false')).toBeNull();
  });

  it('decomposition: a known mode decodes; junk ⇒ null', async () => {
    const read = async (v: unknown) => {
      listHiveSettings.mockResolvedValue(rows({ [OWNER_STEERING_KEYS.decomposition]: v }));
      return (await getOwnerSteering('ws', 'hive')).decomposition;
    };
    expect(await read('serial')).toBe('serial');
    expect(await read('balanced')).toBe('balanced');
    expect(await read('parallel')).toBe('parallel');
    expect(await read('aggressive')).toBeNull();
    expect(await read(3)).toBeNull();
  });
});

describe('throttle-knob write fan-out (P-006)', () => {
  it('writes the throttle knobs with normalized values', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', {
      cadenceFloorSec: 420,
      maxBees: 5,
      idleActivities: { gym: false },
      autoScaleOut: false,
      decomposition: 'serial',
    });
    const wrote = Object.fromEntries(
      setHiveSetting.mock.calls.map((c) => [(c[0] as { settingKey: string }).settingKey, (c[0] as { value: unknown }).value]),
    );
    expect(wrote[OWNER_STEERING_KEYS.cadenceFloorSec]).toBe(420);
    expect(wrote[OWNER_STEERING_KEYS.maxBees]).toBe(5);
    expect(wrote[OWNER_STEERING_KEYS.idleActivities]).toEqual({ gym: false });
    expect(wrote[OWNER_STEERING_KEYS.autoScaleOut]).toBe(false);
    expect(wrote[OWNER_STEERING_KEYS.decomposition]).toBe('serial');
  });

  it('normalizes a bad maxBees (0) + bad cadence (-1) to cleared (null) on write', async () => {
    listHiveSettings.mockResolvedValue([]);
    await setOwnerSteering('ws', 'hive', { maxBees: 0, cadenceFloorSec: -1 });
    const wrote = Object.fromEntries(
      setHiveSetting.mock.calls.map((c) => [(c[0] as { settingKey: string }).settingKey, (c[0] as { value: unknown }).value]),
    );
    expect(wrote[OWNER_STEERING_KEYS.maxBees]).toBeNull();
    expect(wrote[OWNER_STEERING_KEYS.cadenceFloorSec]).toBeNull();
  });
});

describe('throttle accessors (P-006)', () => {
  const base = DEFAULT_OWNER_STEERING;

  it('effectiveCadenceFloorSec is MAX(system, owner) — owner only RAISES', () => {
    expect(effectiveCadenceFloorSec(base, 60)).toBe(60); // no override
    expect(effectiveCadenceFloorSec({ ...base, cadenceFloorSec: 420 }, 60)).toBe(420); // raised
    expect(effectiveCadenceFloorSec({ ...base, cadenceFloorSec: 30 }, 60)).toBe(60); // can't drop below system
  });

  it('effectiveMaxBees is MIN(system, owner) — owner only LOWERS', () => {
    expect(effectiveMaxBees(base, 16)).toBe(16); // no override
    expect(effectiveMaxBees({ ...base, maxBees: 5 }, 16)).toBe(5); // lowered
    expect(effectiveMaxBees({ ...base, maxBees: 99 }, 16)).toBe(16); // can't exceed system
  });

  it('idleActivityEnabled defaults ON; only explicit false suppresses', () => {
    expect(idleActivityEnabled(base, 'gym')).toBe(true);
    expect(idleActivityEnabled({ ...base, idleActivities: { gym: false } }, 'gym')).toBe(false);
    expect(idleActivityEnabled({ ...base, idleActivities: { gym: false } }, 'scout')).toBe(true);
    expect(idleActivityEnabled({ ...base, idleActivities: { scout: true } }, 'scout')).toBe(true);
  });

  it('plan-review is a registered idle-activity kind that gates the Queen↔Scout feedback loop (queen-scout-feedback-loop-2026-06-20 D-003 #2)', () => {
    // The kind exists, so the Queen's idle review-iteration of Scout drafts is a
    // real, owner-toggleable gate — not just prose in the persona.
    expect(IDLE_ACTIVITY_KINDS).toContain('plan-review');
    // Defaults ON (review runs on idle wakes unless the owner turns it off)…
    expect(idleActivityEnabled(base, 'plan-review')).toBe(true);
    // …and an explicit false suppresses ONLY plan-review, leaving the others ON.
    const off = { ...base, idleActivities: { 'plan-review': false } as const };
    expect(idleActivityEnabled(off, 'plan-review')).toBe(false);
    expect(idleActivityEnabled(off, 'scout')).toBe(true);
    expect(idleActivityEnabled(off, 'gym')).toBe(true);
    // An OFF plan-review counts as an active throttle (surfaces in the wake brief).
    expect(hasActiveThrottle(off)).toBe(true);
    expect(hasActiveThrottle({ ...base, idleActivities: { 'plan-review': true } })).toBe(false); // ON is default
  });

  it('isAutoScaleOutEnabled defaults ON; only explicit false disables', () => {
    expect(isAutoScaleOutEnabled(base)).toBe(true);
    expect(isAutoScaleOutEnabled({ ...base, autoScaleOut: true })).toBe(true);
    expect(isAutoScaleOutEnabled({ ...base, autoScaleOut: false })).toBe(false);
  });

  it('hasActiveThrottle is false at default, true when any knob is set', () => {
    expect(hasActiveThrottle(base)).toBe(false);
    expect(hasActiveThrottle({ ...base, cadenceFloorSec: 120 })).toBe(true);
    expect(hasActiveThrottle({ ...base, maxBees: 4 })).toBe(true);
    expect(hasActiveThrottle({ ...base, autoScaleOut: false })).toBe(true);
    expect(hasActiveThrottle({ ...base, autoScaleOut: true })).toBe(false); // ON is the default — not "active"
    expect(hasActiveThrottle({ ...base, idleActivities: { gym: false } })).toBe(true);
    expect(hasActiveThrottle({ ...base, idleActivities: { gym: true } })).toBe(false); // ON is default
    expect(hasActiveThrottle({ ...base, decomposition: 'parallel' })).toBe(true);
    expect(hasActiveThrottle({ ...base, tierCeilings: { bee: 'opus:xhigh' } })).toBe(true);
  });
});

describe('directiveSuggestsResume / steeringLooksInconsistent (EI-8277 drift nudge)', () => {
  const base = DEFAULT_OWNER_STEERING;

  it('null / blank / unrelated directive text never suggests resume', () => {
    expect(directiveSuggestsResume(null)).toBe(false);
    expect(directiveSuggestsResume('')).toBe(false);
    expect(directiveSuggestsResume('Focus only on the billing plan this week.')).toBe(false);
  });

  it('resume-language directive text is detected (the exact EI-8277 repro string included)', () => {
    expect(directiveSuggestsResume('Gate hold lifted at 2026-07-05T21:36Z; resume normal autonomous placement')).toBe(
      true,
    );
    expect(directiveSuggestsResume('Pause is over, go ahead.')).toBe(true);
    expect(directiveSuggestsResume('The hold has been released.')).toBe(true);
    expect(directiveSuggestsResume('Unpausing now.')).toBe(true);
  });

  it('steeringLooksInconsistent is true ONLY when pauseNewWork is still true alongside resume language', () => {
    // Resume language but the gate already reflects it (pauseNewWork false) — consistent, no nudge.
    expect(
      steeringLooksInconsistent({ ...base, pauseNewWork: false, directive: 'Gate hold lifted; resume normal placement' }),
    ).toBe(false);
    // Resume language while the hard gate is STILL true — the drift EI-8277 flags.
    expect(
      steeringLooksInconsistent({ ...base, pauseNewWork: true, directive: 'Gate hold lifted; resume normal placement' }),
    ).toBe(true);
    // Paused with a directive that doesn't imply resume — not a contradiction, no nudge.
    expect(steeringLooksInconsistent({ ...base, pauseNewWork: true, directive: 'Investigating an incident.' })).toBe(
      false,
    );
    // Paused with no directive at all — nothing to contradict.
    expect(steeringLooksInconsistent({ ...base, pauseNewWork: true, directive: null })).toBe(false);
  });
});
