/**
 * Coverage for execute-action validation:
 * 1. validateIdentityFields — the pure identity-spoof guard: a body's
 *    callingHarness / send_message `from` must equal the bearer-derived slug,
 *    and scaffold_harness must not carry a caller-supplied parent_slug.
 * 2. executeAction — comprehensive action shape validation ensures malformed
 *    actions are rejected before dispatch so state remains clean.
 * 3. doSendMessage (via dispatchAction) — a send_message to a NON-EXISTENT
 *    recipient harness must fail cleanly with a not_found result instead of
 *    letting the INSERT throw a raw "schema does not exist" error that
 *    propagates as an unhandled exception / opaque 500 (WI-385). The getOrgPg
 *    `sql` mock (mirrors cross-harness-data.test.ts) lets a test declare which
 *    `harness_<slug>` schemas "exist" and captures every `.unsafe` INSERT, so
 *    the pre-validation branch is exercised without a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── getOrgPg().sql mock ───────────────────────────────────────────────────
// doSendMessage uses `sql` two ways: a tagged-template existence probe
// (`SELECT EXISTS (... schema_name = ${schema} ...)`) and `sql.unsafe(INSERT)`.
// The rig answers the existence probe from a declared set of schemas and
// records every `.unsafe` call so a test can assert no INSERT ran on the
// not_found path.
const H = vi.hoisted(() => {
  const state: {
    existingSchemas: Set<string>;
    unsafeCalls: Array<{ query: string; params: unknown[] }>;
    probeCalls: string[];
  } = { existingSchemas: new Set(), unsafeCalls: [], probeCalls: [] };

  const sql = ((_strings: readonly string[], ...values: unknown[]) => {
    // The only tagged-template query doSendMessage runs is the schema
    // existence check, whose single interpolated value is the schema name.
    const schema = values[0] as string;
    state.probeCalls.push(schema);
    return Promise.resolve([{ exists: state.existingSchemas.has(schema) }]);
  }) as unknown as {
    (strings: readonly string[], ...values: unknown[]): Promise<unknown>;
    unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
  };
  sql.unsafe = (query: string, params: unknown[] = []) => {
    state.unsafeCalls.push({ query, params });
    return Promise.resolve([{ id: `msg-${state.unsafeCalls.length}` }]);
  };
  return { sql, state };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: H.sql }) };
});

import {
  validateIdentityFields,
  executeAction,
  dispatchAction,
  __resetSchemaExistsCacheForTest,
  type SendMessageAction,
} from './execute-action';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (over: any) => ({ actionId: 'a1', action: { op: 'noop' }, ...over }) as never;

describe('validateIdentityFields', () => {
  it('passes a clean body with no identity claims', () => {
    expect(validateIdentityFields('papercup', body({}))).toBeNull();
  });

  it('rejects a callingHarness that does not match the bearer slug', () => {
    const r = validateIdentityFields('papercup', body({ callingHarness: 'evil' }));
    expect(r).toMatchObject({ status: 403, error: 'identity_mismatch' });
  });

  it('allows a matching callingHarness', () => {
    expect(validateIdentityFields('papercup', body({ callingHarness: 'papercup' }))).toBeNull();
  });

  it('rejects send_message with a spoofed from', () => {
    const r = validateIdentityFields('papercup', body({ action: { op: 'send_message', from: 'evil' } }));
    expect(r).toMatchObject({ status: 403, error: 'identity_mismatch' });
  });

  it('allows send_message with a matching from', () => {
    expect(
      validateIdentityFields('papercup', body({ action: { op: 'send_message', from: 'papercup' } })),
    ).toBeNull();
  });

  it('rejects a caller-supplied parent_slug on scaffold_harness', () => {
    const r = validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness', parent_slug: 'x' } }));
    expect(r).toMatchObject({ status: 400, error: 'parent_slug_not_caller_controlled' });
  });

  it('allows scaffold_harness without parent_slug', () => {
    expect(validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness' } }))).toBeNull();
  });
});

describe('doSendMessage — recipient harness existence (WI-385)', () => {
  // A `system:` caller short-circuits the rate-limit query, so the only DB
  // touchpoints in this path are the existence probe + the INSERT.
  const CALLER = 'system:test';
  const action = (over: Partial<SendMessageAction> = {}): SendMessageAction => ({
    op: 'send_message',
    to: ['target'],
    kind: 'Note',
    subject: 'hi',
    body: 'hello there',
    reason: 'a sufficiently long reason',
    ...over,
  });
  const inserts = () => H.state.unsafeCalls.filter((c) => /INSERT INTO/i.test(c.query));

  beforeEach(() => {
    H.state.existingSchemas = new Set();
    H.state.unsafeCalls = [];
    H.state.probeCalls = [];
    __resetSchemaExistsCacheForTest();
  });
  afterEach(() => {
    H.state.existingSchemas = new Set();
    H.state.unsafeCalls = [];
    H.state.probeCalls = [];
    __resetSchemaExistsCacheForTest();
  });

  it('a non-existent recipient fails cleanly with not_found — no crash, no INSERT', async () => {
    // 'ghost' has no harness_ghost schema registered as existing.
    const r = await dispatchAction(CALLER, action({ to: ['ghost'] }));
    expect(r).toMatchObject({ ok: false, error: 'not_found' });
    expect(r.detail).toContain('ghost');
    // The bug was the INSERT throwing — assert it was never reached.
    expect(inserts()).toHaveLength(0);
  });

  it('an existing recipient inserts into its own schema and succeeds', async () => {
    H.state.existingSchemas.add('harness_target');
    const r = await dispatchAction(CALLER, action({ to: ['target'] }));
    expect(r.ok).toBe(true);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].query).toContain('harness_target.messages');
  });

  it('a multi-recipient batch with one missing recipient fails ATOMICALLY (no partial insert)', async () => {
    H.state.existingSchemas.add('harness_real');
    const r = await dispatchAction(CALLER, action({ to: ['real', 'ghost'] }));
    expect(r).toMatchObject({ ok: false, error: 'not_found' });
    expect(r.detail).toContain('ghost');
    expect(r.detail).not.toContain('real');
    // 'real' exists but must NOT have been inserted — pre-validation runs
    // before any INSERT, so the whole batch is rejected with no side effect.
    expect(inserts()).toHaveLength(0);
  });

  it('names every missing recipient when several are absent', async () => {
    H.state.existingSchemas.add('harness_real');
    const r = await dispatchAction(CALLER, action({ to: ['ghostA', 'real', 'ghostB'] }));
    expect(r).toMatchObject({ ok: false, error: 'not_found' });
    expect(r.detail).toContain('ghostA');
    expect(r.detail).toContain('ghostB');
    expect(inserts()).toHaveLength(0);
  });

  // WI-3800: the existence probe was a top-3 pgbouncer churn driver (~605K
  // catalog scans). A positive result is cached, so a repeat send to the same
  // recipient must NOT re-probe — that is the pool-pressure relief.
  it('caches a positive existence check — a repeat send to the same recipient skips the catalog probe', async () => {
    H.state.existingSchemas.add('harness_target');
    await dispatchAction(CALLER, action({ to: ['target'] }));
    await dispatchAction(CALLER, action({ to: ['target'] }));
    // Two sends, exactly one probe: the second is served from cache.
    expect(H.state.probeCalls.filter((s) => s === 'harness_target')).toHaveLength(1);
    expect(inserts()).toHaveLength(2);
  });

  // Correctness guard: a negative is never cached, so a recipient created after
  // a failed send is seen on the very next attempt (no stale not_found).
  it('does NOT cache a negative — a recipient created after a miss is seen on the next send', async () => {
    const r1 = await dispatchAction(CALLER, action({ to: ['ghost'] }));
    expect(r1).toMatchObject({ ok: false, error: 'not_found' });
    H.state.existingSchemas.add('harness_ghost'); // created between attempts
    const r2 = await dispatchAction(CALLER, action({ to: ['ghost'] }));
    expect(r2.ok).toBe(true);
    // Re-probed on the second attempt (negatives are not cached).
    expect(H.state.probeCalls.filter((s) => s === 'harness_ghost').length).toBeGreaterThanOrEqual(2);
    expect(inserts()).toHaveLength(1);
  });
});
