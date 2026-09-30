/**
 * Poll-tick dispatch dedupe (state-plane-interest-and-hardening-2026-08-21 P-012).
 *
 * Within one tick, rows that agree on everything the READ depends on share ONE resolver
 * dispatch. The optimisation itself is cheap to get right; the GROUPING KEY is not, and
 * that is what these tests pin.
 *
 * WHY THE REFUSALS ARE THE IMPORTANT HALF. The plan item words the key as "(tool,
 * canonical args hash)". Grouped on that alone this is a PRIVILEGE LEAK, because
 * `dispatchReadOnlyTool` runs under the row's role envelope and enforces the role gate
 * as a second, independent access check: two rows with identical tool+args but different
 * roles can legitimately get different outcomes — a value for one, an access refusal for
 * the other. A shared dispatch across them hands a denied watcher a payload fetched under
 * someone else's authority, and nothing downstream would notice, because a payload is a
 * payload. So every identity dimension gets a test asserting rows do NOT group, each
 * paired with a positive control proving the same assertion CAN fail (an assertion that
 * has only ever seen non-colliding inputs is not evidence).
 *
 * The one dimension that MUST still group is ownerId: it reaches the dispatcher only as
 * `onBehalfOf`, which is audit-only. If that stopped grouping, the whole optimisation
 * would silently do nothing in exactly the fan-out case it exists for — N members of a
 * fleet watching one cell are N different owners, one role.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalArgsKey,
  predicateDispatchGroupKey,
  type PredicateWatchRow,
} from './predicate-watch';

function row(overrides: Partial<PredicateWatchRow> = {}): PredicateWatchRow {
  return {
    id: 'pw-1',
    workspaceId: 'ws-a',
    ownerId: 'su-owner-1',
    role: 'su',
    harnessSlug: 'papercusp',
    eventKey: 'predicate:pw-1',
    tool: 'dev:pipeline_position',
    args: { path: 'a.ts' },
    path: 'positions.deployed',
    op: 'eq',
    value: true,
    intervalSec: 60,
    once: true,
    lastEval: null,
    lastValue: null,
    evaluatorBaselines: {},
    lastPolledAt: null,
    lastError: null,
    consecutiveErrors: 0,
    active: true,
    boundTo: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('canonicalArgsKey', () => {
  it('is insensitive to object key ORDER, so equivalent args share a group', () => {
    expect(canonicalArgsKey({ a: 1, b: 2 })).toBe(canonicalArgsKey({ b: 2, a: 1 }));
  });

  it('is insensitive to key order at NESTED depth too', () => {
    expect(canonicalArgsKey({ o: { x: 1, y: 2 }, z: 3 })).toBe(
      canonicalArgsKey({ z: 3, o: { y: 2, x: 1 } }),
    );
  });

  // Positive control for the two above: the comparison is capable of returning false.
  it('CONTROL — genuinely different args do NOT share a key', () => {
    expect(canonicalArgsKey({ a: 1 })).not.toBe(canonicalArgsKey({ a: 2 }));
    expect(canonicalArgsKey({ a: 1 })).not.toBe(canonicalArgsKey({ b: 1 }));
  });

  it('keeps ARRAY order significant — [1,2] is not [2,1]', () => {
    expect(canonicalArgsKey({ xs: [1, 2] })).not.toBe(canonicalArgsKey({ xs: [2, 1] }));
  });

  it('treats null/undefined args as the empty object', () => {
    expect(canonicalArgsKey(null)).toBe(canonicalArgsKey({}));
    expect(canonicalArgsKey(undefined)).toBe(canonicalArgsKey({}));
  });

  it('FAILS SAFE on unserializable args — never groups, rather than pooling on a sentinel', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const other: Record<string, unknown> = { name: 'loop' };
    other.self = other;

    const a = canonicalArgsKey(cyclic);
    const b = canonicalArgsKey(other);

    // Distinct from each other AND from a normal key: an unreadable row groups with
    // nothing. Pooling them under one sentinel would share a read between rows whose
    // args were never actually compared.
    expect(a).not.toBe(b);
    expect(a).not.toBe(canonicalArgsKey({}));
  });
});

describe('predicateDispatchGroupKey — what MUST group', () => {
  it('groups rows differing only by ownerId (onBehalfOf is audit-only)', () => {
    expect(predicateDispatchGroupKey(row({ ownerId: 'su-a' }))).toBe(
      predicateDispatchGroupKey(row({ ownerId: 'su-b' })),
    );
  });

  it('groups rows differing only in the DOWNSTREAM compare fields', () => {
    // path/op/value/interval/once are applied after the read, so they cannot change it.
    // This is the set registration-dedupe does NOT merge, and is exactly P-012's target.
    const a = row({ path: 'positions.deployed', op: 'eq', value: true, intervalSec: 60, once: true });
    const b = row({ path: 'gate.stalled', op: 'changed', value: null, intervalSec: 300, once: false });
    expect(predicateDispatchGroupKey(a)).toBe(predicateDispatchGroupKey(b));
  });

  it('groups rows whose args differ only in key order', () => {
    expect(predicateDispatchGroupKey(row({ args: { a: 1, b: 2 } }))).toBe(
      predicateDispatchGroupKey(row({ args: { b: 2, a: 1 } })),
    );
  });
});

describe('predicateDispatchGroupKey — what MUST NOT group (the privilege boundary)', () => {
  // Each case is a dimension the dispatcher actually reads. A false negative here is a
  // shared read across an access boundary, which is why they are asserted individually
  // rather than as one compound row.
  it('refuses to group across ROLE — the enforced second access gate', () => {
    expect(predicateDispatchGroupKey(row({ role: 'su' }))).not.toBe(
      predicateDispatchGroupKey(row({ role: 'bee' })),
    );
  });

  it('refuses to group across WORKSPACE', () => {
    expect(predicateDispatchGroupKey(row({ workspaceId: 'ws-a' }))).not.toBe(
      predicateDispatchGroupKey(row({ workspaceId: 'ws-b' })),
    );
  });

  it('refuses to group across HARNESS, including null vs a real slug', () => {
    expect(predicateDispatchGroupKey(row({ harnessSlug: 'papercusp' }))).not.toBe(
      predicateDispatchGroupKey(row({ harnessSlug: 'other' })),
    );
    expect(predicateDispatchGroupKey(row({ harnessSlug: null }))).not.toBe(
      predicateDispatchGroupKey(row({ harnessSlug: 'papercusp' })),
    );
  });

  it('does not let a harness literally named "null" collide with a NULL harness', () => {
    expect(predicateDispatchGroupKey(row({ harnessSlug: null }))).not.toBe(
      predicateDispatchGroupKey(row({ harnessSlug: 'null' })),
    );
  });

  it('refuses to group across TOOL', () => {
    expect(predicateDispatchGroupKey(row({ tool: 'dev:pipeline_position' }))).not.toBe(
      predicateDispatchGroupKey(row({ tool: 'dev:build_status' })),
    );
  });

  it('refuses to group across ARGS', () => {
    expect(predicateDispatchGroupKey(row({ args: { path: 'a.ts' } }))).not.toBe(
      predicateDispatchGroupKey(row({ args: { path: 'b.ts' } })),
    );
  });

  it('cannot be forged by a field value that shifts the boundary', () => {
    // Without a delimiter no value can contain, 'ws-a' + role 'x:su' could be made to
    // serialize identically to workspace 'ws-a:x' + role 'su'.
    expect(predicateDispatchGroupKey(row({ workspaceId: 'ws-a', role: 'x-su' }))).not.toBe(
      predicateDispatchGroupKey(row({ workspaceId: 'ws-a-x', role: 'su' })),
    );
  });
});
