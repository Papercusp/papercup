/**
 * coord.* UI display-projection unit pins
 * (whole-app-sync-payload-audit-2026-07-19 P-006).
 */
import { describe, expect, it } from 'vitest';
import {
  projectCoordInboxForUi,
  projectCoordPlansForUi,
  COORD_TEXT_PREVIEW_MAX,
} from './coord-ui-projection';

describe('projectCoordInboxForUi', () => {
  it('drops the heavy `payload`, keeping every rendered scalar (incl. the key fields)', () => {
    const rows = [
      {
        ts: '2026-07-19T00:00:00Z',
        msg_id: 'm1',
        source: 'message',
        kind: 'escalation',
        from: 'su-abc',
        to: ['human'],
        plan_slug: 'p',
        harness_slug: 'h',
        summary: 'needs a human',
        payload: { ts: '…', msg_id: 'm1', kind: 'escalation', huge: 'x'.repeat(5000) },
      },
    ];
    const out = projectCoordInboxForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0]).not.toHaveProperty('payload');
    // client keys on `${source}:${msg_id}` — both must survive
    expect(out[0].source).toBe('message');
    expect(out[0].msg_id).toBe('m1');
    expect(out[0].summary).toBe('needs a human');
    expect(out[0].kind).toBe('escalation');
    expect(out[0].from).toBe('su-abc');
    expect(out[0].plan_slug).toBe('p');
  });

  it('is defensive against non-array / non-object rows', () => {
    expect(projectCoordInboxForUi(null)).toBeNull();
    expect(projectCoordInboxForUi([null, 'x'])).toEqual([null, 'x']);
  });
});

describe('projectCoordPlansForUi', () => {
  it('drops now_state and clips now_next, keeping the rendered fields', () => {
    const rows = [
      {
        slug: 'my-plan',
        title: 'T',
        status: 'active',
        updated: '2026-07-19',
        item_count: 3,
        decision_count: 1,
        now_state: 'x'.repeat(4000),
        now_next: 'y'.repeat(900),
      },
    ];
    const out = projectCoordPlansForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0]).not.toHaveProperty('now_state');
    expect((out[0].now_next as string).length).toBe(COORD_TEXT_PREVIEW_MAX);
    expect(out[0].now_next as string).toMatch(/…$/);
    expect(out[0].slug).toBe('my-plan');
    expect(out[0].title).toBe('T');
    expect(out[0].status).toBe('active');
    expect(out[0].item_count).toBe(3);
    expect(out[0].decision_count).toBe(1);
  });

  it('leaves a short/null now_next untouched', () => {
    const out = projectCoordPlansForUi([
      { slug: 'a', now_next: 'short', now_state: 's' },
      { slug: 'b', now_next: null, now_state: null },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].now_next).toBe('short');
    expect(out[0]).not.toHaveProperty('now_state');
    expect(out[1].now_next).toBeNull();
  });

  it('is defensive against a non-array payload', () => {
    expect(projectCoordPlansForUi({ error: 'x' })).toEqual({ error: 'x' });
  });
});
