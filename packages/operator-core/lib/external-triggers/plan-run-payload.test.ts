import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  readTriggerPlanRunPayload,
  redactTriggerArgsForPlanInputs,
  type TriggerRunArgs,
} from './plan-run-payload';
import { GMAIL_RESPOND_DRAFT_INPUT_SCHEMA } from './gmail-flagship';
import { SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA } from './slack-flagship';
import { evaluatePlanStartReadiness } from '../agent-tools/plans/plan-input-validation';

function gmailArgs(): TriggerRunArgs {
  return {
    trigger: {
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      sourceId: '2b7f9e2a-0000-4000-8000-000000000001',
      externalId: '19abc0011',
      occurredAt: '2026-09-04T09:00:00.000Z',
      datatypeId: 'email-message',
      dedupeKey: 'gmail:19abc0011',
      payload: {
        id: '19abc0011',
        threadId: 't-19abc0011',
        from: 'someone@example.com',
        subject: 'Quarterly numbers',
        messageId: '<abc@mail.example.com>',
        direction: 'inbound',
        text: 'PRIVATE BODY — must never reach a federated record.',
      },
    },
  };
}

function slackArgs(): TriggerRunArgs {
  return {
    trigger: {
      key: 'ext:slack:mention',
      source: 'slack',
      event: 'mention',
      sourceId: '2b7f9e2a-0000-4000-8000-000000000002',
      externalId: 'C123:1725440000.001',
      occurredAt: '2026-09-04T09:00:00.000Z',
      datatypeId: 'slack-message',
      dedupeKey: 'slack:C123:1725440000.001',
      payload: { channelId: 'C123', threadId: '1725440000.001', text: 'PRIVATE MENTION TEXT' },
    },
  };
}

describe('redactTriggerArgsForPlanInputs', () => {
  it('drops the private payload and keeps every routing field', () => {
    const projected = redactTriggerArgsForPlanInputs(gmailArgs());
    expect(projected.trigger).not.toHaveProperty('payload');
    expect(projected.trigger).toEqual({
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      sourceId: '2b7f9e2a-0000-4000-8000-000000000001',
      externalId: '19abc0011',
      occurredAt: '2026-09-04T09:00:00.000Z',
      datatypeId: 'email-message',
      dedupeKey: 'gmail:19abc0011',
    });
  });

  it('does not carry the private body anywhere in the serialized projection', () => {
    const serialized = JSON.stringify(redactTriggerArgsForPlanInputs(gmailArgs()));
    expect(serialized).not.toContain('PRIVATE BODY');
    expect(serialized).not.toContain('someone@example.com');
  });

  it('leaves the source args untouched — trigger_runs.args must keep the payload', () => {
    const args = gmailArgs();
    redactTriggerArgsForPlanInputs(args);
    expect(args.trigger.payload).toMatchObject({ direction: 'inbound' });
    expect(args.trigger.payload.text).toContain('PRIVATE BODY');
  });
});

/**
 * THE LOCKSTEP GUARD (WI-2143575).
 *
 * The engine stopping sending `trigger.payload` and the installed input schema
 * still REQUIRING it is a silent-breakage pair: every launch fails validation and
 * a refused launch produces no run and no error surface. These assertions run the
 * engine's real projection through the real start-gate oracle — the same
 * `evaluatePlanStartReadiness` that `plan-run-action.ts` consults — so the two
 * halves cannot drift apart without a red test.
 */
describe('projected plan inputs satisfy the flagship input schemas', () => {
  it('gmail: the redacted envelope is start-ready', () => {
    const verdict = evaluatePlanStartReadiness(
      { template: null, inputSchema: GMAIL_RESPOND_DRAFT_INPUT_SCHEMA },
      redactTriggerArgsForPlanInputs(gmailArgs()),
    );
    expect(verdict).toEqual({ ready: true, source: 'input-schema' });
  });

  it('slack: the redacted envelope is start-ready', () => {
    const verdict = evaluatePlanStartReadiness(
      { template: null, inputSchema: SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA },
      redactTriggerArgsForPlanInputs(slackArgs()),
    );
    expect(verdict).toEqual({ ready: true, source: 'input-schema' });
  });

  it('neither flagship schema still requires the private payload', () => {
    for (const schema of [GMAIL_RESPOND_DRAFT_INPUT_SCHEMA, SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA]) {
      expect(schema.properties.trigger.required).not.toContain('payload');
      expect(schema.properties.trigger.properties).not.toHaveProperty('payload');
    }
  });

  /**
   * CALIBRATION — proves the three assertions above can actually fail. A schema
   * identical to the shipped one except that it still requires `payload` must
   * REJECT the projection. Without this, a validator that passed everything
   * would make the whole block green and meaningless.
   */
  it('CONTROL: a schema that still requires payload rejects the projection', () => {
    const stale = {
      ...GMAIL_RESPOND_DRAFT_INPUT_SCHEMA,
      properties: {
        trigger: {
          ...GMAIL_RESPOND_DRAFT_INPUT_SCHEMA.properties.trigger,
          required: [...GMAIL_RESPOND_DRAFT_INPUT_SCHEMA.properties.trigger.required, 'payload'],
        },
      },
    };
    const verdict = evaluatePlanStartReadiness(
      { template: null, inputSchema: stale },
      redactTriggerArgsForPlanInputs(gmailArgs()),
    );
    expect(verdict.ready).toBe(false);
  });

  /**
   * CONTROL: the same oracle accepts the UNREDACTED args too, so a green result
   * above is evidence about the projection and not about a schema so loose it
   * accepts anything.
   */
  it('CONTROL: the unredacted envelope is also start-ready under the shipped schema', () => {
    const verdict = evaluatePlanStartReadiness(
      { template: null, inputSchema: GMAIL_RESPOND_DRAFT_INPUT_SCHEMA },
      gmailArgs(),
    );
    expect(verdict.ready).toBe(true);
  });
});

function stubSql(rows: unknown[]): postgres.Sql {
  return ((..._ignored: unknown[]) => Promise.resolve(rows)) as unknown as postgres.Sql;
}

describe('readTriggerPlanRunPayload', () => {
  it('returns the private payload resolved server-side from the local trigger run', async () => {
    const sql = stubSql([{ triggerRunId: 'run-1', args: gmailArgs() }]);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 974);
    expect(result.triggerRunId).toBe('run-1');
    expect(result.key).toBe('ext:gmail:message.received');
    expect(result.source).toBe('gmail');
    expect(result.dedupeKey).toBe('gmail:19abc0011');
    expect(result.payload.text).toContain('PRIVATE BODY');
  });

  it('is source-agnostic — one reader serves slack as well as gmail', async () => {
    const sql = stubSql([{ triggerRunId: 'run-2', args: slackArgs() }]);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 42);
    expect(result.source).toBe('slack');
    expect(result.payload.channelId).toBe('C123');
  });

  it('refuses a non-positive or non-integral planRunId before touching the database', async () => {
    const sql = stubSql([]);
    await expect(readTriggerPlanRunPayload(sql, 'w', 0)).rejects.toThrow('trigger_payload_plan_run_id_invalid');
    await expect(readTriggerPlanRunPayload(sql, 'w', -3)).rejects.toThrow('trigger_payload_plan_run_id_invalid');
    await expect(readTriggerPlanRunPayload(sql, 'w', 1.5)).rejects.toThrow('trigger_payload_plan_run_id_invalid');
  });

  it('throws a typed not-found rather than returning an empty payload', async () => {
    const sql = stubSql([]);
    await expect(readTriggerPlanRunPayload(sql, 'papercusp-workspace', 999)).rejects.toThrow(
      'trigger_payload_run_not_found:999',
    );
  });

  it('degrades to an empty payload object when a legacy row carries no trigger envelope', async () => {
    const sql = stubSql([{ triggerRunId: 'run-3', args: {} }]);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 7);
    expect(result.payload).toEqual({});
    expect(result.key).toBe('');
  });
});
