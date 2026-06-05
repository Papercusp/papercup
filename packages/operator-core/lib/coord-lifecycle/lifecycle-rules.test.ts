/**
 * Integration test for the lifecycle auto-emit rules over the REAL event-reaction
 * engine (coord-lifecycle-automation-2026-06-04 D-002/D-003/D-004).
 *
 * Drives the engine's pure `matchReactions(event)` so we exercise the genuine
 * path: rule registration → trigger match → `args` render → the `coord:emit`
 * payload that WOULD be fired. Covers both authoring forms:
 *   • central rules (claim / intent / finding) registered by ./lifecycle-rules
 *   • the `emits:` on work_items:complete, desugared by installEmitRules()
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { matchReactions } from '../events';
// Side-effect: registers the central claim/intent/finding rules.
import './lifecycle-rules';
// Side-effect: registers work_items:complete (collects its `emits`).
import '../agent-tools/work_items/complete';
import { installEmitRules } from './register-emit-rules';

type Action = { ruleId: string; fire: string; args: Record<string, unknown> };

function fireFor(event: unknown, ruleId: string): Action | undefined {
  return (matchReactions(event as never) as unknown as Action[]).find((a) => a.ruleId === ruleId);
}

beforeAll(() => {
  // Desugar work_items:complete's emits into the registry (idempotent).
  installEmitRules();
});

describe('lifecycle:claim (on work_items:claim)', () => {
  it('emits a Taking-X coord:emit from the claimed work-item', () => {
    const ev = {
      tool: 'work_items:claim',
      args: { id: 'F-1' },
      result: { ok: true, data: { ok: true, workItem: { id: 'F-1', title: 'Build X', assignee: 'su-z' } } },
      ctx: { uiClientId: 'su-z' },
    };
    const a = fireFor(ev, 'lifecycle:claim');
    expect(a?.fire).toBe('coord:emit');
    expect(a?.args.category).toBe('claim');
    expect(String(a?.args.summary)).toContain('Taking Build X');
    expect(String(a?.args.summary)).toContain('su-z');
  });

  it('does not match when no work-item came back', () => {
    const ev = { tool: 'work_items:claim', args: { id: 'F-404' }, result: { ok: true, data: { ok: false } }, ctx: {} };
    expect(fireFor(ev, 'lifecycle:claim')).toBeUndefined();
  });
});

describe('lifecycle:intent (on coord:declare-intent)', () => {
  it('emits "now working on X" with files + plan', () => {
    const ev = {
      tool: 'coord:declare-intent',
      args: { intent: 'building the desugar', current_files: ['a.ts'], current_plan_slug: 'coord-lifecycle-automation-2026-06-04' },
      result: { ok: true, data: { ok: true } },
      ctx: { uiClientId: 'su-z' },
    };
    const a = fireFor(ev, 'lifecycle:intent');
    expect(a?.args.category).toBe('intent');
    expect(String(a?.args.summary)).toContain('now working on: building the desugar');
    expect(String(a?.args.body)).toContain('a.ts');
    expect(a?.args.plan_slug).toBe('coord-lifecycle-automation-2026-06-04');
  });
});

describe('lifecycle:finding (on work_items:create[kind=bug])', () => {
  it('emits a finding for a bug work-item', () => {
    const ev = {
      tool: 'work_items:create',
      args: { kind: 'bug', title: 'broken thing', severity: 'major', summary: 'repro here' },
      result: { ok: true, data: { ok: true, workItem: { id: 'WI-9', title: 'broken thing' } } },
      ctx: {},
    };
    const a = fireFor(ev, 'lifecycle:finding');
    expect(a?.args.category).toBe('finding');
    expect(String(a?.args.summary)).toContain('[major]');
    expect(String(a?.args.summary)).toContain('broken thing');
    expect(String(a?.args.summary)).toContain('WI-9');
  });

  it('does NOT fire for a non-bug create (feature)', () => {
    const ev = {
      tool: 'work_items:create',
      args: { kind: 'feature', title: 'a feature' },
      result: { ok: true, data: { ok: true, workItem: { id: 'WI-10', title: 'a feature' } } },
      ctx: {},
    };
    expect(fireFor(ev, 'lifecycle:finding')).toBeUndefined();
  });
});

describe('emits: completion (on work_items:complete — the P0 emits field end-to-end)', () => {
  it('desugars work_items:complete emits into a rule that renders the completion', () => {
    const ev = {
      tool: 'work_items:complete',
      args: { id: 'F-1', completion: { workItem: 'F-1', summary: 'all phases done' } },
      result: {
        ok: true,
        data: {
          ok: true,
          workItem: { id: 'F-1' },
          completion: {
            workItem: 'F-1',
            summary: 'all phases done',
            status: 'built+tested',
            tests: '40 green',
            migrations: ['137 add cols'],
            deferred: ['live smoke pending'],
            planSlug: 'some-plan',
            agent: 'su-z',
          },
        },
      },
      ctx: { uiClientId: 'su-z' },
    };
    const a = fireFor(ev, 'emits:work_items:complete#0');
    expect(a?.fire).toBe('coord:emit');
    expect(a?.args.category).toBe('completion');
    expect(String(a?.args.summary)).toContain('F-1 BUILT+TESTED');
    // D-006: the deferred-set survives into the emitted body.
    expect(String(a?.args.body)).toContain('live smoke pending');
    expect(a?.args.plan_slug).toBe('some-plan');
  });

  it('does NOT fire the completion emit when no completion record came back', () => {
    const ev = {
      tool: 'work_items:complete',
      args: { id: 'F-404' },
      result: { ok: true, data: { ok: false, error: 'not found' } },
      ctx: {},
    };
    expect(fireFor(ev, 'emits:work_items:complete#0')).toBeUndefined();
  });
});
