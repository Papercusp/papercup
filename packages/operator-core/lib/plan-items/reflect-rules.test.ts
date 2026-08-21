/**
 * reflect-rules.test.ts — the work_item → plan-item reflection rules
 * (convert-at-pickup D-015, the read-back half).
 *
 * The rules are PURE (sync matcher over the tool event) — so this tests them
 * directly: registration on the engine, the stamp extraction, the state
 * mapping, and the exact plans:set-status args each rule renders, all from
 * synthetic events. The end-to-end flip is covered by the live E2E pass (the
 * reaction engine + plans:set-status are themselves tested elsewhere).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { reactionRulesFor } from '../events/registry';
import type { ToolInvocationEvent } from '../events/types';
import { reflectedStatus, stampOf } from './reflect-rules';

const STAMP = { plan_slug: 'demo-plan', item_id: 'P-007', harness_slug: 'papercup' };

function evt(tool: string, data: unknown, ok = true): ToolInvocationEvent {
  return {
    tool,
    args: {},
    result: { ok, data },
    ctx: { uiClientId: 'sess-T' } as never,
  };
}

function stamped(state: string, extra: Record<string, unknown> = {}, needsHuman = false) {
  return {
    ok: true,
    workItem: { id: 'WI-9', state, payload: { plan_item: STAMP, ...(needsHuman ? { needsHuman: true } : {}) } },
    ...extra,
  };
}

function ruleById(tool: string, id: string) {
  const rule = reactionRulesFor(tool).find((r) => r.id === id);
  expect(rule, `rule ${id} registered on ${tool}`).toBeTruthy();
  return rule!;
}

function renderArgs(rule: { args?: unknown }, e: ToolInvocationEvent): Record<string, unknown> {
  const a = rule.args;
  return typeof a === 'function' ? (a as (e: ToolInvocationEvent) => Record<string, unknown>)(e) : (a as Record<string, unknown>);
}

function fires(rule: { when?: unknown }, e: ToolInvocationEvent): boolean {
  const w = rule.when;
  return typeof w === 'function' ? (w as (e: ToolInvocationEvent) => boolean)(e) : true;
}

beforeAll(async () => {
  await import('./reflect-rules'); // registration-on-import
});

describe('stampOf — the payload back-link off a tool event', () => {
  it('extracts a valid stamp; rejects missing/partial/non-P-NNN stamps', () => {
    expect(stampOf(evt('t', stamped('open')))).toEqual(STAMP);
    expect(stampOf(evt('t', { ok: true, workItem: { id: 'WI-9' } }))).toBeNull();
    expect(stampOf(evt('t', { ok: true, workItem: { payload: { plan_item: { plan_slug: 'p' } } } }))).toBeNull();
    expect(
      stampOf(evt('t', { ok: true, workItem: { payload: { plan_item: { ...STAMP, item_id: 'EI-8' } } } })),
    ).toBeNull(); // plans:set-status only takes P-NNN — never render a doomed flip
    expect(stampOf(evt('t', undefined))).toBeNull();
  });
});

describe('reflectedStatus — work_item state → plan-item status', () => {
  it('maps terminal-success → done, terminal-drop → dropped, reopen → todo, in-flight → null', () => {
    expect(reflectedStatus('passed')).toBe('done');
    expect(reflectedStatus('resolved')).toBe('done');
    expect(reflectedStatus('done')).toBe('done');
    expect(reflectedStatus('deprecated')).toBe('dropped');
    expect(reflectedStatus('closed')).toBe('dropped');
    expect(reflectedStatus('dropped')).toBe('dropped');
    expect(reflectedStatus('todo')).toBe('todo');
    expect(reflectedStatus('open')).toBe('todo');
    expect(reflectedStatus('validating')).toBeNull();
    expect(reflectedStatus('failing')).toBeNull();
    expect(reflectedStatus(undefined)).toBeNull();
  });

  it('EI-6569: maps a parked work-item onto blocked/needs-human instead of falling through to null', () => {
    // feature-family native 'blocked' state, no needsHuman flag.
    expect(reflectedStatus('blocked')).toBe('blocked');
    // feature-family native distinct 'needs-human' state.
    expect(reflectedStatus('needs-human')).toBe('needs-human');
    // issue-family needs-human ALIAS dialect: state collapses to 'blocked' +
    // payload.needsHuman:true — the second arg disambiguates it from a plain park.
    expect(reflectedStatus('blocked', true)).toBe('needs-human');
    expect(reflectedStatus('blocked', false)).toBe('blocked');
  });
});

describe('plan-item-reflect:complete', () => {
  it('fires plans:set-status → done with the stamp scope on a completion that lands a terminal-success state', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const e = evt('work_items:complete', stamped('resolved', { completion: { summary: 's' } }));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({
      harness: 'papercup',
      slug: 'demo-plan',
      item: 'P-007',
      status: 'done',
    });
  });

  it('does not duplicate the plan flip when the synchronous finish receipt already converged it', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const e = evt(
      'work_items:complete',
      stamped('resolved', {
        completion: { summary: 's' },
        finish: { planItem: 'done', claimRelease: 'released-or-absent' },
      }),
    );
    expect(fires(rule, e)).toBe(false);
  });

  it('EI-8353: a completion that CLOSES/deprecates the item reflects → dropped, never done', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const closed = evt('work_items:complete', stamped('closed', { completion: { summary: 's' } }));
    expect(fires(rule, closed)).toBe(true);
    expect(renderArgs(rule, closed)).toMatchObject({
      item: 'P-007',
      status: 'dropped',
      note: expect.stringContaining('WI-9'),
    });

    const deprecated = evt('work_items:complete', stamped('deprecated', { completion: { summary: 's' } }));
    expect(fires(rule, deprecated)).toBe(true);
    expect(renderArgs(rule, deprecated)).toMatchObject({ item: 'P-007', status: 'dropped' });
  });

  // The `complete` rule shares setStatusArgs with `set-state`, so it inherits the same drop
  // guards — pinned here so a future refactor of one path cannot silently strip the other.
  it('EI-20129670928216719: a → dropped completion also renders onlyIfNotCompleted', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const closed = evt('work_items:complete', { ...stamped('closed'), completion: { summary: 'closed out' } });
    expect(renderArgs(rule, closed)).toMatchObject({ status: 'dropped', onlyIfNotCompleted: true });
  });

  it('EI-19972048649686949: a → dropped completion renders onlyIfNoOtherOpenCoverage so it never cascades onto a plan item still covered by a sibling work-item', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const closed = evt('work_items:complete', stamped('closed', { completion: { summary: 's' } }));
    expect(renderArgs(rule, closed)).toMatchObject({ status: 'dropped', onlyIfNoOtherOpenCoverage: true });

    // WI-38908: a → done completion now carries the coverage guard TOO. It used to be
    // drop-only, which meant completing the first of N siblings stamped to one plan item
    // marked the whole item finished. It does NOT carry onlyIfNotCompleted — that guard
    // exists solely to stop a done → dropped DOWNGRADE, which a → done flip cannot be.
    const done = evt('work_items:complete', stamped('resolved', { completion: { summary: 's' } }));
    expect(renderArgs(rule, done)).toMatchObject({ status: 'done', onlyIfNoOtherOpenCoverage: true });
    expect(renderArgs(rule, done)).not.toHaveProperty('onlyIfNotCompleted');
  });

  it('does NOT fire without a completion record, without a stamp, or when the resulting state is non-terminal', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    expect(fires(rule, evt('work_items:complete', stamped('open')))).toBe(false); // no completion
    expect(
      fires(rule, evt('work_items:complete', { ok: true, workItem: { id: 'WI-9' }, completion: {} })),
    ).toBe(false); // unconverted work_item — no stamp
    // EI-8353: a completion recorded WITHOUT a terminal `state` transition (item stays
    // 'open'/claimable) must never flip the plan item to done.
    expect(
      fires(rule, evt('work_items:complete', stamped('open', { completion: { summary: 's' } }))),
    ).toBe(false);
  });
});

describe('plan-item-reflect:set-state', () => {
  it('fires on a mapped state; renders the mapped status', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    const e = evt('work_items:set_state', stamped('resolved'));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({ item: 'P-007', status: 'done' });

    const drop = evt('work_items:set_state', stamped('deprecated'));
    expect(renderArgs(rule, drop)).toMatchObject({
      status: 'dropped',
      note: expect.stringContaining('WI-9'),
    });

    const reopen = evt('work_items:set_state', stamped('open'));
    expect(renderArgs(rule, reopen)).toMatchObject({ status: 'todo' });
  });

  // WI-38908 widened this from drop-only to EITHER TERMINAL status. The boundary that
  // still matters is terminal vs non-terminal: marking an item done and abandoning it are
  // the same hazard (both de-queue an item other live work still covers), while a reopen
  // or a park adds no coverage claim and must never pay for the lookup.
  it('EI-19972048649686949 + WI-38908: renders onlyIfNoOtherOpenCoverage on a TERMINAL flip (done or dropped), never on todo/blocked', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    const drop = evt('work_items:set_state', stamped('deprecated'));
    expect(renderArgs(rule, drop)).toMatchObject({ status: 'dropped', onlyIfNoOtherOpenCoverage: true });

    const done = evt('work_items:set_state', stamped('resolved'));
    expect(renderArgs(rule, done)).toMatchObject({ status: 'done', onlyIfNoOtherOpenCoverage: true });

    const reopen = evt('work_items:set_state', stamped('open'));
    expect(renderArgs(rule, reopen)).not.toHaveProperty('onlyIfNoOtherOpenCoverage');

    const blocked = evt('work_items:set_state', stamped('blocked'));
    expect(renderArgs(rule, blocked)).not.toHaveProperty('onlyIfNoOtherOpenCoverage');
  });

  // EI-20129670928216719. The drop cascade carries TWO complementary guards, and the second
  // exists because the first CANNOT see it: onlyIfNoOtherOpenCoverage counts only NON-terminal
  // siblings, so the `done` work-item that actually completed the plan item is filtered out and
  // the item reads as uncovered. Live case: dropping WI-37872 (merely `relates`-linked) flipped
  // fix-0014-platform-defects-2026-08-10#P-005 from done → dropped 67ms later, while its real
  // completer WI-37735 sat `done`. The release rule had been hardened against exactly this
  // reasoning (EI-19295826179470465); the drop path had not — this pins that it now is.
  it('EI-20129670928216719: renders onlyIfNotCompleted alongside the coverage guard on a → dropped flip only', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    // Every work-item state that maps to `dropped` must carry BOTH guards — a gap in any one
    // of them re-opens the regression for that state alone.
    for (const state of ['deprecated', 'closed', 'dropped']) {
      expect(renderArgs(rule, evt('work_items:set_state', stamped(state))), state).toMatchObject({
        status: 'dropped',
        onlyIfNoOtherOpenCoverage: true,
        onlyIfNotCompleted: true,
      });
    }

    // Never on a non-drop flip: the guard is scoped to `dropped`, and a genuine done/reopen/park
    // reflection must stay unguarded or it would silently no-op.
    for (const state of ['resolved', 'done', 'passed', 'open', 'todo', 'blocked']) {
      expect(renderArgs(rule, evt('work_items:set_state', stamped(state))), state).not.toHaveProperty(
        'onlyIfNotCompleted',
      );
    }
  });

  it('does NOT fire on an in-flight (unmapped) state', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    expect(fires(rule, evt('work_items:set_state', stamped('validating')))).toBe(false);
  });

  it('EI-6569: fires on a park into blocked/needs-human instead of leaving the plan item stale', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');

    const blocked = evt('work_items:set_state', stamped('blocked'));
    expect(fires(rule, blocked)).toBe(true);
    expect(renderArgs(rule, blocked)).toMatchObject({ item: 'P-007', status: 'blocked' });

    const needsHumanState = evt('work_items:set_state', stamped('needs-human'));
    expect(fires(rule, needsHumanState)).toBe(true);
    expect(renderArgs(rule, needsHumanState)).toMatchObject({ item: 'P-007', status: 'needs-human' });

    // issue-family alias dialect: state:'blocked' + payload.needsHuman:true.
    const aliasedNeedsHuman = evt('work_items:set_state', stamped('blocked', {}, true));
    expect(fires(rule, aliasedNeedsHuman)).toBe(true);
    expect(renderArgs(rule, aliasedNeedsHuman)).toMatchObject({ item: 'P-007', status: 'needs-human' });
  });
});

describe('lease release mirrors (complete / release also drop the plan-item lease)', () => {
  it('complete fires plan_items:release with the stamp scope', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete-releases-lease');
    const e = evt('work_items:complete', stamped('resolved', { completion: { summary: 's' } }));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toEqual({ harness: 'papercup', plan: 'demo-plan', item: 'P-007' });
    // No completion record / no stamp / non-terminal result → no fire.
    expect(fires(rule, evt('work_items:complete', stamped('open')))).toBe(false);
    expect(fires(rule, evt('work_items:complete', { ok: true, workItem: { id: 'WI-9' }, completion: {} }))).toBe(false);
    expect(fires(rule, evt('work_items:complete', stamped('open', { completion: { summary: 's' } })))).toBe(false);
    expect(
      fires(
        rule,
        evt(
          'work_items:complete',
          stamped('resolved', {
            completion: { summary: 's' },
            finish: { planItem: 'done', claimRelease: 'released-or-absent' },
          }),
        ),
      ),
    ).toBe(false);
  });

  it('work_items:release fires plan_items:release for any stamped item (terminal or not)', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release-releases-lease');
    expect(fires(rule, evt('work_items:release', stamped('open')))).toBe(true);
    expect(fires(rule, evt('work_items:release', stamped('resolved')))).toBe(true);
    expect(fires(rule, evt('work_items:release', { ok: true, workItem: { id: 'WI-9' } }))).toBe(false);
    expect(renderArgs(rule, evt('work_items:release', stamped('open')))).toEqual({
      harness: 'papercup',
      plan: 'demo-plan',
      item: 'P-007',
    });
  });
});

describe('plan-item-reflect:release', () => {
  it('fires → todo when a non-terminal converted item is released', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    const e = evt('work_items:release', stamped('open'));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({ item: 'P-007', status: 'todo' });
  });

  it('does NOT fire when the released item is already terminal (never resurrect a done item)', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    expect(fires(rule, evt('work_items:release', stamped('resolved')))).toBe(false);
    expect(fires(rule, evt('work_items:release', stamped('passed')))).toBe(false);
  });

  // RECURRENCE GUARD. The check above only inspects the WORK-ITEM's state, which is all a
  // pure/sync matcher can see. It cannot protect a plan item that reached `done` by another
  // path (flipped directly on the plan, or completed by a SIBLING work-item) — and releasing
  // a still-open work-item then de-completed shipped work, re-pooling it for duplicate pickup
  // and flipping every dependent to a false `blocked`. Live case:
  // memory-write-latency-2026-07-26#P-007, reverted to `todo` by the release of WI-6211.
  //
  // The protection is `onlyIfNotTerminal` on the rendered flip. Deleting it silently restores
  // the bug with no other visible symptom, so it is asserted explicitly rather than left to
  // a toMatchObject that would happily pass without it.
  it('renders onlyIfNotTerminal so a release can NEVER un-finish an already-done plan item', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    const args = renderArgs(rule, evt('work_items:release', stamped('open')));
    expect(args.status).toBe('todo');
    expect(args.onlyIfNotTerminal).toBe(true);
  });

  // A release says "I am no longer holding this" — never "this is unfinished". Any future
  // reflection driven by an OWNERSHIP event must carry the same guard.
  it('keeps the guard on every non-terminal work-item state it fires for', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    for (const state of ['open', 'wip', 'blocked', 'todo']) {
      const e = evt('work_items:release', stamped(state));
      expect(fires(rule, e), `fires for ${state}`).toBe(true);
      expect(renderArgs(rule, e).onlyIfNotTerminal, `guard present for ${state}`).toBe(true);
    }
  });
});
