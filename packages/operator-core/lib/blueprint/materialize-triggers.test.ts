import { describe, it, expect } from 'vitest';
import {
  triggerRoutineSpecs,
  DEFAULT_SCHEDULE_ACTION,
  SINGLETON_TRIGGER_HOST_SLUG,
  SCOUT_SINGLETON_CYCLE_TIMEOUT_MS,
  singletonRoutinePayloadDefaults,
} from './materialize-triggers';

describe('triggerRoutineSpecs (P-021 / D-018)', () => {
  it('returns [] when the blueprint declares no triggers', () => {
    expect(triggerRoutineSpecs({})).toEqual([]);
    expect(triggerRoutineSpecs({ triggers: undefined })).toEqual([]);
    expect(triggerRoutineSpecs({ triggers: { schedule: [] } })).toEqual([]);
  });

  it('maps each schedule entry to a cron routine spec (target_role = its action)', () => {
    const specs = triggerRoutineSpecs({
      triggers: {
        schedule: [
          { cron: '0 0 9 * * *', action: 'system:blueprint-run' },
          { cron: '*/30 * * * * *', action: 'system:git-sync' },
        ],
      },
    });
    expect(specs).toEqual([
      { name: 'bp-schedule-0', tier: 'durable', cron: '0 0 9 * * *', targetRole: 'system:blueprint-run', singleton: false, singletonActive: false },
      { name: 'bp-schedule-1', tier: 'durable', cron: '*/30 * * * * *', targetRole: 'system:git-sync', singleton: false, singletonActive: false },
    ]);
  });

  it('defaults a missing action to system:blueprint-run', () => {
    // A loose/unparsed entry without `action` (the Zod schema defaults it, but guard anyway).
    const specs = triggerRoutineSpecs({
      triggers: { schedule: [{ cron: '0 0 * * * *' } as { cron: string; action: string }] },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].targetRole).toBe(DEFAULT_SCHEDULE_ACTION);
    expect(DEFAULT_SCHEDULE_ACTION).toBe('system:blueprint-run');
  });

  it('names are stable + unique per entry index (the upsert key with install_slug)', () => {
    const specs = triggerRoutineSpecs({
      triggers: {
        schedule: [
          { cron: 'a', action: 'system:blueprint-run' },
          { cron: 'b', action: 'system:blueprint-run' },
          { cron: 'c', action: 'system:blueprint-run' },
        ],
      },
    });
    const names = specs.map((s) => s.name);
    expect(names).toEqual(['bp-schedule-0', 'bp-schedule-1', 'bp-schedule-2']);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('triggerRoutineSpecs — workspace-singleton triggers (D-018)', () => {
  it('singleton defaults to false (a plain entry is per-install)', () => {
    const specs = triggerRoutineSpecs({
      id: 'demo',
      triggers: { schedule: [{ cron: '0 0 9 * * *', action: 'system:blueprint-run' }] },
    });
    expect(specs[0].singleton).toBe(false);
    expect(specs[0].name).toBe('bp-schedule-0');
  });

  it('a singleton entry is named blueprint-uniquely (carries the blueprint id)', () => {
    const specs = triggerRoutineSpecs({
      id: 'regret',
      triggers: {
        schedule: [
          { cron: '0 0 9 * * *', action: 'system:blueprint-run' }, // per-install
          { cron: '0 35 */6 * * *', action: 'system:blueprint-run', singleton: true }, // singleton
        ],
      },
    });
    expect(specs).toEqual([
      { name: 'bp-schedule-0', tier: 'durable', cron: '0 0 9 * * *', targetRole: 'system:blueprint-run', singleton: false, singletonActive: false },
      { name: 'bp-singleton-regret-1', tier: 'durable', cron: '0 35 */6 * * *', targetRole: 'system:blueprint-run', singleton: true, singletonActive: false },
    ]);
  });

  it('two different blueprints never collide on the singleton name (it embeds the id)', () => {
    const a = triggerRoutineSpecs({
      id: 'regret',
      triggers: { schedule: [{ cron: 'x', action: 'system:blueprint-run', singleton: true }] },
    });
    const b = triggerRoutineSpecs({
      id: 'negative-space',
      triggers: { schedule: [{ cron: 'x', action: 'system:blueprint-run', singleton: true }] },
    });
    expect(a[0].name).toBe('bp-singleton-regret-0');
    expect(b[0].name).toBe('bp-singleton-negative-space-0');
    expect(a[0].name).not.toBe(b[0].name);
  });

  it('throws when a singleton trigger is declared without a blueprint id', () => {
    expect(() =>
      triggerRoutineSpecs({
        triggers: { schedule: [{ cron: 'x', action: 'system:blueprint-run', singleton: true }] },
      }),
    ).toThrow(/singleton.*requires the blueprint id/i);
  });

  it('the reserved host-slug is disjoint from real harness slugs (leading @)', () => {
    expect(SINGLETON_TRIGGER_HOST_SLUG).toBe('@singleton');
    expect(SINGLETON_TRIGGER_HOST_SLUG.startsWith('@')).toBe(true);
  });
});

describe('triggerRoutineSpecs — ephemeral tier (P-011 / D-006)', () => {
  it('derives an ephemeral spec (tier=ephemeral, intervalSec, no cron) from a tier:ephemeral entry', () => {
    const specs = triggerRoutineSpecs({
      triggers: { schedule: [{ tier: 'ephemeral', action: 'system:hive-watchdog-sweep', intervalSec: 5 }] },
    });
    expect(specs).toEqual([
      {
        name: 'bp-schedule-0',
        tier: 'ephemeral',
        intervalSec: 5,
        targetRole: 'system:hive-watchdog-sweep',
        singleton: false,
        singletonActive: false,
      },
    ]);
    expect(specs[0].cron).toBeUndefined();
  });

  it('defaults tier to durable for a plain cron entry', () => {
    const specs = triggerRoutineSpecs({ triggers: { schedule: [{ cron: '*/5 * * * *', action: 'system:foo' }] } });
    expect(specs[0].tier).toBe('durable');
    expect(specs[0].intervalSec).toBeUndefined();
  });

  it('throws when a tier:ephemeral entry omits intervalSec', () => {
    expect(() =>
      triggerRoutineSpecs({ triggers: { schedule: [{ tier: 'ephemeral', action: 'system:foo' }] } }),
    ).toThrow(/ephemeral.*requires intervalSec/i);
  });

  it('throws when a tier:durable entry omits cron', () => {
    expect(() =>
      triggerRoutineSpecs({ triggers: { schedule: [{ action: 'system:foo' }] } }),
    ).toThrow(/durable.*requires cron/i);
  });

  it('rejects an ephemeral singleton (unsupported combination)', () => {
    expect(() =>
      triggerRoutineSpecs({
        id: 'x',
        triggers: { schedule: [{ tier: 'ephemeral', action: 'system:foo', intervalSec: 5, singleton: true }] },
      }),
    ).toThrow(/ephemeral.*not supported for a singleton/i);
  });
});

describe('singletonRoutinePayloadDefaults', () => {
  it('bounds Scout singleton cycles so a routine row cannot fall back to the 20 minute default', () => {
    expect(singletonRoutinePayloadDefaults('scout')).toEqual({
      cycleTimeoutMs: SCOUT_SINGLETON_CYCLE_TIMEOUT_MS,
    });
    expect(SCOUT_SINGLETON_CYCLE_TIMEOUT_MS).toBe(600_000);
  });

  it('does not add timeout payload to unrelated singleton blueprints', () => {
    expect(singletonRoutinePayloadDefaults('regret')).toEqual({});
  });
});
