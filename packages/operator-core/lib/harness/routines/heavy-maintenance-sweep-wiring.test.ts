import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';

const HERE = __dirname;
const ACTION_FILE = join(HERE, 'heavy-maintenance-sweep-actions.ts');
const SEED_FILE = join(HERE, 'seed-heavy-maintenance-sweep-routines.ts');
const REGISTER_FILE = join(HERE, 'register-system-actions.ts');
const TICK_FILE = join(HERE, '../../dbos/routines-workflow.ts');
const read = (path: string) => readFileSync(path, 'utf8');

const ROUTINES = [
  {
    name: 'scout-signal-accumulator-sweep',
    targetRole: 'system:scout-signal-accumulator-sweep',
    cron: "cron: '0 */2 * * * *'",
  },
  {
    name: 'dead-target-reaper-sweep',
    targetRole: 'system:dead-target-reaper-sweep',
    cron: "cron: '30 */10 * * * *'",
  },
] as const;

describe('heavy sweeps are scheduled independently of routinesTick', () => {
  it('removes both expensive calls from the scheduler workflow', () => {
    const tick = read(TICK_FILE);
    // vacuous-negative-ok: these sweeps moved out of the scheduler tick into their own routines; pins the old tick entries out
    expect(tick).not.toContain("{ name: 'scout-signal-accumulator-sweep' }");
    expect(tick).not.toContain("{ name: 'dead-target-reaper-sweep' }"); // vacuous-negative-ok: these sweeps moved out of the scheduler tick into their own routines; pins the old tick entries out
    expect(tick).not.toContain('scoutSignalAccumulatorSweep()');
    expect(tick).not.toContain('deadTargetReaperSweep()');
  });

  it('registers and seeds both names on the same system-action seam', () => {
    expect(existsSync(ACTION_FILE)).toBe(true);
    expect(existsSync(SEED_FILE)).toBe(true);
    const action = read(ACTION_FILE);
    const seed = read(SEED_FILE);
    for (const routine of ROUTINES) {
      const constant =
        routine.name === 'scout-signal-accumulator-sweep'
          ? 'SCOUT_SIGNAL_ACCUMULATOR_SWEEP'
          : 'DEAD_TARGET_REAPER_SWEEP';
      expect(action).toContain(`registerSystemAction(${constant}`);
      expect(seed).toContain(`name: '${routine.name}'`);
      expect(seed).toContain(`targetRole: '${routine.targetRole}'`);
      expect(seed).toContain(routine.cron);
      expect(BESPOKE_ACTIVE_SEEDS).toContainEqual({
        name: routine.name,
        seedScript: 'seed-heavy-maintenance-sweep-routines.ts',
      });
    }
  });

  it('loads the action module at routine-engine boot', () => {
    expect(read(REGISTER_FILE)).toContain("import './heavy-maintenance-sweep-actions';");
  });

  it('seeds durable active-by-default rows without overwriting an operator pause', () => {
    const seed = read(SEED_FILE);
    expect(seed).toContain("const active = !process.argv.includes('--inactive')");
    expect(seed).toContain("'durable'");
    expect(seed).toContain('active intentionally NOT re-applied on conflict');
    expect(seed).not.toContain('active = EXCLUDED.active');
  });
});
