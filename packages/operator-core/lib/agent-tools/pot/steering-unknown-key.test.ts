/**
 * pot:set-steering / pot:get-steering — unrecognized top-level keys must fail
 * loudly (WI-4339; EI-8285 pattern, same as plans:new and cup:spawn).
 *
 * THE INCIDENT (owner-reported 2026-07-12): every steering write from the Mug
 * tab silently failed with the misleading error
 *
 *     "Pass `pot` (or set PAPERCUSP_POT_HOME_SLUG) — steering is per-pot."
 *
 * even though the SPA *was* resolving a home pot and passing it. Cause: the
 * hive→pot rename renamed the tool's arg (`hive` → `pot`) but NOT the SPA
 * callers (MugTab.tsx, useModelOverride.ts), which kept sending `{ hive: home }`.
 * zod's default z.object() SILENTLY STRIPS unknown keys, so `args.pot` arrived
 * `undefined`, resolvePotHomeSlug() fell through to null, and the tool reported
 * "no home pot" — pointing at the wrong thing entirely. The unit tests missed it
 * because they asserted the SPA's own (stale) output shape (`args.hive`) rather
 * than the shape the tool actually accepts, so they stayed green while the
 * feature was 100% broken.
 *
 * `.strict()` turns that class into a loud invalid_args at the point of the typo:
 * a stale/renamed/misspelled arg can never again be silently dropped into a
 * confusing downstream "no home pot".
 *
 * (Pure schema test — no PG / lock fixture.)
 */
import { describe, expect, it } from 'vitest';
import setSteering from './set_steering';
import getSteering from './get_steering';

type Schema = { safeParse: (v: unknown) => { success: boolean } };
const setArgs = (setSteering as unknown as { args: Schema }).args;
const getArgs = (getSteering as unknown as { args: Schema }).args;

describe('pot:set-steering unknown-key rejection (WI-4339)', () => {
  it('accepts the declared pot arg', () => {
    expect(setArgs.safeParse({ pot: 'papercusp', directive: 'focus on X' }).success).toBe(true);
  });

  it('REJECTS the exact regression case: the pre-rename `hive` key', () => {
    // Pre-fix: `hive` was stripped, args.pot became undefined, and the tool
    // returned no_home_harness — the owner-visible bug. Post-fix: loud reject.
    expect(setArgs.safeParse({ hive: 'papercusp', directive: 'focus on X' }).success).toBe(false);
  });

  it('REJECTS any other unrecognized top-level key', () => {
    expect(setArgs.safeParse({ pot: 'papercusp', bogus: true }).success).toBe(false);
  });

  it('REJECTS the other two stale pre-rename arg names the SPA was still sending', () => {
    // The same hive→pot / bee→cup rename pass also renamed these two. The SPA
    // kept sending the old names, zod stripped them, and the Mug's placement-scope
    // picker + max-concurrency knob silently did NOTHING (no error at all — this
    // pair was even harder to spot than the `hive` one, which at least errored).
    expect(setArgs.safeParse({ pot: 'papercusp', eligibleHives: ['pot-a'] }).success).toBe(false);
    expect(setArgs.safeParse({ pot: 'papercusp', maxBees: 4 }).success).toBe(false);
  });

  it('still accepts the documented steering knobs', () => {
    expect(
      setArgs.safeParse({
        pot: 'papercusp',
        eligiblePlans: ['plan-a'],
        eligiblePots: ['pot-a'],
        includeUnplannedWork: false,
        pauseNewWork: true,
        pausedUntil: null,
        cadenceFloorSec: 120,
        maxCups: 4,
        decomposition: 'balanced',
        clear: false,
      }).success,
    ).toBe(true);
  });
});

describe('pot:get-steering unknown-key rejection (WI-4339)', () => {
  it('accepts the declared pot arg', () => {
    expect(getArgs.safeParse({ pot: 'papercusp' }).success).toBe(true);
  });

  it('REJECTS the pre-rename `hive` key', () => {
    expect(getArgs.safeParse({ hive: 'papercusp' }).success).toBe(false);
  });
});
