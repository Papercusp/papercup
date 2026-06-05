import { describe, it, expect } from 'vitest';
import { triggerRoutineSpecs, DEFAULT_SCHEDULE_ACTION } from './materialize-triggers';

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
      { name: 'bp-schedule-0', cron: '0 0 9 * * *', targetRole: 'system:blueprint-run' },
      { name: 'bp-schedule-1', cron: '*/30 * * * * *', targetRole: 'system:git-sync' },
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
