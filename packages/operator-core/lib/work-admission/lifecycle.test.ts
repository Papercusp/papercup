/**
 * Admission lifecycle planning (linear-asana-task-sync-2026-10-05 P-003): which write-backs an
 * admitted work item's state calls for, keyed so each event is written once, and how a rule's
 * lifecycle switches are validated. The writes themselves run against real Postgres in
 * lifecycle.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ADMISSION_LIFECYCLE, parseAdmissionLifecycle, resolveAdmissionLifecycle } from './lifecycle-config';
import { planLifecycleWrites, sourceCategoryOf, type LifecycleWorkItem } from './lifecycle';

const ON = { ...DEFAULT_ADMISSION_LIFECYCLE };
const none = new Set<string>();

function item(over: Partial<LifecycleWorkItem>): LifecycleWorkItem {
  return { id: 'WI-1', state: 'open', assignee: null, closedAt: null, payload: {}, ...over };
}

describe('planLifecycleWrites', () => {
  it('writes nothing for an open, unclaimed item', () => {
    expect(planLifecycleWrites(item({}), ON, none)).toEqual([]);
  });

  it('moves the source to in-progress and comments the holder on claim, once per holder', () => {
    const claimed = item({ state: 'wip', assignee: 'su-a' });
    expect(planLifecycleWrites(claimed, ON, none)).toEqual([
      { key: 'claim:su-a:move', action: 'transition', toCategory: 'in-progress' },
      { key: 'claim:su-a', action: 'comment', text: 'Picked up in Papercusp as WI-1; su-a is working on it.' },
    ]);
    expect(planLifecycleWrites(claimed, ON, new Set(['claim:su-a:move', 'claim:su-a']))).toEqual([]);
    // A new holder is a new event.
    expect(planLifecycleWrites(item({ state: 'wip', assignee: 'su-b' }), ON, new Set(['claim:su-a:move', 'claim:su-a'])).map((w) => w.key))
      .toEqual(['claim:su-b:move', 'claim:su-b']);
  });

  it('comments the question a held item waits on, keyed by the question', () => {
    const blockers = [{
      kind: 'human', capability: 'product-decision', capabilitySource: 'explicit', ref: 'ask-1', status: 'active',
      summary: 'Which billing plan should the trial use?', nextVerb: 'answer in the thread',
      createdAt: 't', createdBy: 'su-a', updatedAt: 't',
    }];
    const held = item({ state: 'needs-human', assignee: 'su-a', payload: { externalBlockers: blockers } });
    const writes = planLifecycleWrites(held, ON, new Set(['claim:su-a:move', 'claim:su-a']));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ action: 'comment', key: expect.stringMatching(/^hold:needs-human:[0-9a-f]{12}$/) });
    expect((writes[0] as { text: string }).text).toBe(
      'Papercusp is waiting on this (WI-1): Which billing plan should the trial use? Next: answer in the thread',
    );
    // A different question is a different event; the same question is not repeated.
    expect(planLifecycleWrites(held, ON, new Set(['claim:su-a:move', 'claim:su-a', writes[0]!.key]))).toEqual([]);
  });

  it('never tells the source about its own source-closed hold', () => {
    const blockers = [{
      kind: 'event', capability: 'live-dependency', capabilitySource: 'explicit', ref: 'source-closed:DSR-1', status: 'active',
      summary: 'closed outside', createdAt: 't', createdBy: 'system:work-admission', updatedAt: 't',
    }];
    const held = item({ state: 'blocked', assignee: 'su-a', payload: { externalBlockers: blockers } });
    expect(planLifecycleWrites(held, ON, new Set(['claim:su-a:move', 'claim:su-a']))).toEqual([]);
  });

  it('comments the completion summary and moves the source to the completion category on done', () => {
    const done = item({
      state: 'done', assignee: null, closedAt: '2026-10-06T07:00:00.000Z',
      payload: { _completionEvidence: { summary: 'Fixed the export button.' } },
    });
    expect(planLifecycleWrites(done, ON, none)).toEqual([
      { key: 'complete:2026-10-06T07:00:00.000Z', action: 'comment', text: 'Completed in Papercusp (WI-1).\n\nFixed the export button.' },
      { key: 'complete:2026-10-06T07:00:00.000Z:move', action: 'transition', toCategory: 'done' },
    ]);
    expect(planLifecycleWrites(done, { ...ON, completeCategory: 'in-review' }, none)[1]).toMatchObject({ toCategory: 'in-review' });
  });

  it('writes nothing for a dropped item, and nothing a switched-off rule disables', () => {
    expect(planLifecycleWrites(item({ state: 'dropped', closedAt: 't' }), ON, none)).toEqual([]);
    expect(planLifecycleWrites(item({ state: 'wip', assignee: 'su-a' }), { ...ON, claim: false }, none)).toEqual([]);
    expect(planLifecycleWrites(item({ state: 'done', closedAt: 't' }), { ...ON, complete: false }, none)).toEqual([]);
  });

  it('keeps every comment inside the write-back limit', () => {
    const done = item({ state: 'done', closedAt: 't', payload: { _completionEvidence: { summary: 'x'.repeat(10_000) } } });
    const comment = planLifecycleWrites(done, ON, none)[0] as { text: string };
    expect(comment.text.length).toBeLessThanOrEqual(4000);
    expect(comment.text.endsWith('…')).toBe(true);
  });
});

describe('admission lifecycle switches', () => {
  it('fills defaults: every reaction on, completion moves the source to done (owner #1417)', () => {
    expect(parseAdmissionLifecycle({})).toEqual({
      claim: true, hold: true, complete: true, completeCategory: 'done', externalClose: true, reopen: true,
    });
    expect(parseAdmissionLifecycle({ claim: false, completeCategory: 'in-review' })).toMatchObject({ claim: false, completeCategory: 'in-review' });
  });

  it('refuses unknown keys, non-boolean switches and a category outside the vocabulary', () => {
    expect(() => parseAdmissionLifecycle({ onClaim: true })).toThrow(/admission_rule_invalid: unknown lifecycle key\(s\) onClaim/);
    expect(() => parseAdmissionLifecycle({ claim: 'yes' })).toThrow(/lifecycle.claim must be a boolean/);
    expect(() => parseAdmissionLifecycle({ completeCategory: 'shipped' })).toThrow(/completeCategory/);
    expect(() => parseAdmissionLifecycle([])).toThrow(/must be an object/);
  });

  it('reads a malformed stored value as the defaults instead of stopping a sync', () => {
    expect(resolveAdmissionLifecycle({ bogus: 1 })).toEqual({ ...DEFAULT_ADMISSION_LIFECYCLE });
    expect(resolveAdmissionLifecycle(null)).toEqual({ ...DEFAULT_ADMISSION_LIFECYCLE });
  });
});

describe('sourceCategoryOf', () => {
  it('reads the canonical category, else derives it from open/closed, else reports not-a-ticket', () => {
    expect(sourceCategoryOf({ statusCategory: 'in-review', state: 'open' })).toBe('in-review');
    expect(sourceCategoryOf({ state: 'closed' })).toBe('done');
    expect(sourceCategoryOf({ state: 'open' })).toBe('todo');
    expect(sourceCategoryOf({ statusCategory: 'shipped' })).toBeNull();
    expect(sourceCategoryOf({ title: 'a document' })).toBeNull();
  });
});
