import { describe, expect, it, vi } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import {
  ensureGmailRespondDraftBinding,
  GMAIL_RESPOND_DRAFT_EVENT,
  GMAIL_RESPOND_DRAFT_EVENT_FILTER,
  GMAIL_RESPOND_DRAFT_INPUT_SCHEMA,
  GMAIL_RESPOND_DRAFT_PLAN,
  GMAIL_RESPOND_DRAFT_PLAN_CONTENT,
} from './gmail-flagship';
import type { ExternalTriggerSourceRow } from './source-store';

const source: ExternalTriggerSourceRow = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'papercusp-workspace',
  kind: 'gmail',
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  credentialRef: 'google-workspace:owner',
  status: 'connected',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

describe('Gmail flagship respond-with-draft binding', () => {
  it('ships a start-gated one-item plan whose anchored tool can only create a draft', () => {
    const plan = parsePlan(GMAIL_RESPOND_DRAFT_PLAN_CONTENT);
    expect(plan.isLegacy).toBe(false);
    expect(plan.frontmatter.slug).toBe(GMAIL_RESPOND_DRAFT_PLAN);
    expect(plan.frontmatter.status).toBe('ready');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ id: 'P-001', storedStatus: 'todo' });
    expect(plan.items[0].text).toContain('gmail:create-draft');
    expect(plan.items[0].text).not.toContain('send');
    expect(GMAIL_RESPOND_DRAFT_INPUT_SCHEMA.properties.trigger.properties.payload.required).toEqual([
      'id',
      'threadId',
      'from',
      'subject',
      'messageId',
      'direction',
    ]);
  });

  it('installs the plan before one disarmed binding filtered to complete inbound messages', async () => {
    const ensurePlan = vi.fn(async () => ({ created: true, schemaAdded: true }));
    const ensureBinding = vi.fn(async (_sql, _workspaceId, input) => ({
      id: '33333333-3333-4333-8333-333333333333',
      sourceId: input.sourceId,
      sourceKind: 'gmail',
      planHarnessSlug: input.planHarnessSlug,
      planSlug: input.planSlug,
      goalId: null,
      eventPattern: input.eventPattern,
      eventFilter: input.eventFilter ?? {},
      action: { type: 'launch-plan' },
      armed: false,
      stormPolicy: {},
      createdBy: input.createdBy ?? null,
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    }));
    const result = await ensureGmailRespondDraftBinding({} as never, source.workspaceId, source, 'owner:fixture', {
      ensurePlan,
      ensureBinding,
    });
    expect(result).toMatchObject({ plan: { created: true }, binding: { armed: false } });
    expect(ensurePlan).toHaveBeenCalledBefore(ensureBinding);
    expect(ensureBinding).toHaveBeenCalledWith(expect.anything(), source.workspaceId, {
      sourceId: source.id,
      planHarnessSlug: 'papercusp',
      planSlug: GMAIL_RESPOND_DRAFT_PLAN,
      eventPattern: GMAIL_RESPOND_DRAFT_EVENT,
      eventFilter: GMAIL_RESPOND_DRAFT_EVENT_FILTER,
      createdBy: 'owner:fixture',
    });
  });
});
