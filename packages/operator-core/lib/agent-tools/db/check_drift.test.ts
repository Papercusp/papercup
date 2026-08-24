/**
 * check_drift.test.ts — the db:check_drift HANDLER (checkMigrationDrift mocked). Pins the
 * snake_case projection of the drift report: in_sync, missing, extra, and the COUNTS
 * derived from the onDisk/applied arrays (on_disk_count / applied_count). A regression
 * that swaps missing/extra or mis-counts is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/db/check_drift.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../migration-drift', () => ({ checkMigrationDrift: vi.fn() }));

import { checkMigrationDrift } from '../../migration-drift';
const driftM = vi.mocked(checkMigrationDrift);
const tool = (await import('./check_drift')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('db:check_drift handler', () => {
  it('projects the drift report into the snake_case shape with derived counts', async () => {
    driftM.mockResolvedValue({
      inSync: false,
      missing: ['230-x.sql'],
      extra: [],
      onDisk: ['1.sql', '2.sql', '230-x.sql'],
      applied: ['1.sql', '2.sql'],
      sqlDir: '/sql',
    } as never);
    const out = (await tool.handler({} as never, {} as never)) as Out;
    expect(body(out)).toMatchObject({
      ok: true,
      in_sync: false,
      missing: ['230-x.sql'],
      extra: [],
      on_disk_count: 3,
      applied_count: 2,
      sql_dir: '/sql',
    });
  });

  /**
   * EI-19408574209859155: `content_drift_executable` is the field an alert
   * should key on — the subset that is NOT proven benign. Dropping it from the
   * projection would silently send readers back to the raw `content_drift`
   * list, where a provably-benign comment-only edit (the `-- FORWARD-COMPAT:`
   * remedy `lint:migration-forward-compat` itself prescribes) is
   * indistinguishable from a real half-landed migration.
   */
  it('projects the CLASSIFIED content drift, keeping the actionable subset separate', async () => {
    const benign = {
      filename: '727-widen.sql',
      recordedSha256: 'a',
      diskSha256: 'b',
      classification: 'comments-only',
      classificationDetail: 'only comments/whitespace differ',
    };
    const hazard = {
      filename: '708-federate.sql',
      recordedSha256: 'c',
      diskSha256: 'd',
      classification: 'executable',
      classificationDetail: 'the edit never ran and never will',
    };
    driftM.mockResolvedValue({
      inSync: true,
      missing: [],
      extra: [],
      onDisk: [],
      applied: [],
      sqlDir: '/sql',
      contentDrift: [benign, hazard],
      contentDriftExecutable: [hazard],
      contentDriftSqlDir: '/sql',
    } as never);
    const out = (await tool.handler({} as never, {} as never)) as Out;
    const got = body(out);
    // The full list is still reported — classification never HIDES an entry.
    expect(got.content_drift).toEqual([benign, hazard]);
    // ...but the benign one is absent from the actionable subset.
    expect(got.content_drift_executable).toEqual([hazard]);
  });
});

describe('db:check_drift call-scope contract', () => {
  it('documents and enforces its operator-global no-harness invocation', () => {
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ harness: 'papercusp' }).success).toBe(false);

    const guidance = `${tool.description} ${tool.guidance?.when ?? ''}`;
    expect(guidance).toMatch(/operator-global/i);
    expect(guidance).toMatch(/do not pass [`"]?harness/i);
  });
});
