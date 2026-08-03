/**
 * derived-plan-slug.test.ts — P-005 / D-097.
 *
 * The policy tests below are cheap; the ones that matter are the LAST two
 * groups, which pin the properties a future edit could silently break: the
 * ordering dependency on the `auto` stamp, and fail-soft.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldDerivePlanSlug,
  derivePlanSlug,
  PLAN_SLUG_DERIVED_PROVENANCE,
} from './derived-plan-slug';

describe('shouldDerivePlanSlug', () => {
  const agent = 'su-de6e9643-2fa0-4a4f-86f3-2f9e9c7f2e0d';

  it('derives for an agent session that supplied no plan_slug', () => {
    expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: undefined, from: agent })).toBe(
      true,
    );
  });

  it('NEVER overrides an explicit caller value', () => {
    expect(
      shouldDerivePlanSlug({ explicitPlanSlug: 'chosen-plan', auto: undefined, from: agent }),
    ).toBe(false);
  });

  it('treats an explicitly EMPTY plan_slug as a deliberate value, not an omission', () => {
    // A caller that passes '' has said something; only `undefined` is silence.
    expect(shouldDerivePlanSlug({ explicitPlanSlug: '', auto: undefined, from: agent })).toBe(false);
  });

  it('accepts every agent-session shape', () => {
    for (const from of ['su-abc', 's-abc', 'cup-abc', 'role-leader', '0f1e2d3c-4b5a-xxxx']) {
      expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: undefined, from })).toBe(
        true,
      );
    }
  });

  it('never derives for a named machine emitter (keeps the hot path free)', () => {
    for (const from of [
      'git-sync-integrator',
      'git-sync-ref-announce',
      'service-health',
      'system:delivery-ladder',
      'claim-discipline-watch',
      'green-checkpoint',
      'work-items',
    ]) {
      expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: undefined, from })).toBe(
        false,
      );
    }
  });

  it('never derives for the humans the sender patterns exist to protect', () => {
    for (const from of ['human', 'pc-admin-coord-ui']) {
      expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: undefined, from })).toBe(
        false,
      );
    }
  });

  it('handles a missing/blank sender without throwing', () => {
    for (const from of [null, undefined, '']) {
      expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: undefined, from })).toBe(
        false,
      );
    }
  });

  // ── THE ORDERING CONSTRAINT ────────────────────────────────────────────────
  // D-095's population — system code emitting under a BORROWED AGENT IDENTITY —
  // passes the agent-session shape by construction. It is excluded ONLY because
  // messages.ts stamps `auto: true` on it BEFORE calling this. If someone hoists
  // the call above those stamps, a lifecycle notice starts inheriting the calling
  // agent's plan. These two cases are what fails if that happens.
  it('does NOT derive once the seam has stamped auto:true, even for an agent-shaped sender', () => {
    expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: true, from: agent })).toBe(
      false,
    );
  });

  it('still derives when auto is explicitly false (a deliberate hand-authored send)', () => {
    expect(shouldDerivePlanSlug({ explicitPlanSlug: undefined, auto: false, from: agent })).toBe(
      true,
    );
  });
});

describe('derivePlanSlug', () => {
  const ownerId = 'su-abc';

  it('returns the declared plan', async () => {
    const got = await derivePlanSlug({ ownerId, readPlanSlug: async () => 'my-plan-2026-08-03' });
    expect(got).toBe('my-plan-2026-08-03');
  });

  it('trims, and treats a whitespace-only slug as absent', async () => {
    expect(await derivePlanSlug({ ownerId, readPlanSlug: async () => '  p  ' })).toBe('p');
    expect(await derivePlanSlug({ ownerId, readPlanSlug: async () => '   ' })).toBeNull();
  });

  it('returns null when the sender is on no plan', async () => {
    expect(await derivePlanSlug({ ownerId, readPlanSlug: async () => null })).toBeNull();
    expect(await derivePlanSlug({ ownerId, readPlanSlug: async () => undefined })).toBeNull();
  });

  // ── FAIL-SOFT ──────────────────────────────────────────────────────────────
  // A decorative field must never be able to fail the delivery it decorates.
  it('degrades to null when the presence read THROWS — never propagates', async () => {
    const got = await derivePlanSlug({
      ownerId,
      readPlanSlug: async () => {
        throw new Error('PG is down');
      },
    });
    expect(got).toBeNull();
  });

  it('degrades to null on a non-string value rather than stamping garbage', async () => {
    const got = await derivePlanSlug({
      ownerId,
      readPlanSlug: async () => ({ nope: true }) as unknown as string,
    });
    expect(got).toBeNull();
  });

  it('passes the sender ownerId through to the reader', async () => {
    const seen: string[] = [];
    await derivePlanSlug({
      ownerId,
      readPlanSlug: async (id) => {
        seen.push(id);
        return null;
      },
    });
    expect(seen).toEqual([ownerId]);
  });
});

describe('provenance', () => {
  it('marks the value derived, so adoption never counts it as sender intent', () => {
    // P-001's scorecard must be able to subtract machine-supplied values; the
    // `expects` stamp records its own provenance for the same reason.
    expect(PLAN_SLUG_DERIVED_PROVENANCE).toBe('presence-derived');
  });
});
