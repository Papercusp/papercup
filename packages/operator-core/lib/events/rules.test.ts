import { describe, it, expect } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './rules'; // registers the built-in Events-file rules into the global engine
import { matchReactions, reactionRulesFor } from './registry';
import type { ToolInvocationEvent } from './types';

function ctx(over: Partial<UnifiedToolContext>): UnifiedToolContext {
  return { uiClientId: 'agent-7', spawnId: 'spawn-7', harnessSlug: 'h1', runId: 'run-1', ...over } as unknown as UnifiedToolContext;
}

function handoffEvent(args: Record<string, unknown>, over: Partial<UnifiedToolContext> = {}): ToolInvocationEvent {
  return { tool: 'coord:handoff', args, result: { ok: true, data: { ok: true } }, ctx: ctx(over) };
}

function createWorkItemEvent(
  data: Record<string, unknown>,
  over: Partial<UnifiedToolContext> = {},
): ToolInvocationEvent {
  return { tool: 'work_items:create', args: {}, result: { ok: true, data }, ctx: ctx(over) };
}

describe('the defer→pane rule (D-008)', () => {
  it('is registered on coord:handoff', () => {
    const rules = reactionRulesFor('coord:handoff');
    expect(rules.map((r) => r.id)).toContain('defer-renders-on-pane');
  });

  it('matches an OPEN handoff and maps args for activity:report on the agent pane', () => {
    const actions = matchReactions(
      handoffEvent({ to: ['su-x'], plan_slug: 'pl', summary: 'did the thing', next_action: 'do the next' }),
    );
    const a = actions.find((x) => x.ruleId === 'defer-renders-on-pane');
    expect(a).toBeDefined();
    expect(a!.fire).toBe('activity:report');
    expect(a!.args.owner).toBe('agent-7');
    expect(a!.args.kind).toBe('lifecycle');
    expect(a!.args.session_id).toBe('spawn-7');
    expect(a!.args.harness_slug).toBe('h1');
    expect(String(a!.args.summary)).toContain('did the thing');
    expect(String(a!.args.summary)).toContain('deferred → su-x');
  });

  it('does NOT fire on an accept (accept_msg_id, no summary)', () => {
    const actions = matchReactions(handoffEvent({ accept_msg_id: 'm-1' }));
    expect(actions.find((x) => x.ruleId === 'defer-renders-on-pane')).toBeUndefined();
  });

  it('does NOT fire when there is no pane to target (no uiClientId)', () => {
    const actions = matchReactions(handoffEvent({ summary: 's' }, { uiClientId: null }));
    expect(actions.find((x) => x.ruleId === 'defer-renders-on-pane')).toBeUndefined();
  });
});

describe('the critical-work-item-alert rule (WI-5271)', () => {
  it('is registered on work_items:create', () => {
    const rules = reactionRulesFor('work_items:create');
    expect(rules.map((r) => r.id)).toContain('critical-work-item-alert');
  });

  it('fires coord:escalate at advisory severity for a critical-severity create', () => {
    const actions = matchReactions(
      createWorkItemEvent({
        ok: true,
        workItem: { id: 'EI-999', title: 'Something on fire', severity: 'critical', harness: 'papercusp' },
      }),
    );
    const a = actions.find((x) => x.ruleId === 'critical-work-item-alert');
    expect(a).toBeDefined();
    expect(a!.fire).toBe('coord:escalate');
    expect(a!.args.severity).toBe('advisory');
    expect(String(a!.args.summary)).toContain('EI-999');
    expect(String(a!.args.summary)).toContain('Something on fire');
    expect(a!.args.conditionKey).toBe('critical-wi-alert:EI-999');
  });

  it('does NOT fire for a major/minor-severity create', () => {
    const actions = matchReactions(
      createWorkItemEvent({ ok: true, workItem: { id: 'EI-998', title: 'Minor thing', severity: 'minor' } }),
    );
    expect(actions.find((x) => x.ruleId === 'critical-work-item-alert')).toBeUndefined();
  });

  it('does NOT fire on a failed create', () => {
    const actions = matchReactions(
      createWorkItemEvent({ ok: false, workItem: { id: 'EI-997', severity: 'critical' } }),
    );
    expect(actions.find((x) => x.ruleId === 'critical-work-item-alert')).toBeUndefined();
  });
});
