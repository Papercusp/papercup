/**
 * fanout-projection.test.ts — the pure fan-out runner over injected deps (no
 * PG): table→ObjectRef mapping, subscriber resolution, delivery-mode gating,
 * and no-op for unmapped tables.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSubscriber } from '@papercusp/coordination/capabilities';
import type { InjectEvent } from '../../agent-tools/coordination/fanout-delivery';
import {
  getSubscribableMapping,
  runFanoutForOutboxRow,
  registerSubscribableTable,
  type OutboxFanoutRow,
} from './fanout-projection';

function recorder() {
  const calls: { outboxId: string; sub: ResolvedSubscriber; ev: InjectEvent }[] = [];
  return {
    calls,
    deliver: vi.fn(async (outboxId: string, sub: ResolvedSubscriber, ev: InjectEvent) => {
      calls.push({ outboxId, sub, ev });
      return true;
    }),
  };
}

const SUBS: ResolvedSubscriber[] = [
  { subscriber_id: 'agA', delivery_mode: 'full', via: 'object' },
  { subscriber_id: 'agB', delivery_mode: 'digest', via: 'topic:area' },
  { subscriber_id: 'agC', delivery_mode: 'mention', via: 'object' },
];

describe('runFanoutForOutboxRow', () => {
  it('maps a feature change to {kind:feature, ref:key} and delivers to full+digest subscribers (mention dropped)', async () => {
    const rec = recorder();
    const row: OutboxFanoutRow = {
      id: 42,
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-1',
      row: { status: 'validating', title: 'Do the thing' },
    };
    const n = await runFanoutForOutboxRow(row, { resolve: async () => SUBS, deliver: rec.deliver });
    expect(n).toBe(2); // agC (mention, non-resolution) dropped
    const recipients = rec.calls.map((c) => c.sub.subscriber_id);
    expect(recipients).toEqual(['agA', 'agB']);
    const ev = rec.calls[0].ev;
    expect(ev.subject).toBe('feature:F-1');
    expect(ev.notify_kind).toBe('feature_updated');
    expect(ev.summary).toContain('F-1');
    expect(ev.summary).toContain('validating');
    expect(rec.calls[0].outboxId).toBe('42');
  });

  it('delivers to a mention subscriber when the change is a resolution (feature passed)', async () => {
    const rec = recorder();
    const row: OutboxFanoutRow = {
      id: 7,
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-2',
      row: { status: 'passed', title: 'Done' },
    };
    const n = await runFanoutForOutboxRow(row, { resolve: async () => SUBS, deliver: rec.deliver });
    expect(n).toBe(3); // mention subscriber now included (resolution)
    expect(rec.calls.map((c) => c.sub.subscriber_id)).toContain('agC');
  });

  it('a del op renders a removal summary', async () => {
    const rec = recorder();
    const row: OutboxFanoutRow = { id: 9, table_name: 'harness_issues_consolidated', op: 'del', key: 'ISS-3', row: null };
    await runFanoutForOutboxRow(row, { resolve: async () => [SUBS[0]], deliver: rec.deliver });
    expect(rec.calls[0].ev.summary).toBe('issue ISS-3 removed');
    expect(rec.calls[0].ev.notify_kind).toBe('issue_removed');
  });

  it('is a no-op for an unmapped (non-subscribable) table', async () => {
    const rec = recorder();
    const resolve = vi.fn(async () => SUBS);
    const row: OutboxFanoutRow = { id: 1, table_name: 'contributor_usage_events', op: 'put', key: 'e1', row: {} };
    const n = await runFanoutForOutboxRow(row, { resolve, deliver: rec.deliver });
    expect(n).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(rec.deliver).not.toHaveBeenCalled();
  });

  it('is a no-op when no subscribers resolve', async () => {
    const rec = recorder();
    const row: OutboxFanoutRow = { id: 2, table_name: 'harness_plans', op: 'put', key: 'my-plan', row: { status: 'active' } };
    const n = await runFanoutForOutboxRow(row, { resolve: async () => [], deliver: rec.deliver });
    expect(n).toBe(0);
    expect(rec.deliver).not.toHaveBeenCalled();
  });

  it('seeds the pipeline objects (feature/issue/plan); a companion can register more', () => {
    expect(getSubscribableMapping('harness_features_consolidated')?.kind).toBe('feature');
    expect(getSubscribableMapping('harness_issues_consolidated')?.kind).toBe('issue');
    expect(getSubscribableMapping('harness_plans')?.kind).toBe('plan');
    expect(getSubscribableMapping('engineer_issues')).toBeUndefined();
    registerSubscribableTable('engineer_issues', {
      kind: 'engineer_issue',
      ref: (k) => k,
      summary: (_op, _row, ref) => `engineer issue ${ref}`,
      notifyKind: { put: 'engineer_issue_updated', del: 'engineer_issue_removed' },
    });
    expect(getSubscribableMapping('engineer_issues')?.kind).toBe('engineer_issue');
  });

  it('the mapping conditions are declarative data (adopt-event-rules-engines D-005): notifyKind per-op map + isResolution DataCondition', () => {
    const feature = getSubscribableMapping('harness_features_consolidated')!;
    // notifyKind is a serializable per-op map, not a function.
    expect(feature.notifyKind).toEqual({ put: 'feature_updated', del: 'feature_removed' });
    // isResolution is a serializable @papercusp/rules DataCondition over {op,key,row}.
    expect(feature.isResolution).toEqual({ op: { notEquals: 'del' }, 'row.status': { in: ['passed', 'deprecated'] } });
  });

  it('a del op is never a resolution even when the row carries a terminal status (the notEquals leg)', async () => {
    const rec = recorder();
    const row: OutboxFanoutRow = {
      id: 11,
      table_name: 'harness_features_consolidated',
      op: 'del',
      key: 'F-9',
      row: { status: 'passed' },
    };
    const n = await runFanoutForOutboxRow(row, { resolve: async () => SUBS, deliver: rec.deliver });
    expect(n).toBe(2); // mention subscriber NOT included — a delete is not a resolution
    expect(rec.calls.every((c) => c.ev.isResolution === false)).toBe(true);
  });
});
