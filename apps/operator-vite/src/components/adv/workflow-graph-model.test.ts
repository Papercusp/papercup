import { describe, expect, it } from 'vitest';
import type { ExternalTriggerBindingAdminRow } from '@papercusp/operator-core/lib/external-triggers/admin';
import {
  buildWorkflowGraph,
  describeEventFilter,
  describeStormPolicy,
  workflowActionType,
  workflowGraphEmptyCopy,
  type WorkflowBindingInput,
} from './workflow-graph-model';

function binding(overrides: Partial<WorkflowBindingInput> = {}): WorkflowBindingInput {
  return {
    id: 'bind-1',
    sourceKind: 'google-calendar',
    eventPattern: 'calendar.event.starts-in-30m',
    eventFilter: {},
    action: {},
    stormPolicy: {},
    planSlug: 'meeting-prep-brief',
    planHarnessSlug: 'papercusp',
    armed: true,
    lastRun: null,
    ...overrides,
  };
}

describe('workflow-graph-model — structural contract with operator-core', () => {
  it('accepts a real ExternalTriggerBindingAdminRow without widening', () => {
    // The model declares its input STRUCTURALLY rather than importing the row type. This
    // test is what keeps that honest: if the canonical row ever narrows a field this model
    // reads, this assignment stops compiling — which is exactly where we want to hear it.
    const row: ExternalTriggerBindingAdminRow = {
      id: 'bind-1',
      sourceId: 'src-1',
      sourceKind: 'google-calendar',
      sourceStatus: 'connected',
      planHarnessSlug: 'papercusp',
      planSlug: 'meeting-prep-brief',
      goalId: null,
      workItemHarnessSlug: null,
      workItemKind: null,
      eventPattern: 'calendar.event.starts-in-30m',
      eventFilter: { 'attendees.0': { exists: true } },
      action: {},
      armed: true,
      stormPolicy: { maxRuns: 5, windowSeconds: 300 },
      createdBy: null,
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      lastRun: null,
    };
    const accepted: WorkflowBindingInput = row;
    const graph = buildWorkflowGraph({ binding: accepted, workflowLabel: 'Meeting prep brief' });
    expect(graph.nodes.map((n) => n.kind)).toEqual(['trigger', 'filter', 'plan']);
  });
});

describe('buildWorkflowGraph — absence is never rendered as zero', () => {
  it('reports not-loaded rather than an empty wiring while the snapshot is pending', () => {
    const graph = buildWorkflowGraph({ binding: null, loaded: false, workflowLabel: 'Meeting prep' });
    expect(graph.nodes).toEqual([]);
    expect(graph.emptyReason).toBe('not-loaded');
    expect(workflowGraphEmptyCopy('not-loaded')).toMatch(/Loading/);
  });

  it('distinguishes a workflow with no binding from no workflow at all', () => {
    expect(buildWorkflowGraph({ binding: null, workflowLabel: 'Meeting prep' }).emptyReason).toBe('no-binding');
    expect(buildWorkflowGraph({ binding: null }).emptyReason).toBe('no-workflow');
    // The two must not share copy — telling them apart is the whole point.
    expect(workflowGraphEmptyCopy('no-binding')).not.toBe(workflowGraphEmptyCopy('no-workflow'));
  });

  it('gives every empty reason distinct non-blank copy', () => {
    const reasons = ['not-loaded', 'no-binding', 'no-workflow'] as const;
    const copies = reasons.map((r) => workflowGraphEmptyCopy(r));
    expect(copies.every((c) => c.trim().length > 0)).toBe(true);
    expect(new Set(copies).size).toBe(reasons.length);
  });
});

describe('buildWorkflowGraph — nodes trace to real binding fields', () => {
  it('omits the filter node entirely when no filter is configured', () => {
    const graph = buildWorkflowGraph({ binding: binding({ eventFilter: {} }) });
    expect(graph.nodes.map((n) => n.kind)).toEqual(['trigger', 'plan']);
    // ...and wires the trigger straight to the plan rather than leaving a dangling hop.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: 'trigger', to: 'plan' });
  });

  it('emits a filter node when the binding actually filters', () => {
    const graph = buildWorkflowGraph({ binding: binding({ eventFilter: { 'attendees.0': { exists: true } } }) });
    expect(graph.nodes.map((n) => n.kind)).toEqual(['trigger', 'filter', 'plan']);
    expect(graph.nodes[1].detail).toBe('attendees.0 exists');
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['trigger->filter', 'filter->plan']);
  });

  it('does NOT emit a second node for the default launch-plan action', () => {
    // 'launch-plan' IS the plan node; a second node would draw a hop that does not exist.
    const graph = buildWorkflowGraph({ binding: binding({ action: {} }) });
    expect(graph.nodes.some((n) => n.kind === 'tool')).toBe(false);
    const explicit = buildWorkflowGraph({ binding: binding({ action: { type: 'launch-plan' } }) });
    expect(explicit.nodes.some((n) => n.kind === 'tool')).toBe(false);
  });

  it('emits a tool node for a non-default action', () => {
    const graph = buildWorkflowGraph({ binding: binding({ action: { type: 'coord:send' } }) });
    const tool = graph.nodes.find((n) => n.kind === 'tool');
    expect(tool?.label).toBe('coord:send');
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toContain('plan->action');
  });

  it('renders a registered blueprint operation as the target without inventing a plan node', () => {
    const graph = buildWorkflowGraph({
      binding: binding({
        planHarnessSlug: null,
        planSlug: null,
        action: {
          type: 'blueprint-operation',
          operationHarnessSlug: 'papercusp',
          operationId: 'triage-message',
        },
      }),
    });
    expect(graph.nodes.map((node) => node.kind)).toEqual(['trigger', 'tool']);
    expect(graph.nodes[1]).toMatchObject({
      label: 'triage-message',
      detail: 'papercusp · registered blueprint operation',
    });
    expect(graph.edges).toEqual([
      expect.objectContaining({ from: 'trigger', to: 'operation' }),
    ]);
  });

  it('never invents a recipe or outcome node — neither has a binding field today', () => {
    const graph = buildWorkflowGraph({
      binding: binding({ eventFilter: { 'attendees.0': { exists: true } }, action: { type: 'coord:send' } }),
    });
    expect(graph.nodes.some((n) => n.kind === 'recipe')).toBe(false);
    expect(graph.nodes.some((n) => n.kind === 'outcome')).toBe(false);
  });
});

describe('buildWorkflowGraph — node state', () => {
  it('treats a disarmed trigger as idle, not as a problem', () => {
    const graph = buildWorkflowGraph({ binding: binding({ armed: false }) });
    const trigger = graph.nodes.find((n) => n.kind === 'trigger');
    expect(trigger?.state).toBe('idle');
    expect(trigger?.meta).toBe('disarmed');
  });

  it('flags the plan for attention only when the last run actually failed', () => {
    const ok = buildWorkflowGraph({ binding: binding({ lastRun: { status: 'completed' } }) });
    expect(ok.nodes.find((n) => n.kind === 'plan')?.state).toBe('ok');
    const bad = buildWorkflowGraph({ binding: binding({ lastRun: { status: 'failed' } }) });
    expect(bad.nodes.find((n) => n.kind === 'plan')?.state).toBe('attention');
  });

  it('reports declared plan outputs only when the schema was actually read', () => {
    // null means "not read" and must not be rendered as "no outputs" — that is the
    // unknown-vs-zero distinction this pane exists to keep honest.
    expect(buildWorkflowGraph({ binding: binding() }).nodes.find((n) => n.kind === 'plan')?.meta).toBeNull();
    expect(
      buildWorkflowGraph({ binding: binding(), planChainable: true }).nodes.find((n) => n.kind === 'plan')?.meta,
    ).toBe('declares outputs');
    expect(
      buildWorkflowGraph({ binding: binding(), planChainable: false }).nodes.find((n) => n.kind === 'plan')?.meta,
    ).toBe('no declared outputs');
  });

  it('falls back to the plan slug when the workflow has no label', () => {
    expect(buildWorkflowGraph({ binding: binding() }).nodes.find((n) => n.kind === 'plan')?.label)
      .toBe('meeting-prep-brief');
    expect(
      buildWorkflowGraph({ binding: binding(), workflowLabel: '   ' }).nodes.find((n) => n.kind === 'plan')?.label,
    ).toBe('meeting-prep-brief');
  });
});

describe('describeEventFilter', () => {
  it('returns null for an empty filter so the caller can omit the node', () => {
    expect(describeEventFilter({})).toBeNull();
  });

  it('describes the predicate shapes the engine ships', () => {
    expect(describeEventFilter({ 'attendees.0': { exists: true } })).toBe('attendees.0 exists');
    expect(describeEventFilter({ 'labels.spam': { exists: false } })).toBe('labels.spam missing');
    expect(describeEventFilter({ from: { equals: 'boss@example.com' } })).toBe('from = boss@example.com');
    expect(describeEventFilter({ subject: { contains: 'invoice' } })).toBe('subject contains "invoice"');
  });

  it('falls back to the bare path for a predicate it does not recognise', () => {
    // Showing the path is honest ("something is filtered here"); inventing a meaning is not.
    expect(describeEventFilter({ 'x.y': { someFutureOp: 1 } })).toBe('x.y');
  });

  it('joins several predicates', () => {
    expect(describeEventFilter({ a: { exists: true }, b: { exists: false } })).toBe('a exists · b missing');
  });
});

describe('describeStormPolicy', () => {
  it('reads BOTH spellings parseStormPolicy accepts', () => {
    // The engine accepts camelCase and snake_case. Reading only one half would report
    // "no policy" for a workflow that has one.
    expect(describeStormPolicy({ maxRuns: 5, windowSeconds: 300 })).toBe('max 5 / 5m');
    expect(describeStormPolicy({ max_runs: 5, window_seconds: 300 })).toBe('max 5 / 5m');
  });

  it('returns null when no policy is set', () => {
    expect(describeStormPolicy({})).toBeNull();
  });

  it('formats windows in the largest whole unit', () => {
    expect(describeStormPolicy({ windowSeconds: 3600 })).toBe('window 1h');
    expect(describeStormPolicy({ windowSeconds: 90 })).toBe('window 90s');
    expect(describeStormPolicy({ maxRuns: 3 })).toBe('max 3');
  });

  it('ignores non-finite garbage rather than rendering NaN', () => {
    expect(describeStormPolicy({ maxRuns: Number.NaN })).toBeNull();
    expect(describeStormPolicy({ maxRuns: 'lots' })).toBeNull();
  });

  it('annotates the hop into the plan, not a node', () => {
    const graph = buildWorkflowGraph({ binding: binding({ stormPolicy: { maxRuns: 5, windowSeconds: 300 } }) });
    const intoPlan = graph.edges.find((e) => e.to === 'plan');
    expect(intoPlan?.label).toBe('max 5 / 5m');
  });
});

describe('workflowActionType', () => {
  it('defaults exactly as binding-engine.actionType does', () => {
    expect(workflowActionType({})).toBe('launch-plan');
    expect(workflowActionType({ type: '   ' })).toBe('launch-plan');
    expect(workflowActionType({ type: 42 as unknown as string })).toBe('launch-plan');
    expect(workflowActionType({ type: '  coord:send  ' })).toBe('coord:send');
  });
});
