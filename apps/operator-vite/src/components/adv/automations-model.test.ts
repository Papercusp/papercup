import { describe, expect, it } from 'vitest';
import type { AutomationCatalog, AutomationRoutine } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';
import {
  buildAutomationActivity,
  buildAutomationFlows,
  buildAutomationItems,
  buildAutomationSources,
  filterAutomationItems,
  type BuildAutomationModelInput,
} from './automations-model';

const NOW = Date.parse('2026-08-22T20:00:00.000Z');

function routine(overrides: Partial<AutomationRoutine> = {}): AutomationRoutine {
  return {
    name: 'git-sync',
    installSlug: 'papercusp',
    group: 'git-sync',
    category: 'infra',
    cron: '0 */2 * * * *',
    cadence: 'every 2m',
    active: true,
    spend: 'none',
    spendWhy: 'Runs inline',
    spawnsAgent: false,
    kind: 'scheduled',
    family: 'git-release',
    liveness: 'running',
    armedState: 'armed',
    control: 'routine',
    controlWhy: 'Pause from routines:set',
    flagKey: null,
    needsAttention: false,
    installs: ['papercusp'],
    ownerId: null,
    ownerLastActiveAt: null,
    triggerLabel: null,
    lastFiredAt: '2026-08-22T19:58:00.000Z',
    nextFireAt: '2026-08-22T20:02:00.000Z',
    source: 'routines',
    controllable: true,
    ...overrides,
  };
}

function fixture(): BuildAutomationModelInput {
  const catalog: AutomationCatalog = {
    routines: [
      routine(),
      routine({
        name: 'doc-steward',
        spend: 'llm',
        spendWhy: 'Spawns a doc agent',
        spawnsAgent: true,
        family: 'docs',
        category: 'docs',
        nextFireAt: '2026-08-22T20:10:00.000Z',
      }),
    ],
    categories: [],
    spend7d: [],
    spend7dTotalUsd: 12.5,
    arming: { gymPots: [], lanes: [], scoutCeiling: null },
    generatedAt: '2026-08-22T20:00:00.000Z',
  };
  const external: ExternalTriggerAdminSnapshot = {
    enabled: true,
    counts: { sources: 2, bindings: 2, armed: 2, recentFailures: 0 },
    sources: [
      { id: 'source-slack', kind: 'slack', status: 'connected', config: {}, credentialRef: null, cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null, bindingCount: 1, armedBindingCount: 1, failedDeliveries24h: 0 },
      { id: 'source-gmail', kind: 'gmail', status: 'connected', config: {}, credentialRef: null, cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null, bindingCount: 1, armedBindingCount: 1, failedDeliveries24h: 0 },
    ],
    bindings: [
      {
        id: '11111111-1111-4111-8111-111111111111', sourceId: 'source-slack', sourceKind: 'slack', sourceStatus: 'connected', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', eventPattern: 'ext:slack:message', eventFilter: {}, action: {}, armed: true, stormPolicy: {}, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastRun: { id: 'run-1', status: 'done', triggeredAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', error: null },
      },
      {
        id: '22222222-2222-4222-8222-222222222222', sourceId: 'source-gmail', sourceKind: 'gmail', sourceStatus: 'connected', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', eventPattern: 'ext:gmail:label', eventFilter: {}, action: {}, armed: true, stormPolicy: {}, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastRun: null,
      },
    ],
    recentRuns: [
      { id: 'run-1', bindingId: '11111111-1111-4111-8111-111111111111', sourceKind: 'slack', eventPattern: 'ext:slack:message', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', status: 'done', attempts: 1, triggeredAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', planRunRef: 'customer-digest-run-1', error: null },
    ],
  };
  return {
    catalog,
    plans: [{
      slug: 'customer-digest',
      title: 'Customer feedback digest',
      harness: 'papercusp',
      status: 'ready',
      nextAction: 'Turns feedback into a prioritized brief',
      triggered: true,
      triggerSources: ['schedule', 'external', 'manual'],
      scheduleActive: true,
    }],
    schedules: [{
      templateSlug: 'customer-digest',
      title: 'Customer feedback digest',
      harnessSlug: 'papercusp',
      schedule: { rrule: 'RRULE:FREQ=DAILY;BYHOUR=9', tzid: 'America/New_York' },
      scheduledAt: null,
      expiresAt: null,
      tzid: 'America/New_York',
      scheduleActive: true,
    }],
    occurrences: [{
      templateSlug: 'customer-digest',
      title: 'Customer feedback digest',
      harnessSlug: 'papercusp',
      occurrenceMs: NOW + 18 * 60_000,
      kind: 'recurring',
      scheduleActive: true,
      lastOutcome: 'success',
    }],
    external,
    nowMs: NOW,
  };
}

describe('automations model', () => {
  it('joins one triggered plan across schedule, Slack, Gmail, and manual inputs', () => {
    const items = buildAutomationItems(fixture());
    const plan = items.find((item) => item.kind === 'triggered-plan');
    expect(plan?.label).toBe('Customer feedback digest');
    expect(plan?.triggers.map((trigger) => trigger.provider)).toEqual(['schedule', 'slack', 'gmail', 'manual']);
    expect(plan?.nextAt).toBe(NOW + 18 * 60_000);
    expect(plan?.timingLabel).toBe('Next in 18m');
    expect(plan?.spendLabel).toContain('Run-linked');
    expect(plan?.flow).toMatchObject({
      sourceLabel: 'Schedule + Slack + 2 more',
      sourceDetail: '3/3 automatic armed · manual available',
      planDetail: 'papercusp · Ready',
      outcomeLabel: 'Turns feedback into a prioritized brief',
      outcomeDetail: 'Last observed outcome · Done',
      outcomeState: 'completed',
    });
  });

  it('builds flow rows only for triggered plans and keeps a truthful undeclared-next fallback', () => {
    const input = fixture();
    input.plans = [
      ...input.plans,
      {
        slug: 'manual-review',
        title: 'Manual review',
        harness: 'papercusp',
        status: 'ready',
        triggered: true,
        triggerSources: ['manual'],
      },
    ];
    const items = buildAutomationItems(input);
    const flows = buildAutomationFlows(items);
    expect(flows).toHaveLength(2);
    expect(flows.every((item) => item.kind === 'triggered-plan')).toBe(true);
    expect(flows.find((item) => item.planSlug === 'manual-review')?.flow).toMatchObject({
      sourceLabel: 'Manual',
      sourceDetail: 'Manual start available',
      outcomeLabel: 'No next action declared',
      outcomeDetail: 'No observed run yet',
      outcomeState: 'waiting',
    });
    expect(flows.some((item) => item.label === 'git-sync')).toBe(false);
  });

  it('keeps AI routines, deterministic tasks, and spend truth separate', () => {
    const items = buildAutomationItems(fixture());
    const ai = items.find((item) => item.kind === 'ai-routine');
    const system = items.find((item) => item.kind === 'system-task');
    expect(ai?.spendLabel).toBe('Model spend possible');
    expect(system?.spendLabel).toBe('$0 model spend');
    expect(filterAutomationItems(items, 'ai', '')).toEqual([ai]);
    expect(filterAutomationItems(items, 'system', 'git')).toEqual([system]);
  });

  it('builds Activity and Sources from the same joined data', () => {
    const input = fixture();
    const activity = buildAutomationActivity(input);
    expect(activity.some((row) => row.automationId?.includes('customer-digest'))).toBe(true);
    expect(activity.map((row) => row.label)).toContain('git-sync');
    const sources = buildAutomationSources(input);
    expect(sources.map((source) => source.label)).toEqual(['Schedule', 'Manual', 'slack', 'gmail']);
    expect(sources.find((source) => source.label === 'slack')?.armedCount).toBe(1);
  });
});
