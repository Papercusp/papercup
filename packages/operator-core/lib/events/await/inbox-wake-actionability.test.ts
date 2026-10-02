import { describe, expect, it } from 'vitest';
import {
  classifyInboxWakeGroup,
  classifyInboxWakeMessage,
  inboxWakeDeliveryMsgId,
} from './inbox-wake-actionability';

// review-system-rework-reduction-2026-09-23 P-024: "a wake with nothing to act on costs no turn".
const KEY = 'coord:inbox-wake:su-a';

function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: '2026-09-23T14:00:00.000Z', msg_id: 'm-1', from: 'su-b', to: ['su-a'], kind: 'message', ...over };
}

describe('RSR-P-024-B — a non-actionable inbox event does not start a turn', () => {
  it('classifies a directed FYI (expects none, no reply linkage) as non-actionable', () => {
    const v = classifyInboxWakeMessage(msg({ expects: 'none', summary: 'FYI: merged' }));
    expect(v.actionable).toBe(false);
    expect(v.class).toBe('fyi');
  });

  it('classifies a bare ack receipt as non-actionable, even when it threads to the ask', () => {
    const v = classifyInboxWakeMessage(msg({ kind: 'ack', related_msg_id: 'm-0' }));
    expect(v.actionable).toBe(false);
    expect(v.class).toBe('receipt');
  });

  it('classifies a plan event with no state change (todo→todo) as non-actionable', () => {
    const v = classifyInboxWakeMessage(
      msg({ kind: 'plan_event', event: 'item_status_changed', before: { status: 'todo', id: 'P-1' }, after: { id: 'P-1', status: 'todo' } }),
    );
    expect(v.actionable).toBe(false);
    expect(v.class).toBe('no-state-change');
  });

  it('keeps a plan event that DID change state actionable', () => {
    const v = classifyInboxWakeMessage(
      msg({ kind: 'plan_event', event: 'item_status_changed', before: { status: 'todo' }, after: { status: 'wip' } }),
    );
    expect(v.actionable).toBe(true);
  });

  it('the wake gate settles a group whose every message is non-actionable', () => {
    const envelopes = new Map<string, unknown>([
      ['m-1', msg({ msg_id: 'm-1', expects: 'none' })],
      ['m-2', msg({ msg_id: 'm-2', kind: 'ack', related_msg_id: 'm-0' })],
    ]);
    const gate = classifyInboxWakeGroup(
      [
        { eventKey: KEY, payload: { msg_id: 'm-1' } },
        { eventKey: KEY, payload: { msg_id: 'm-2' } },
      ],
      envelopes,
    );
    expect(gate).toEqual({ nonActionable: true, classes: ['fyi', 'receipt'] });
  });

  it('fails OPEN: an unresolved envelope, an unreadable one, a msg_id-less wake, an urgent one, or a foreign key keeps the turn', () => {
    const envelopes = new Map<string, unknown>([['m-1', msg({ expects: 'none' })], ['m-bad', 'not-an-envelope']]);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, payload: { msg_id: 'm-missing' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, payload: { msg_id: 'm-bad' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, payload: null }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, urgent: true, payload: { msg_id: 'm-1' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: 'release:green:x', payload: { msg_id: 'm-1' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeMessage(undefined)).toMatchObject({ actionable: true, class: 'unknown' });
  });

  it('reads the msg_id only from a well-formed payload', () => {
    expect(inboxWakeDeliveryMsgId({ msg_id: 'm-9' })).toBe('m-9');
    expect(inboxWakeDeliveryMsgId({ msg_id: '' })).toBeNull();
    expect(inboxWakeDeliveryMsgId({ coalesced: true })).toBeNull();
    expect(inboxWakeDeliveryMsgId(null)).toBeNull();
  });
});

describe('RSR-P-024-C — a directed ask or an owner directive starts a turn', () => {
  it.each([
    ['expects action', msg({ expects: 'action' })],
    ['expects answer', msg({ expects: 'answer' })],
    ['expectsReply', msg({ expectsReply: true })],
  ])('a directed ask (%s) is actionable', (_label, env) => {
    const v = classifyInboxWakeMessage(env);
    expect(v.actionable).toBe(true);
    expect(v.class).toBe('directed-ask');
  });

  it.each([
    ['from the owner chat pane', msg({ from: 'pc-admin-coord-ui', expects: 'none' })],
    ['from the human inbox', msg({ from: 'human', expects: 'none' })],
    ['an owner-origin relay stamp', msg({ expects: 'none', relayProvenance: { origin: 'owner', tier: 'owner-verified-turn' } })],
    ['an owner ack-shaped message', msg({ from: 'human', kind: 'ack' })],
  ])('an owner directive (%s) is actionable even when it looks like an FYI', (_label, env) => {
    const v = classifyInboxWakeMessage(env);
    expect(v.actionable).toBe(true);
    expect(v.class).toBe('owner-directive');
  });

  it("a wake:'required' message and its persisted boolean form plus a thread reply keep their turn", () => {
    expect(classifyInboxWakeMessage(msg({ expects: 'none', wake: 'required' }))).toMatchObject({ actionable: true, class: 'required-wake' });
    expect(classifyInboxWakeMessage(msg({ expects: 'none', wake: true }))).toMatchObject({ actionable: true, class: 'actionable' });
    expect(classifyInboxWakeMessage(msg({ expects: 'none', related_msg_id: 'm-0' }))).toMatchObject({ actionable: true, class: 'reply' });
  });

  it('the wake gate keeps the turn when ANY message in the group is an ask or an owner directive', () => {
    const envelopes = new Map<string, unknown>([
      ['m-fyi', msg({ msg_id: 'm-fyi', expects: 'none' })],
      ['m-ask', msg({ msg_id: 'm-ask', expects: 'action' })],
      ['m-own', msg({ msg_id: 'm-own', from: 'human', expects: 'none' })],
    ]);
    const withAsk = classifyInboxWakeGroup(
      [
        { eventKey: KEY, payload: { msg_id: 'm-fyi' } },
        { eventKey: KEY, payload: { msg_id: 'm-ask' } },
      ],
      envelopes,
    );
    expect(withAsk.nonActionable).toBe(false);
    expect(withAsk.classes).toEqual(['fyi', 'directed-ask']);
    const withOwner = classifyInboxWakeGroup(
      [
        { eventKey: KEY, payload: { msg_id: 'm-own' } },
        { eventKey: KEY, payload: { msg_id: 'm-fyi' } },
      ],
      envelopes,
    );
    expect(withOwner.nonActionable).toBe(false);
    expect(withOwner.classes).toEqual(['owner-directive']);
  });
});
