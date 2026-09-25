import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../work-items';
import {
  projectBlueprintOperationStatus,
  type BlueprintOperationHandle,
} from './operation-service';

const revision = 'a'.repeat(64);
const direct: BlueprintOperationHandle = {
  workspaceId: 'consumer-one', harnessSlug: 'neutral-a', receiptId: 12,
  operationId: 'summarize', specificationRevision: revision,
  target: { kind: 'work-item', id: 'WI-12' },
};
const plan: BlueprintOperationHandle = {
  ...direct, receiptId: 13,
  target: { kind: 'plan', runId: 25, instanceSlug: 'template@run-25' },
};

function item(id: string, state: string, assignee: string | null = null): WorkItem {
  return { id, state, assignee, family: 'feature', kind: 'feature',
    completionAuthority: state === 'passed' ? 'validated' : null } as WorkItem;
}

describe('projectBlueprintOperationStatus', () => {
  it('keeps accepted, dispatched, waiting, and terminal states distinct', () => {
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'open')])).toMatchObject({
      phase: 'accepted', outcome: null,
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'open', 'worker-a')])).toMatchObject({
      phase: 'dispatched', outcome: null,
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'blocked', 'worker-a')])).toMatchObject({
      phase: 'waiting', outcome: null,
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'passed')])).toMatchObject({
      phase: 'terminal', outcome: 'succeeded',
    });
    expect(projectBlueprintOperationStatus(direct, [{ ...item('WI-12', 'done'), completionAuthority: 'committed' }]))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(projectBlueprintOperationStatus(direct, [{ ...item('WI-12', 'passed'), completionAuthority: null }]))
      .toMatchObject({ phase: 'terminal', outcome: 'unverified' });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'deprecated')])).toMatchObject({
      phase: 'terminal', outcome: 'dropped',
    });
    expect(projectBlueprintOperationStatus(direct, [item('WI-12', 'dropped')])).toMatchObject({
      phase: 'terminal', outcome: 'dropped',
    });
  });

  it('does not present a partially settled plan as a completed result', () => {
    const status = projectBlueprintOperationStatus(
      plan, [item('WI-a', 'passed'), item('WI-b', 'blocked')],
      { status: 'running', outcome: null },
    );
    expect(status).toMatchObject({ phase: 'waiting', outcome: null });
    expect(status.items.map((entry) => entry.id)).toEqual(['WI-a', 'WI-b']);
  });

  it('does not treat a plan acceptance with no promoted items as success', () => {
    expect(projectBlueprintOperationStatus(plan, [], { status: 'running', outcome: null })).toMatchObject({
      phase: 'accepted', outcome: null,
    });
    expect(projectBlueprintOperationStatus(plan, [], { status: 'failed', outcome: 'failed' })).toMatchObject({
      phase: 'terminal', outcome: 'failed',
    });
    expect(projectBlueprintOperationStatus(plan, [], { status: 'done', outcome: 'success' })).toMatchObject({
      phase: 'terminal', outcome: 'succeeded',
    });
    expect(projectBlueprintOperationStatus(plan, [item('WI-pending', 'open')], { status: 'done', outcome: 'success' }))
      .toMatchObject({ phase: 'accepted', outcome: null });
  });
});
