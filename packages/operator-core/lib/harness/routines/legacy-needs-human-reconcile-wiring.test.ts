import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_ROLE_SPEND } from '../../automation/routine-classification';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';

const HERE = __dirname;
const ACTION_NAME = 'legacy-needs-human-reconcile';
const TARGET_ROLE = `system:${ACTION_NAME}`;
const ACTION_FILE = join(HERE, 'legacy-needs-human-reconcile-action.ts');
const SEED_FILE = join(HERE, 'seed-legacy-needs-human-reconcile-routine.ts');
const REGISTER_FILE = join(HERE, 'register-system-actions.ts');
const read = (path: string) => readFileSync(path, 'utf8');

describe('legacy needs-human reconcile wiring', () => {
  it('registers the action and imports it from the production registry', () => {
    expect(existsSync(ACTION_FILE)).toBe(true);
    expect(read(ACTION_FILE)).toContain('registerSystemAction(LEGACY_NEEDS_HUMAN_RECONCILE');
    expect(read(REGISTER_FILE)).toContain(`import './legacy-needs-human-reconcile-action';`);
    expect(read(REGISTER_FILE)).not.toContain(`import './legacy-needs-human-reconcile-action-NOT-WIRED';`);
  });

  it('seeds the matching target as an active durable single-flight routine', () => {
    const src = read(SEED_FILE);
    const seedPolicy = read(join(HERE, 'seed-routine-main.ts'));
    expect(src).toContain("from './seed-routine-main'");
    expect(src).toContain('void runRoutineSeed({');
    expect(src).toContain('const TARGET_ROLE = `system:${NAME}`');
    expect(src).toContain(`'durable'`);
    expect(seedPolicy).toContain(`'skip', 'skip-old'`);
    expect(src).toContain(`const active = !process.argv.includes('--inactive')`);
    expect(src).not.toMatch(/\breplaceActive\s*:/);
    expect(seedPolicy).toContain('q.replaceActive ? sql`active = EXCLUDED.active,` : sql``');
  });

  it('is guarded as an always-on bespoke seed and classified as non-LLM spend', () => {
    const entry = BESPOKE_ACTIVE_SEEDS.find((candidate) => candidate.name === ACTION_NAME);
    expect(entry).toEqual({
      name: ACTION_NAME,
      seedScript: 'seed-legacy-needs-human-reconcile-routine.ts',
    });
    expect(TARGET_ROLE_SPEND[TARGET_ROLE]).toMatchObject({ spend: 'none' });
  });
});
