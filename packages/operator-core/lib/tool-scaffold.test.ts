/**
 * tool-scaffold.test — the P-004 pure codegen. Locks: the generated skeleton is a real
 * defineTool shape with a not_implemented stub (no exec); the review RAIL is tier-correct
 * (composed = mergeable, sandboxed/elevated = review-gated per D-003); first-class emits a
 * migration stub; args render to the right zod; bad specs are rejected.
 */
import { describe, it, expect } from 'vitest';
import { scaffoldTool, isToolTier, TOOL_TIERS, type ToolScaffoldSpec } from './tool-scaffold';

const BASE: ToolScaffoldSpec = {
  group: 'oddsmith',
  verb: 'score-bet',
  name: 'oddsmith:score-bet',
  description: 'Score a bet against its scorecard.',
  tier: 'composed',
  capability: 'intel:write',
};

function ok(spec: ToolScaffoldSpec) {
  const r = scaffoldTool(spec);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r;
}

describe('scaffoldTool — the generated tool file', () => {
  it('emits a real defineTool skeleton at the right path with a not_implemented stub', () => {
    const r = ok(BASE);
    const file = r.files[0];
    expect(file.path).toBe('packages/operator-core/lib/agent-tools/oddsmith/score-bet.ts');
    expect(file.action).toBe('create');
    const c = file.contents;
    expect(c).toContain("import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';");
    expect(c).toContain('name: "oddsmith:score-bet"');
    expect(c).toContain('capability: "intel:write"');
    expect(c).toContain('agentRoles: [...AGENT_ROLES]');
    expect(c).toContain("reason: 'not_implemented'"); // a stub, never a live handler
    expect(c).toContain('async handler('); // it IS a defineTool
  });

  it('a non-first-class tool does NOT import getOrgPg; a first-class one does', () => {
    expect(ok(BASE).files[0].contents).not.toContain('getOrgPg');
    const fc = ok({ ...BASE, firstClass: true });
    expect(fc.files[0].contents).toContain("import { getOrgPg } from '@papercusp/db-org';");
    expect(fc.files[0].contents).toContain('const sql = getOrgPg().sql;');
  });
});

describe('scaffoldTool — args render to zod', () => {
  it('maps each arg type, optionality, and description', () => {
    const c = ok({
      ...BASE,
      args: [
        { name: 'betId', type: 'string', required: true, description: 'the bet id' },
        { name: 'rounds', type: 'number' },
        { name: 'dryRun', type: 'boolean' },
        { name: 'tags', type: 'string[]' },
      ],
    }).files[0].contents;
    expect(c).toContain('betId: z.string().describe("the bet id")'); // required → no .optional()
    expect(c).toContain('rounds: z.number().optional()');
    expect(c).toContain('dryRun: z.boolean().optional()');
    expect(c).toContain('tags: z.array(z.string()).optional()');
  });

  it('no args → an empty zod object', () => {
    expect(ok(BASE).files[0].contents).toContain('args: z.object({})');
  });
});

describe('scaffoldTool — the review rail is tier-correct (D-003)', () => {
  it('composed → mergeable, mints no capability', () => {
    const r = ok({ ...BASE, tier: 'composed' });
    expect(r.rail).toBe('mergeable');
    expect(r.reviewNotes.join(' ')).toMatch(/mints no new capability/i);
    expect(r.files[0].contents).toContain('TIER: composed');
  });

  for (const tier of ['sandboxed-imperative', 'elevated'] as const) {
    it(`${tier} → review-gated with an adversarial-proof requirement`, () => {
      const r = ok({ ...BASE, tier });
      expect(r.rail).toBe('review-gated');
      const notes = r.reviewNotes.join(' ');
      expect(notes).toMatch(/D-003/);
      expect(notes).toMatch(/escalation/i);
      expect(notes).toMatch(/platform:contribute/);
      expect(r.files[0].contents).toContain('RUNTIME-DANGEROUS');
      // the human is told NOT to enable it at runtime
      expect(r.nextSteps.join(' ')).toMatch(/do NOT enable this tier at runtime/i);
    });
  }
});

describe('scaffoldTool — first-class migration stub', () => {
  it('emits an idempotent, number-placeholder migration when firstClass', () => {
    const r = ok({ ...BASE, firstClass: true });
    const mig = r.files.find((f) => f.path.endsWith('.sql'));
    expect(mig).toBeDefined();
    expect(mig!.path).toBe('libs/papercusp/libs/db/sql/NNN-oddsmith_score_bet.sql');
    expect(mig!.contents).toContain('CREATE TABLE IF NOT EXISTS harness_shared.oddsmith_score_bet');
    expect(mig!.contents).toMatch(/db:next-migration/);
    expect(r.nextSteps.join(' ')).toMatch(/Reserve the migration number/i);
  });

  it('respects a migrationTable override and a suggested number', () => {
    const r = ok({ ...BASE, firstClass: true, migrationTable: 'bet_scores', suggestedMigrationNumber: 422 });
    const mig = r.files.find((f) => f.path.endsWith('.sql'))!;
    expect(mig.path).toBe('libs/papercusp/libs/db/sql/422-bet_scores.sql');
    expect(mig.contents).toContain('harness_shared.bet_scores');
  });

  it('no migration for a non-first-class tool', () => {
    expect(ok(BASE).files.some((f) => f.path.endsWith('.sql'))).toBe(false);
  });
});

describe('scaffoldTool — nextSteps wire the human in', () => {
  it('always includes the index import line + catalog regen', () => {
    const steps = ok(BASE).nextSteps.join('\n');
    expect(steps).toContain("import './oddsmith/score-bet';");
    expect(steps).toMatch(/gen:tool-catalog/);
  });
});

describe('scaffoldTool — rejects a bad spec', () => {
  const bad: Array<[string, Partial<ToolScaffoldSpec>]> = [
    ['non-kebab group', { group: 'OddSmith' }],
    ['non-kebab verb', { verb: 'scoreBet' }],
    ['empty name', { name: '   ' }],
    ['empty description', { description: '' }],
    ['empty capability', { capability: '' }],
    ['bad tier', { tier: 'godmode' as ToolScaffoldSpec['tier'] }],
    ['bad arg identifier', { args: [{ name: '2bad', type: 'string' }] }],
  ];
  for (const [label, over] of bad) {
    it(`${label} → invalid_spec`, () => {
      const r = scaffoldTool({ ...BASE, ...over });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.reason).toBe('invalid_spec');
    });
  }
});

describe('isToolTier / TOOL_TIERS', () => {
  it('recognizes exactly the three D-003 tiers', () => {
    expect([...TOOL_TIERS]).toEqual(['composed', 'sandboxed-imperative', 'elevated']);
    expect(isToolTier('composed')).toBe(true);
    expect(isToolTier('godmode')).toBe(false);
  });
});
