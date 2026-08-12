import { describe, expect, it } from 'vitest';
import {
  buildTaskToolSchemaPack,
  TASK_SCHEMA_PACK_BUDGET_CHARS,
  TASK_SCHEMA_PACK_SCHEMA,
} from './orient-task-schema-pack';

const ALL_NAMES = [
  'coord:orient', 'coord:declare-intent', 'coord:glance',
  'work_items:get', 'work_items:checkpoint', 'work_items:complete', 'work_items:burn_down',
  'plans:get', 'plans:items', 'locks:acquire', 'locks:release',
  'loop:arm', 'loop:status', 'loop:checkpoint', 'loop:end',
  'watch:create', 'events:await', 'events:status',
  'sessions:list', 'sessions:search', 'sessions:timeline', 'sessions:read', 'session:request-compaction',
  'rubrics:list', 'rubrics:search', 'rubrics:get',
  'scorecards:list', 'scorecards:freshness',
  'blender:grade-idea', 'blender:ideation-feedback',
  'recipes:get', 'recipes:run', 'recipes:search', 'code:run',
];

const catalog = ALL_NAMES.map((name) => ({
  expose: { mcp: { name } },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: `${name} target identity` },
      checkpoint: { type: 'string', description: 'durable progress evidence' },
    },
  },
}));

describe('orient task tool-schema pack (P-006 / EI-11409)', () => {
  it('hydrates the complete GRADE-monitor resumption pack in one bounded orient result', () => {
    const pack = buildTaskToolSchemaPack({
      intent: 'Resume GRADE monitor after compaction; run the saved watch recipe and checkpoint the scorecard',
      modes: ['auto'],
      harness: 'papercusp',
      plan: 'agent-operability-improvements-implementation-2026-07-13',
      planItems: ['P-006'],
      recipeTitles: ['saved rubric scorecard watch'],
    }, catalog);

    const names = pack.toolNames;
    expect(pack.schemaVersion).toBe(TASK_SCHEMA_PACK_SCHEMA);
    expect(names).toEqual(expect.arrayContaining([
      'coord:orient',
      'coord:declare-intent',
      'work_items:checkpoint',
      'loop:status',
      'loop:checkpoint',
      'watch:create',
      'events:await',
      'rubrics:list',
      'rubrics:search',
      'scorecards:freshness',
      'blender:grade-idea',
      'recipes:get',
      'recipes:run',
    ]));
    expect(pack.missing).toEqual([]);
    expect(pack.budget.serializedChars).toBeLessThanOrEqual(TASK_SCHEMA_PACK_BUDGET_CHARS);
    expect(pack.resync).toMatchObject({
      verb: 'coord:orient',
      args: { afterCompaction: true },
      rule: 'replace-full-never-merge-behind',
    });
  });

  it('is content-addressed and changes generation on a mode or scope transition', () => {
    const base = {
      intent: 'monitor the task',
      modes: ['auto'],
      harness: 'papercusp',
      plan: 'p',
      planItems: ['P-006'],
      recipeTitles: [] as string[],
    };
    const a = buildTaskToolSchemaPack(base, catalog);
    const same = buildTaskToolSchemaPack(base, catalog);
    const changed = buildTaskToolSchemaPack({ ...base, modes: ['auto', 'ideate'] }, catalog);
    expect(same.watermark).toBe(a.watermark);
    expect(same.generation).toBe(a.generation);
    expect(changed.watermark).not.toBe(a.watermark);
  });

  it('reports unavailable canonical tools loudly instead of advertising phantom schemas', () => {
    const pack = buildTaskToolSchemaPack({ intent: 'grade rubric scorecard', modes: [] }, catalog.slice(0, 4));
    expect(pack.missing).toContain('rubrics:list');
    expect(pack.toolNames).not.toContain('rubrics:list');
  });
});
