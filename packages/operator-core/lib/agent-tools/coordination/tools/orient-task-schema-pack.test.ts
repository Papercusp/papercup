import { describe, expect, it } from 'vitest';
import {
  buildTaskToolSchemaPack,
  TASK_SCHEMA_PACK_BUDGET_CHARS,
  TASK_SCHEMA_PACK_SCHEMA,
} from './orient-task-schema-pack';

const ALL_NAMES = [
  'coord:orient', 'coord:declare-intent', 'coord:glance',
  'mode:set',
  'work_items:get', 'work_items:claimable', 'work_items:checkpoint', 'work_items:complete', 'work_items:burn_down',
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
  it('hydrates the claimability oracle for explicit drain mode and fleet/drain intents', () => {
    const byMode = buildTaskToolSchemaPack({ intent: 'resume the queue', modes: ['drain'] }, catalog);
    const byIntent = buildTaskToolSchemaPack({ intent: 'pull the next fleet drain backlog item', modes: ['auto'] }, catalog);

    expect(byMode.toolNames).toContain('work_items:claimable');
    expect(byIntent.toolNames).toContain('work_items:claimable');
    expect(byMode.tools.find((tool) => tool.name === 'work_items:claimable')?.args).toBeTruthy();
    expect(byIntent.tools.find((tool) => tool.name === 'work_items:claimable')?.args).toBeTruthy();
  });

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
      'mode:set',
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
    expect(pack.registryMissing).toEqual([]);
    expect(pack).not.toHaveProperty('missing');
    expect(pack.dispatch).toEqual({
      immediate: 'tools:invoke',
      direct: 'client-surface-dependent',
      refresh: 'tools/list_changed',
    });
    expect(pack.provenance).toEqual({
      source: 'coord:orient',
      schemaSource: 'projected-tool-registry',
      registryRevision: expect.stringMatching(/^projected-tool-registry-v1:/),
    });
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

  it('changes the registry revision and pack watermark when an accepted schema changes', () => {
    const before = buildTaskToolSchemaPack({ intent: 'resume work' }, catalog);
    const changedCatalog = catalog.map((tool) =>
      tool.expose.mcp.name === 'work_items:get'
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...tool.inputSchema.properties,
                detail: { type: 'boolean' },
              },
            },
          }
        : tool,
    );
    const after = buildTaskToolSchemaPack({ intent: 'resume work' }, changedCatalog);

    expect(after.provenance.registryRevision).not.toBe(before.provenance.registryRevision);
    expect(after.watermark).not.toBe(before.watermark);
  });

  it('reports unavailable canonical tools loudly instead of advertising phantom schemas', () => {
    const pack = buildTaskToolSchemaPack({ intent: 'grade rubric scorecard', modes: [] }, catalog.slice(0, 4));
    expect(pack.registryMissing).toContain('rubrics:list');
    expect(pack.toolNames).not.toContain('rubrics:list');
  });

  it('keeps late terminal completion contracts in the bounded quick schema', () => {
    const verboseCompletion = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`evidence${i}`, { type: 'string' }]),
      ),
      description:
        'Structured completion evidence. '.repeat(20) +
        'Successful bug/capability-gap closes require completion.rootCauseVerification with hypothesis, alternativeHypothesis, a contrastive distinguishingTest, and the observed testResult.',
    };
    const completeSchema = {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'single-complete shorthand work-item id' },
        state: {
          type: 'string',
          description:
            "Terminal intent: feature/chunk uses 'passed'|'deprecated' and issue uses 'resolved'|'closed'; unified 'done'|'dropped' aliases are also accepted.",
        },
        completion: verboseCompletion,
        assumptions: {
          description: 'Required for a terminal close; omit for record-only completions. Pass "none" or fact keys.',
          anyOf: [
            { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
            { type: 'string', const: 'none' },
          ],
        },
      },
    };
    const completeCatalog = catalog.map((tool) =>
      tool.expose.mcp.name === 'work_items:complete'
        ? { ...tool, inputSchema: completeSchema }
        : tool,
    );

    const pack = buildTaskToolSchemaPack({ intent: 'resume work', modes: [] }, completeCatalog);
    const args = pack.tools.find((tool) => tool.name === 'work_items:complete')?.args ?? '';

    expect(args.length).toBeLessThanOrEqual(180);
    expect(args).toContain(
      'completion?:object; rootCauseVerification required {hypothesis,alternativeHypothesis,distinguishingTest,testResult}',
    );
    expect(args).toContain('assumptions?');
    expect(args).toContain('terminal close');
    expect(args).toContain('record-only');
    expect(args).toContain('"none"');
  });

  it('keeps loop:checkpoint recovery write keys in the bounded quick schema', () => {
    const recoveryCatalog = catalog.map((tool) =>
      tool.expose.mcp.name === 'loop:checkpoint'
        ? {
            ...tool,
            inputSchema: {
              type: 'object',
              properties: {
                note: { type: 'string', description: 'raw carry note' },
                did: { type: 'string', description: 'what this wake accomplished' },
                left: { type: 'string', description: 'what remains' },
                insight: { type: 'string', description: 'non-obvious successor insight' },
                next: { type: 'string', description: 'single next action' },
                goal: { type: 'string', description: 'compatibility alias for next' },
                walls: { type: 'array', description: 'open owner-gated walls '.repeat(40) },
              },
            },
          }
        : tool,
    );

    const pack = buildTaskToolSchemaPack({ intent: 'checkpoint loop recovery', modes: ['auto'] }, recoveryCatalog);
    const detail = pack.tools.find((tool) => tool.name === 'loop:checkpoint')?.args ?? '';

    expect(detail).not.toBe('');
    expect(detail).toContain('did?');
    expect(detail).toContain('left?');
    expect(detail).toContain('insight?');
    expect(detail).toContain('next?');
  });
});
