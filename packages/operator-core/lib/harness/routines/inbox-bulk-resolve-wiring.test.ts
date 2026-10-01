import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';

const HERE = __dirname;
const ACTION = join(HERE, 'inbox-bulk-resolve-action.ts');
const SEED = join(HERE, 'seed-inbox-bulk-resolve-routine.ts');
const REGISTER = join(HERE, 'register-system-actions.ts');
const read = (path: string) => readFileSync(path, 'utf8');

describe('scheduled Inbox resolver wiring', () => {
  it('has a registered action and matching production import', () => {
    expect(existsSync(ACTION)).toBe(true);
    expect(read(ACTION)).toContain("registerSystemAction(INBOX_BULK_RESOLVE");
    expect(read(REGISTER)).toContain("import './inbox-bulk-resolve-action';");
  });

  it('seeds an active durable single-flight cron with the bounded cap', () => {
    const src = read(SEED);
    expect(src).toContain("const TARGET_ROLE = `system:${NAME}`");
    expect(src).toContain("'durable'");
    expect(src).toContain("'skip', 'skip-old'");
    expect(src).toContain('const active = !process.argv.includes(\'--inactive\')');
    expect(src).toContain('INBOX_BULK_RESOLVE_CAP');
    expect(src).toContain('active intentionally NOT re-applied on conflict');
  });

  it('guards the seed and classifies the resolver as model-spending', async () => {
    expect(BESPOKE_ACTIVE_SEEDS).toContainEqual({
      name: 'inbox-bulk-resolve',
      seedScript: 'seed-inbox-bulk-resolve-routine.ts',
    });
    const { TARGET_ROLE_SPEND } = await import('../../automation/routine-classification');
    expect(TARGET_ROLE_SPEND['system:inbox-bulk-resolve']).toMatchObject({ spend: 'llm' });
  });

  it('reads canonical action-bearing attention data and reuses the route launcher', () => {
    const src = read(ACTION);
    expect(src).toContain("callPlansRead('attention', {}, { uiProjection: false })");
    // WI-10004720: gate on the EXCLUSIVE set, never on getActiveRun (counts `review`).
    expect(src).toContain('getRunningRun');
    expect(src).not.toContain('getActiveRun(');
    expect(src).toContain('BulkRunAlreadyActiveError');
    expect(src).toContain('createRun');
    expect(src).toContain('launchResolver');
    expect(src).toContain('INBOX_BULK_RESOLVE_CAP = 200');
  });
});
