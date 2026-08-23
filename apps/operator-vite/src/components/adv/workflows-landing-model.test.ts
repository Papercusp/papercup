import { describe, expect, it } from 'vitest';
import type { ExternalTriggerSourceAdminRow } from '@papercusp/operator-core/lib/external-triggers/admin';
import {
  buildActiveNow,
  buildNeedsYou,
  buildSuggestionChips,
  buildWorkflowLedger,
  formatChain,
  relativeSince,
  toLandingWorkflow,
  type LandingSourceInput,
  type LandingWorkflowInput,
} from './workflows-landing-model';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

function source(overrides: Partial<LandingSourceInput> = {}): LandingSourceInput {
  return {
    id: 'src-gmail',
    kind: 'google-gmail',
    status: 'connected',
    lastError: null,
    failedDeliveries24h: 0,
    bindingCount: 2,
    ...overrides,
  };
}

function workflow(overrides: Partial<LandingWorkflowInput> = {}): LandingWorkflowInput {
  return {
    id: 'wf-1',
    label: 'Meeting prep brief',
    running: false,
    paused: false,
    needsAttention: false,
    lastAt: NOW - 15 * 60_000,
    spendLabel: '$1.64',
    chainKinds: ['trigger', 'plan'],
    ...overrides,
  };
}

describe('workflows-landing-model — structural contract with operator-core', () => {
  it('accepts a real ExternalTriggerSourceAdminRow', () => {
    const row: ExternalTriggerSourceAdminRow = {
      id: 'src-1',
      kind: 'google-gmail',
      status: 'connected',
      config: {},
      credentialRef: null,
      cursor: {},
      lastConnectedAt: '2026-08-23T11:00:00.000Z',
      lastError: null,
      bindingCount: 2,
      armedBindingCount: 1,
      failedDeliveries24h: 0,
    };
    const accepted: LandingSourceInput = row;
    expect(buildSuggestionChips([accepted])).toHaveLength(1);
  });
});

describe('buildNeedsYou — the strip exists to interrupt, so it must stay quiet (D-018)', () => {
  it('returns an EMPTY array when nothing needs the operator', () => {
    // Not an "all clear" item — the caller renders nothing at all. An always-present strip
    // is precisely what D-018 rejects, and an "all good" row would reintroduce it.
    const items = buildNeedsYou({ sources: [source()], workflows: [workflow()] });
    expect(items).toEqual([]);
  });

  it('flags a disconnected source that something actually depends on', () => {
    const items = buildNeedsYou({
      sources: [source({ status: 'disconnected', bindingCount: 3 })],
      workflows: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'reconnect', actionLabel: 'Reconnect', severity: 'bad' });
    expect(items[0].message).toMatch(/Gmail/);
  });

  it('stays quiet about a broken source that nothing is bound to yet', () => {
    // Nothing depends on it, so it is not something the operator must act on now.
    const items = buildNeedsYou({
      sources: [source({ status: 'disconnected', bindingCount: 0 })],
      workflows: [],
    });
    expect(items).toEqual([]);
  });

  it('prefers the concrete error text over the bare status', () => {
    const items = buildNeedsYou({
      sources: [source({ status: 'error', lastError: 'invalid_grant' })],
      workflows: [],
    });
    expect(items[0].message).toMatch(/invalid_grant/);
  });

  it('reports dead-letter deliveries, pluralised honestly', () => {
    const one = buildNeedsYou({ sources: [source({ failedDeliveries24h: 1 })], workflows: [] });
    expect(one[0].message).toMatch(/1 failed delivery in the last 24h/);
    const many = buildNeedsYou({ sources: [source({ failedDeliveries24h: 2 })], workflows: [] });
    expect(many[0].message).toMatch(/2 failed deliveries in the last 24h/);
  });

  it('flags a workflow that needs attention', () => {
    const items = buildNeedsYou({
      sources: [source()],
      workflows: [workflow({ needsAttention: true, label: 'Meeting prep brief' })],
    });
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe('Meeting prep brief needs attention');
  });

  it('never fabricates a credential-expiry warning', () => {
    // The artboard shows "token expires in 3 days", but no expiry field exists on the source
    // row. A countdown derived from nothing would be a false alarm in the one strip whose
    // value depends entirely on only firing when something is really wrong.
    const items = buildNeedsYou({
      sources: [source({ status: 'connected', failedDeliveries24h: 0 })],
      workflows: [],
    });
    expect(items.some((i) => /expir/i.test(i.message))).toBe(false);
  });
});

describe('buildSuggestionChips — source-derived, never a fixed menu', () => {
  it('offers a chip only for a source that is actually connected', () => {
    const chips = buildSuggestionChips([
      source({ kind: 'google-gmail' }),
      source({ id: 'src-slack', kind: 'slack', status: 'disconnected' }),
    ]);
    expect(chips.map((c) => c.sourceKind)).toEqual(['google-gmail']);
    // Suggesting Slack with no Slack connected invites a workflow that cannot be built.
    expect(chips.some((c) => /Slack/.test(c.text))).toBe(false);
  });

  it('derives one chip per distinct connected kind', () => {
    const chips = buildSuggestionChips([
      source({ id: 'a', kind: 'google-gmail' }),
      source({ id: 'b', kind: 'google-calendar' }),
      source({ id: 'c', kind: 'slack' }),
      source({ id: 'd', kind: 'schedule' }),
    ]);
    expect(chips.map((c) => c.text)).toEqual([
      'When an email from a client arrives…',
      'Before my next meeting…',
      'When someone mentions me in Slack…',
      'Every morning at 9…',
    ]);
  });

  it('de-duplicates two connections of the same kind', () => {
    const chips = buildSuggestionChips([
      source({ id: 'a', kind: 'google-gmail' }),
      source({ id: 'b', kind: 'google-gmail' }),
    ]);
    expect(chips).toHaveLength(1);
  });

  it('skips a source kind it has no operator-language prompt for', () => {
    // Better no chip than a chip reading "google-pubsub…".
    const chips = buildSuggestionChips([source({ kind: 'google-pubsub' })]);
    expect(chips).toEqual([]);
  });

  it('treats a connected-but-erroring source as not connected', () => {
    const chips = buildSuggestionChips([source({ status: 'connected', lastError: 'invalid_grant' })]);
    expect(chips).toEqual([]);
  });
});

describe('buildActiveNow — "active" must not overstate what is running', () => {
  it('includes a workflow that fired inside the window', () => {
    const { rows } = buildActiveNow([workflow({ lastAt: NOW - 15 * 60_000 })], { nowMs: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].lastLabel).toBe('15m ago');
  });

  it('excludes an installed workflow that has never fired', () => {
    const { rows } = buildActiveNow([workflow({ lastAt: null, running: false })], { nowMs: NOW });
    expect(rows).toEqual([]);
  });

  it('excludes a workflow whose last fire is outside the window', () => {
    const { rows } = buildActiveNow([workflow({ lastAt: NOW - 48 * 3600_000 })], { nowMs: NOW });
    expect(rows).toEqual([]);
  });

  it('includes a currently-running workflow even if it has never completed a fire', () => {
    const { rows } = buildActiveNow([workflow({ lastAt: null, running: true })], { nowMs: NOW });
    expect(rows).toHaveLength(1);
  });

  it('reports firesToday as null when it was not measured, never as 0', () => {
    // 0 fires and "we did not count" are different claims.
    expect(buildActiveNow([workflow()], { nowMs: NOW }).firesToday).toBeNull();
    expect(buildActiveNow([workflow()], { nowMs: NOW, firesToday: 0 }).firesToday).toBe(0);
  });
});

describe('buildWorkflowLedger', () => {
  it('lists every workflow, including ones active-now excludes', () => {
    const workflows = [workflow({ id: 'a', lastAt: null }), workflow({ id: 'b', lastAt: NOW - 60_000 })];
    expect(buildWorkflowLedger(workflows, { nowMs: NOW }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(buildActiveNow(workflows, { nowMs: NOW }).rows.map((r) => r.id)).toEqual(['b']);
  });

  it('renders a never-fired workflow with a null last label rather than a fake time', () => {
    expect(buildWorkflowLedger([workflow({ lastAt: null })], { nowMs: NOW })[0].lastLabel).toBeNull();
  });
});

describe('formatChain', () => {
  it('renders the artboard arrow chain', () => {
    expect(formatChain(['gmail', 'recipe', 'filed'])).toBe('gmail → recipe → filed');
  });

  it('says "not wired" rather than rendering an empty string', () => {
    expect(formatChain([])).toBe('not wired');
  });
});

describe('toLandingWorkflow — adapting an automation row', () => {
  const base = {
    id: 'plan:papercusp/meeting-prep',
    label: 'Meeting prep brief',
    running: false,
    paused: false,
    needsAttention: false,
    lastAt: NOW - 60_000,
    spendLabel: '$1.64',
    triggers: [{ kind: 'external' as const, provider: 'google-calendar' }],
    flow: { outcomeLabel: 'Reply' },
  };

  it('builds the artboard chain from trigger, plan and outcome', () => {
    expect(toLandingWorkflow(base).chainKinds).toEqual(['calendar', 'plan', 'reply']);
  });

  it('uses the short provider token the artboard shows', () => {
    expect(
      toLandingWorkflow({ ...base, triggers: [{ kind: 'external', provider: 'google-gmail' }] }).chainKinds[0],
    ).toBe('gmail');
    expect(
      toLandingWorkflow({ ...base, triggers: [{ kind: 'schedule', provider: 'cron' }] }).chainKinds[0],
    ).toBe('schedule');
  });

  it('passes an unknown provider through rather than dropping the step', () => {
    expect(
      toLandingWorkflow({ ...base, triggers: [{ kind: 'external', provider: 'linear' }] }).chainKinds[0],
    ).toBe('linear');
  });

  it('omits the outcome step when the row declares none', () => {
    // Inventing a terminal step would claim the workflow does something it does not.
    expect(toLandingWorkflow({ ...base, flow: null }).chainKinds).toEqual(['calendar', 'plan']);
    expect(toLandingWorkflow({ ...base, flow: { outcomeLabel: '  ' } }).chainKinds).toEqual([
      'calendar',
      'plan',
    ]);
  });

  it('still yields a renderable chain for a workflow with no trigger', () => {
    const adapted = toLandingWorkflow({ ...base, triggers: [], flow: null });
    expect(adapted.chainKinds).toEqual(['plan']);
    expect(formatChain(adapted.chainKinds)).toBe('plan');
  });

  it('carries the fields the ledger renders', () => {
    const adapted = toLandingWorkflow({ ...base, needsAttention: true, paused: true });
    expect(adapted).toMatchObject({
      id: 'plan:papercusp/meeting-prep',
      label: 'Meeting prep brief',
      needsAttention: true,
      paused: true,
      spendLabel: '$1.64',
    });
  });
});

describe('relativeSince', () => {
  it('covers the ledger buckets', () => {
    expect(relativeSince(NOW - 30_000, NOW)).toBe('just now');
    expect(relativeSince(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeSince(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
    expect(relativeSince(NOW - 26 * 3600_000, NOW)).toBe('yesterday');
    expect(relativeSince(NOW - 72 * 3600_000, NOW)).toBe('3d ago');
  });

  it('calls a future timestamp scheduled instead of a negative age', () => {
    expect(relativeSince(NOW + 60_000, NOW)).toBe('scheduled');
  });
});
