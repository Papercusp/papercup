// @vitest-environment node
/**
 * attention-card tests — the AttentionItem → card-spec mapper (P-010) and the
 * durable dispatch parity (P-013). The dispatch must reproduce the behavior
 * of the (retired) OtherDetail / InboxItemActions handlers exactly: same
 * backend helper, same args, and the resume-on-resolve / no-resume-on-drop
 * distinction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./plans-api', () => ({
  resolveEscalation: vi.fn(async () => ({ ok: true })),
  ackCoordMessage: vi.fn(async () => ({ ok: true })),
  setItemStatus: vi.fn(async () => ({ ok: true, oldStatus: 'needs-human', newStatus: 'done', itemId: 'P-7' })),
  addPlanDecision: vi.fn(async () => ({ ok: true, decisionId: 'D-1', slug: 'p' })),
  triageAttentionItem: vi.fn(async () => ({ ok: true })),
  decideStandingApproval: vi.fn(async () => ({ ok: true })),
  resolveConversationAnswer: vi.fn(async () => ({ ok: true, state: 'resolved' })),
  dismissImprovement: vi.fn(async () => ({ ok: true, closed: true })),
}));

import {
  attentionItemToCardSpec,
  resolveAttentionAction,
  answerAttentionItem,
} from './attention-card';
import {
  resolveEscalation,
  ackCoordMessage,
  setItemStatus,
  addPlanDecision,
  triageAttentionItem,
  decideStandingApproval,
  resolveConversationAnswer,
  dismissImprovement,
} from './plans-api';
import type { AttentionItem } from './plans-api';

/** The resume-on-resolve nudge is now a floor-debounced Queen wake through the
 *  palette bridge (the legacy /harness/:slug/launch run-loop kick is retired). */
const expectQueenWake = () =>
  expect(fetch).toHaveBeenCalledWith(
    '/api/agent-mcp/run-tool',
    expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"hive:wake"'),
    }),
  );

function item(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    id: 'x',
    kind: 'plan-item',
    source: 'plan',
    harnessSlug: 'h',
    planSlug: 'p',
    itemRef: 'P-7',
    title: 'Title',
    body: 'Body text',
    status: 'needs-human',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: null,
    ownerLabel: null,
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [],
    ref: { kind: 'plan-item' },
    ...overrides,
  } as AttentionItem;
}

const escWithOptions = item({
  kind: 'coord-escalation',
  status: 'open',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-escalation', msgId: 'm1', options: [{ id: 'retry', label: 'Retry' }, { id: 'pause', label: 'Pause' }] },
});
const escNoOptions = item({
  kind: 'coord-escalation',
  status: 'open',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-escalation', msgId: 'm9', options: [] },
});
const message = item({
  kind: 'coord-message',
  status: 'message',
  actions: [{ id: 'ack', label: 'Acknowledge', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'coord-message', msgId: 'm2' },
});
const needsHuman = item({
  actions: [
    { id: 'answer', label: 'Answer' },
    { id: 'mark-done', label: 'Resolve', primary: true },
    { id: 'drop', label: 'Drop' },
    { id: 'chat', label: 'Chat' },
  ],
  ref: { kind: 'plan-item', slug: 'p', itemId: 'P-7' },
});
const operatorReport = item({
  id: 'operator-report:turn-1',
  kind: 'operator-report',
  source: 'operator',
  harnessSlug: null,
  planSlug: null,
  title: 'Fleet status',
  body: 'plain-text fallback dump',
  status: 'report',
  tier: 'activity',
  needsHuman: false,
  ownerLabel: 'Operator',
  actions: [{ id: 'resolve', label: 'Resolve', primary: true }],
  ref: { kind: 'operator-report', turnId: 'turn-1', conversationId: 'c-1' },
  report: {
    title: 'Fleet status',
    plans: [{ title: 'Rate-limit v2', status: 'active', items: [{ text: 'pacing', status: 'wip' }] }],
  },
});
const smoke = item({
  kind: 'smoke-fail',
  status: 'fail',
  actions: [{ id: 'view-log', label: 'View log', primary: true }, { id: 'chat', label: 'Chat' }],
  ref: { kind: 'smoke-fail', harnessSlug: 'h' },
});
// D-027 follow-on (1): inline-disposition fixtures.
const standingApproval = item({
  kind: 'standing-approval',
  status: 'pending-approval',
  tier: 'decision',
  needsHuman: true,
  actions: [{ id: 'grant', label: 'Grant', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
  ref: { kind: 'standing-approval', capability: 'harness:write', targetHarness: 'sheets' },
});
const conversation = item({
  kind: 'conversation',
  status: 'open',
  tier: 'alert',
  needsHuman: false,
  actions: [{ id: 'answer', label: 'Answer', primary: true }, { id: 'message-owner', label: 'Message owner' }],
  ref: { kind: 'conversation', conversationId: 'CONV-7' },
});
const improvement = item({
  kind: 'improvement',
  status: 'needs-triage',
  tier: 'decision',
  needsHuman: true,
  actions: [{ id: 'open', label: 'Triage', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
  ref: { kind: 'improvement', issueId: 'EI-42' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)));
});
afterEach(() => vi.unstubAllGlobals());

const ids = (spec: { options: { id: string }[] }) => spec.options.map((o) => o.id);
const byId = (spec: { options: { id: string; style?: string; terminal?: boolean }[] }, id: string) =>
  spec.options.find((o) => o.id === id)!;

describe('attentionItemToCardSpec (P-010)', () => {
  it('escalation: expands the generic resolve into the named options (terminal) + chat (navigate)', () => {
    const spec = attentionItemToCardSpec(escWithOptions);
    expect(ids(spec)).toEqual(['retry', 'pause', 'chat']);
    expect(byId(spec, 'retry').terminal).toBeUndefined(); // terminal (commit)
    expect(byId(spec, 'retry').style).toBe('primary');
    expect(byId(spec, 'chat').terminal).toBe(false); // navigate
  });

  it('escalation with no named options: a single generic Resolve + chat', () => {
    const spec = attentionItemToCardSpec(escNoOptions);
    expect(ids(spec)).toEqual(['resolve', 'chat']);
    expect(byId(spec, 'resolve').terminal).toBeUndefined();
  });

  it('needs-human plan item: Answer + Drop survive (the P-009/P-010 gap)', () => {
    const spec = attentionItemToCardSpec(needsHuman);
    expect(ids(spec)).toEqual(['answer', 'mark-done', 'drop', 'chat']);
    expect(byId(spec, 'answer').terminal).toBe(false); // reveals InputCard, doesn't commit
    expect(byId(spec, 'mark-done').style).toBe('primary');
    expect(byId(spec, 'drop').style).toBe('danger');
    expect(byId(spec, 'drop').terminal).toBeUndefined(); // terminal
    expect(byId(spec, 'chat').terminal).toBe(false);
  });

  it('smoke-fail: view-log + chat are both navigate (nothing to resolve)', () => {
    const spec = attentionItemToCardSpec(smoke);
    expect(ids(spec)).toEqual(['view-log', 'chat']);
    expect(byId(spec, 'view-log').terminal).toBe(false);
  });

  it('message-owner is a navigate option (opens the thread, never commits)', () => {
    const withMsgOwner = item({
      actions: [
        { id: 'mark-done', label: 'Resolve', primary: true },
        { id: 'chat', label: 'Chat' },
        { id: 'message-owner', label: 'Message owner' },
      ],
      ref: { kind: 'plan-item', slug: 'p', itemId: 'P-7' },
    });
    const spec = attentionItemToCardSpec(withMsgOwner);
    expect(ids(spec)).toContain('message-owner');
    expect(byId(spec, 'message-owner').terminal).toBe(false); // navigate — component handles it
  });

  it('question prefers body, falls back to title', () => {
    expect(attentionItemToCardSpec(needsHuman).question).toBe('Body text');
    expect(attentionItemToCardSpec(item({ body: '   ', title: 'Just a title' })).question).toBe('Just a title');
  });

  it('operator-report: carries the ReportBlock + uses the title as the question (not the body dump)', () => {
    const spec = attentionItemToCardSpec(operatorReport);
    expect(spec.report).toBeDefined();
    expect(spec.report?.plans[0]?.title).toBe('Rate-limit v2');
    // The structured block renders natively; the question is the short title,
    // NOT the plain-text body fallback (which would duplicate the block).
    expect(spec.question).toBe('Fleet status');
    expect(ids(spec)).toEqual(['resolve']);
  });

  it('standing-approval: Grant + Dismiss are both terminal (no navigate) — D-027 follow-on (1)', () => {
    const spec = attentionItemToCardSpec(standingApproval);
    expect(ids(spec)).toEqual(['grant', 'dismiss']);
    expect(byId(spec, 'grant').terminal).toBeUndefined(); // terminal (renderer default)
    expect(byId(spec, 'dismiss').terminal).toBeUndefined();
    expect(byId(spec, 'grant').style).toBe('primary');
  });

  it('conversation: Answer is navigate (reveals the InputCard), Message owner navigate — D-027 follow-on (1)', () => {
    const spec = attentionItemToCardSpec(conversation);
    expect(byId(spec, 'answer').terminal).toBe(false); // navigate — InputCard owns it
    expect(byId(spec, 'message-owner').terminal).toBe(false);
  });

  it('improvement: Triage is navigate (full surface), Dismiss is terminal (reject) — D-027 follow-on (1)', () => {
    const spec = attentionItemToCardSpec(improvement);
    expect(byId(spec, 'open').terminal).toBe(false); // navigate — Triage surface owns place/gate/gym
    expect(byId(spec, 'dismiss').terminal).toBeUndefined(); // terminal (renderer default)
  });
});

describe('resolveAttentionAction (P-011/P-012/P-013 parity)', () => {
  it('escalation named option → resolveEscalation({msg_id, choice}) with the picked id', async () => {
    const r = await resolveAttentionAction(escWithOptions, 'retry');
    expect(resolveEscalation).toHaveBeenCalledWith({ msg_id: 'm1', choice: 'retry' });
    expect(r.resolved).toBe(true);
  });

  it('escalation with no options → choice "resolved"', async () => {
    await resolveAttentionAction(escNoOptions, 'resolve');
    expect(resolveEscalation).toHaveBeenCalledWith({ msg_id: 'm9', choice: 'resolved' });
  });

  it('message ack → ackCoordMessage({msg_id})', async () => {
    const r = await resolveAttentionAction(message, 'ack');
    expect(ackCoordMessage).toHaveBeenCalledWith({ msg_id: 'm2' });
    expect(r.resolved).toBe(true);
  });

  it('plan-item Resolve → setItemStatus done AND nudges the Queen awake', async () => {
    const r = await resolveAttentionAction(needsHuman, 'mark-done');
    expect(setItemStatus).toHaveBeenCalledWith({ slug: 'p', itemId: 'P-7', status: 'done' });
    expectQueenWake();
    expect(r.resolved).toBe(true);
  });

  it('plan-item Drop → setItemStatus dropped and does NOT resume', async () => {
    const r = await resolveAttentionAction(needsHuman, 'drop');
    expect(setItemStatus).toHaveBeenCalledWith({ slug: 'p', itemId: 'P-7', status: 'dropped' });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
  });

  it('navigate ids (chat) are not dispatched here', async () => {
    const r = await resolveAttentionAction(needsHuman, 'chat');
    expect(r.resolved).toBe(false);
    expect(setItemStatus).not.toHaveBeenCalled();
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  it('message-owner is a navigate id — not dispatched here (the thread component owns it)', async () => {
    const r = await resolveAttentionAction(needsHuman, 'message-owner');
    expect(r.resolved).toBe(false);
    expect(setItemStatus).not.toHaveBeenCalled();
  });

  it('operator-report Resolve → inbox:triage resolve (the triage state machine), keyed by item id', async () => {
    const r = await resolveAttentionAction(operatorReport, 'resolve');
    expect(triageAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'operator-report:turn-1', action: 'resolve' }),
    );
    expect(r.resolved).toBe(true);
    // It does NOT touch the plan-item / escalation backends.
    expect(setItemStatus).not.toHaveBeenCalled();
    expect(resolveEscalation).not.toHaveBeenCalled();
  });

  // D-027 follow-on (1): inline disposition for the folded kinds.
  it('standing-approval Grant → decideStandingApproval(approve) from the ref', async () => {
    const r = await resolveAttentionAction(standingApproval, 'grant');
    expect(decideStandingApproval).toHaveBeenCalledWith({ capability: 'harness:write', targetHarness: 'sheets', decision: 'approve' });
    expect(r.resolved).toBe(true);
  });

  it('standing-approval Dismiss → decideStandingApproval(dismiss)', async () => {
    const r = await resolveAttentionAction(standingApproval, 'dismiss');
    expect(decideStandingApproval).toHaveBeenCalledWith({ capability: 'harness:write', targetHarness: 'sheets', decision: 'dismiss' });
    expect(r.resolved).toBe(true);
  });

  it('conversation Answer is a navigate id — not dispatched here (the InputCard submit owns it)', async () => {
    const r = await resolveAttentionAction(conversation, 'answer');
    expect(r.resolved).toBe(false);
    expect(resolveConversationAnswer).not.toHaveBeenCalled();
  });

  it('improvement Dismiss → dismissImprovement(issueId) (triage reject); Triage stays navigate', async () => {
    const r = await resolveAttentionAction(improvement, 'dismiss');
    expect(dismissImprovement).toHaveBeenCalledWith('EI-42');
    expect(r.resolved).toBe(true);
    // The navigate `open` (Triage) is NOT dispatched here — the full surface owns it.
    const nav = await resolveAttentionAction(improvement, 'open');
    expect(nav.resolved).toBe(false);
  });
});

describe('answerAttentionItem (P-021 Answer flow parity)', () => {
  it('records a decision, marks done, and nudges the Queen awake', async () => {
    const r = await answerAttentionItem(needsHuman, 'do the thing');
    expect(addPlanDecision).toHaveBeenCalledWith({ slug: 'p', title: 'Answer to P-7', body: 'do the thing', refs: ['P-7'] });
    expect(setItemStatus).toHaveBeenCalledWith({ slug: 'p', itemId: 'P-7', status: 'done' });
    expectQueenWake();
    expect(r.resolved).toBe(true);
  });

  it('empty answer is a no-op', async () => {
    const r = await answerAttentionItem(needsHuman, '   ');
    expect(addPlanDecision).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
  });

  // D-027 follow-on (1): a conversation answers by RESOLVING with the owner's text
  // as the accepted answer (no plan decision / loop resume).
  it('conversation answer → resolveConversationAnswer({conversation_id, accepted_answer}), no plan-item writes', async () => {
    const r = await answerAttentionItem(conversation, 'use approach B');
    expect(resolveConversationAnswer).toHaveBeenCalledWith({ conversation_id: 'CONV-7', accepted_answer: 'use approach B' });
    expect(addPlanDecision).not.toHaveBeenCalled();
    expect(setItemStatus).not.toHaveBeenCalled();
    expect(r.resolved).toBe(true);
  });
});
