import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_INGEST_REDACTION,
  isExternalTriggerEnvelope,
  redactExternalIngest,
  valueCarriesExternalIngest,
} from './external-ingest-envelope';
import { outboxRowToLocalWriteOp } from './feature-issue-op-keys';

/**
 * The exact nesting the leak takes in production (EI-22088522809897790): the owner's
 * inbound email rides inside a work-item's payload, at
 * `payload.plan_run.inputs.trigger.payload`, because `binding-engine.triggerArgs()`
 * builds ONE object used both for the owner-local `trigger_runs.args` and for the
 * FEDERATED plan-run inputs.
 */
function leakedWorkItemPayload() {
  return {
    plan_run: {
      runId: 4211,
      inputs: {
        trigger: {
          key: 'ext:gmail:message.received',
          source: 'gmail',
          event: 'message.received',
          sourceId: 'src-1',
          externalId: 'msg-abc',
          dedupeKey: 'gmail:msg-abc',
          payload: {
            id: 'msg-abc',
            threadId: 'thread-abc',
            from: 'someone@example.com',
            subject: 'Q3 numbers, confidentially',
            messageId: '<abc@mail.example.com>',
            direction: 'inbound',
            html: '<p>the full private body</p>',
          },
        },
      },
    },
  };
}

describe('isExternalTriggerEnvelope', () => {
  it('matches the ext: keyed envelope and the dedupeKey-only canonical record', () => {
    expect(isExternalTriggerEnvelope(leakedWorkItemPayload().plan_run.inputs.trigger)).toBe(true);
    expect(isExternalTriggerEnvelope({ source: 'slack', event: 'app_mention', dedupeKey: 'd1', adapterPayload: {} })).toBe(true);
  });

  it('does not match an ordinary object that merely has a payload key', () => {
    expect(isExternalTriggerEnvelope({ payload: { a: 1 } })).toBe(false);
    // source+event present but no object payload and no ext:/dedupeKey anchor
    expect(isExternalTriggerEnvelope({ source: 'gmail', event: 'message.received', payload: 'text' })).toBe(false);
    expect(isExternalTriggerEnvelope({ source: 'gmail', event: 'message.received', payload: {} })).toBe(false);
  });
});

describe('redactExternalIngest', () => {
  it('strips the private payload while keeping the routing fields and the surrounding structure', () => {
    const redacted = redactExternalIngest(leakedWorkItemPayload());
    const trigger = redacted.plan_run.inputs.trigger;

    expect(trigger.payload).toBe(EXTERNAL_INGEST_REDACTION);
    // routing fields survive — the record stays meaningful and dedupe-able for members
    expect(trigger.key).toBe('ext:gmail:message.received');
    expect(trigger.source).toBe('gmail');
    expect(trigger.dedupeKey).toBe('gmail:msg-abc');
    expect(redacted.plan_run.runId).toBe(4211);

    // and none of the private content survives anywhere in the serialized value
    const wire = JSON.stringify(redacted);
    for (const secret of ['someone@example.com', 'Q3 numbers', 'the full private body', 'thread-abc']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('is self-verifying: the redacted value no longer satisfies the predicate', () => {
    const original = leakedWorkItemPayload();
    expect(valueCarriesExternalIngest(original)).toBe(true);
    expect(valueCarriesExternalIngest(redactExternalIngest(original))).toBe(false);
  });

  it('is idempotent', () => {
    const once = redactExternalIngest(leakedWorkItemPayload());
    expect(redactExternalIngest(once)).toEqual(once);
  });

  it('redacts adapterPayload envelopes and envelopes nested inside arrays', () => {
    const value = { runs: [{ trigger: { source: 'slack', event: 'app_mention', dedupeKey: 'd1', adapterPayload: { text: 'private' } } }] };
    const redacted = redactExternalIngest(value);
    expect(redacted.runs[0].trigger.adapterPayload).toBe(EXTERNAL_INGEST_REDACTION);
    expect(JSON.stringify(redacted)).not.toContain('private');
  });

  it('returns the SAME reference when nothing carries ingest (provably a no-op for ordinary rows)', () => {
    const ordinary = { feature_id: 'WI-1', title: 'a normal row', payload: { notes: ['x'], nested: { deep: true } } };
    expect(redactExternalIngest(ordinary)).toBe(ordinary);
  });

  it('leaves a same-named payload on a NON-envelope object untouched', () => {
    const value = { payload: { subject: 'not an ingest envelope' } };
    expect(redactExternalIngest(value)).toBe(value);
  });
});

describe('outboxRowToLocalWriteOp — the post-admission replication boundary', () => {
  /**
   * Minimal outbox row for the work-item federation table. `harness_features_consolidated`
   * → tableTag 'features-by-id' is the exact carrier the 2026-09-01 seed leaked through
   * (seed-provider-corestore's header cites features-by-id PR-974), and `toFeatureValue`
   * federates `payload` verbatim (`payload: row.payload ?? null`).
   */
  function outboxRow(row: Record<string, unknown>) {
    return {
      table_name: 'harness_features_consolidated',
      op: 'put' as const,
      key: 'papercusp/EI-1',
      ts: 1_788_000_000_000,
      row,
    };
  }

  it('never appends the owner private ingest into the own log a member replicates', () => {
    const op = outboxRowToLocalWriteOp(
      outboxRow({
        workspace_id: 'papercusp-workspace',
        harness_slug: 'email',
        feature_id: 'EI-1',
        title: 'respond to inbound mail',
        payload: leakedWorkItemPayload(),
      }) as never,
    );

    expect(op.type).toBe('put');
    expect(valueCarriesExternalIngest(op.value)).toBe(false);
    const wire = JSON.stringify(op.value);
    expect(wire).not.toContain('the full private body');
    expect(wire).not.toContain('Q3 numbers');
    // the row itself still federates — redact, do not drop: an admitted member must
    // not get a hole in their work-item history to hide one field.
    expect(wire).toContain('EI-1');
  });

  it('passes an ordinary row through unchanged', () => {
    const op = outboxRowToLocalWriteOp(
      outboxRow({
        workspace_id: 'papercusp-workspace',
        harness_slug: 'papercusp',
        feature_id: 'EI-2',
        title: 'ordinary work item',
        payload: { notes: 'nothing private here' },
      }) as never,
    );
    expect(JSON.stringify(op.value)).toContain('nothing private here');
  });
});
