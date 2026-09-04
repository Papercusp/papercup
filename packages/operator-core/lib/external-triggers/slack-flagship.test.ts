import { describe, expect, it, vi } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import {
  ensureSlackRespondInThreadBinding,
  SLACK_RESPOND_IN_THREAD_EVENT,
  SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA,
  SLACK_RESPOND_IN_THREAD_PLAN,
  SLACK_RESPOND_IN_THREAD_PLAN_CONTENT,
} from './slack-flagship';
import type { ExternalTriggerSourceRow } from './source-store';

const source: ExternalTriggerSourceRow = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'papercusp-workspace',
  kind: 'slack',
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  credentialRef: 'slack-socket:owner',
  providerAccountId: 'T1',
  status: 'connected',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

describe('Slack flagship respond-in-thread binding', () => {
  it('ships a start-gated one-item plan that can only reply through the anchored tool', () => {
    const plan = parsePlan(SLACK_RESPOND_IN_THREAD_PLAN_CONTENT);
    expect(plan.isLegacy).toBe(false);
    expect(plan.frontmatter.slug).toBe(SLACK_RESPOND_IN_THREAD_PLAN);
    expect(plan.frontmatter.status).toBe('ready');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ id: 'P-001', storedStatus: 'todo' });
    expect(plan.items[0].text).toContain('slack:respond-in-thread');
    // WI-2143575: the engine projects `trigger.payload` OUT of plan-run inputs
    // because those inputs federate, so the schema must not require it — a
    // schema that did would refuse every launch, silently.
    expect(SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA.properties.trigger.required).toEqual([
      'key',
      'source',
      'event',
      'sourceId',
      'externalId',
      'dedupeKey',
    ]);
    expect(SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA.properties.trigger.properties).not.toHaveProperty('payload');
    // The mention still has to reach the agent — by reference, not by embedding.
    expect(plan.items[0].text).toContain('triggers:read-payload');
  });

  it('installs the canonical plan before one disarmed mention binding', async () => {
    const ensurePlan = vi.fn(async () => ({ created: true, schemaAdded: true, refreshed: false }));
    const ensureBinding = vi.fn(async (_sql, _workspaceId, input) => ({
      id: '33333333-3333-4333-8333-333333333333',
      sourceId: input.sourceId,
      sourceKind: 'slack',
      planHarnessSlug: input.planHarnessSlug,
      planSlug: input.planSlug,
      goalId: null,
      workItemHarnessSlug: null,
      workItemKind: null,
      eventPattern: input.eventPattern,
      eventFilter: {},
      action: { type: 'launch-plan' },
      armed: false,
      stormPolicy: {},
      createdBy: input.createdBy ?? null,
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    }));
    const result = await ensureSlackRespondInThreadBinding({} as never, source.workspaceId, source, 'owner:fixture', {
      ensurePlan,
      ensureBinding,
    });
    expect(result).toMatchObject({ plan: { created: true }, binding: { armed: false } });
    expect(ensurePlan).toHaveBeenCalledBefore(ensureBinding);
    expect(ensureBinding).toHaveBeenCalledWith(expect.anything(), source.workspaceId, {
      sourceId: source.id,
      planHarnessSlug: 'papercusp',
      planSlug: SLACK_RESPOND_IN_THREAD_PLAN,
      eventPattern: SLACK_RESPOND_IN_THREAD_EVENT,
      createdBy: 'owner:fixture',
    });
  });
});
