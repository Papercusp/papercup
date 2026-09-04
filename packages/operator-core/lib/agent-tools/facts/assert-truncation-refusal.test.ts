/**
 * EI-18685042986450096 (owner-flagged): facts:assert used to write a
 * clipped body UNCONDITIONALLY and only disclose the loss AFTER the write
 * (truncationField) — silently dropping the operative clause 3x, once
 * removing a discriminator rule's verdict sentence entirely. The handler now
 * REFUSES the write up front whenever the body would be clipped, unless the
 * caller explicitly accepts the loss via `acceptTruncation: true`.
 *
 * EI-18690423801323019 — HOW THIS FILE PROVES "no write happened". It used to
 * lean on ambient PG-unreachability: the pass-through cases asserted
 * `.rejects.not.toThrow(/cap/)`, i.e. "the handler rejected, but for a DB
 * reason rather than our refusal". That made the ENVIRONMENT the assertion
 * mechanism, with two consequences:
 *   1. false red — on a box where PG *is* reachable (this dev box), the
 *      handler resolves instead of rejecting and `.rejects` fails outright;
 *   2. worse, a real WRITE — the un-isolated handler wrote live rows into
 *      harness_shared.agent_facts on every run, and facts fold VERBATIM into
 *      every future orient as binding context.
 * So the write path is stubbed at its PG-touching boundary, `assertFact`, and
 * its bounded transaction wrapper; the no-write claim is asserted POSITIVELY
 * against that spy instead of being implied by a missing DB. `assertFact` is
 * the only store IO in the handler:
 * resolveAgentIdentity is pure (ctx-derived), and carryProvenanceFields
 * short-circuits with zero IO for bodies carrying no directive shapes or
 * [turn:…] refs (stampCarrySurfaceProvenance's early return) — as these
 * bodies do not. The suite is therefore hermetic in BOTH environments.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact, AssertFactInput } from '../../agent-facts/store';

const assertFactSpy = vi.hoisted(() => vi.fn<(input: AssertFactInput) => Promise<AgentFact>>());
const resolveFactFederationSlugSpy = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const boundedTxnHarness = vi.hoisted(() => {
  const boundedTx = { query: vi.fn(), marker: 'bounded-org-txn' };
  return {
    boundedTx,
    boundedOrgTxn: vi.fn(async (fn: (tx: typeof boundedTx) => Promise<unknown>) => fn(boundedTx)),
  };
});

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  // Spread the real module: the tool imports clampFactBody / resolveFactScopeRef /
  // FACT_SCOPES / the key-prefix + cap constants from here too, and the refusal
  // logic under test is built on the REAL clamp. Only the write is replaced.
  return {
    ...actual,
    assertFact: assertFactSpy,
    resolveFactFederationSlug: resolveFactFederationSlugSpy,
  };
});
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: boundedTxnHarness.boundedOrgTxn }));

import assertTool, { normalizeMeasurementInput } from './assert';
import { FACT_BODY_MAX_CHARS, clampFactBody } from '../../agent-facts/store';

type AssertSchemaField = { description?: string };

const assertSchemaField = (name: string): AssertSchemaField => {
  const options = (assertTool.args as unknown as { options: Array<{ shape: Record<string, unknown> }> }).options;
  const field = options.map((option) => option.shape[name]).find(Boolean);
  if (!field) throw new Error(`facts:assert schema field missing: ${name}`);
  return field as AssertSchemaField;
};

const ctx = { isSuperuser: true, uiClientId: 'su-test-truncation-refusal' } as never;

/** Stand-in for the persisted row: echoes the input through the REAL clamp, so
 *  the post-write truncation disclosure is still exercised end-to-end. */
function fakeStoredFact(input: AssertFactInput): AgentFact {
  return {
    scope: input.scope,
    scopeRef: input.scopeRef ?? null,
    key: input.key,
    body: clampFactBody(input.body),
    // Echo the caller's tier rather than hardcoding null: this stand-in models
    // the persisted row, so it should reflect whatever the assert was given.
    confidence: input.confidence ?? null,
    measurement:
      input.subjectVolatile === true && input.measuredAt
        ? { subjectVolatile: true, measuredAt: new Date(input.measuredAt).toISOString() }
        : null,
    // P-008 (b): echoed from the input for the same reason `confidence` is —
    // this stand-in models the PERSISTED row, and the assert handler's
    // dependency disclosure reads `fact.dependsOn` back to decide what it
    // could not resolve. Hardcoding [] here would make that path untestable.
    kind: input.kind ?? null,
    dependsOn: [...(input.dependsOn ?? [])],
    claim: input.claim ?? null,
    // P-018 / D-016: echoed from the input for the same reason `confidence` and
    // `kind` are — this stand-in models the PERSISTED row, so hardcoding null
    // would make the enforcement round-trip untestable from here.
    enforcement: input.enforcement ?? null,
    sourceRef: input.sourceRef ?? null,
    audienceScope: input.audienceScope ?? null,
    sourceProvenance: input.sourceProvenance ?? null,
    createdBy: input.createdBy,
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  };
}

/** Parse the tool's JSON text payload. */
function payloadOf(result: Awaited<ReturnType<typeof assertTool.handler>>): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

describe('facts:assert — pre-write truncation refusal (EI-18685042986450096)', () => {
  beforeEach(() => {
    assertFactSpy.mockReset();
    assertFactSpy.mockImplementation(async (input) => fakeStoredFact(input));
    resolveFactFederationSlugSpy.mockReset();
    resolveFactFederationSlugSpy.mockResolvedValue(null);
    boundedTxnHarness.boundedOrgTxn.mockReset();
    boundedTxnHarness.boundedOrgTxn.mockImplementation(async (fn) => fn(boundedTxnHarness.boundedTx));
  });

  it('aggregates ttlDays, ttlSec, and body-cap violations in one args parse (EI-19302143721139535)', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'owner',
      scopeRef: 'su-test',
      key: 'k-aggregate',
      body: 'x'.repeat(FACT_BODY_MAX_CHARS + 147),
      ttlDays: 180,
      ttlSec: 180 * 24 * 3600,
      dryRun: true,
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = JSON.stringify(parsed.error.issues);
    expect(issues).toContain('ttlDays');
    expect(issues).toContain('ttlSec');
    expect(issues).toContain('body');
    expect(issues).toContain(`${FACT_BODY_MAX_CHARS}-char cap`);
  });

  it('keeps the 4000-char transport headroom when truncation is explicitly accepted', () => {
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        scopeRef: 'su-test',
        key: 'k-aggregate-accepted',
        body: 'x'.repeat(FACT_BODY_MAX_CHARS + 147),
        ttlSec: 3600,
        acceptTruncation: true,
        dryRun: true,
      }).success,
    ).toBe(true);
  });

  it('REFUSES an over-cap body with no acceptTruncation — names the overage + previews the exact dropped tail', async () => {
    const body = `${'Front-loaded operative clause. '.repeat(50)}THE VERDICT SENTENCE THAT WOULD BE LOST.`;
    expect(body.length).toBeGreaterThan(FACT_BODY_MAX_CHARS);
    await expect(
      assertTool.handler(
        { scope: 'owner', scopeRef: 'su-test', key: 'k-refuse', body } as never,
        ctx,
      ),
    ).rejects.toThrow(/over the .*char cap|CLIPPED/i);
    // The point of the refusal: it happens BEFORE the write. Asserted, not assumed.
    expect(assertFactSpy).not.toHaveBeenCalled();
  });

  it('the refusal error names the char overage and the cap', async () => {
    const body = 'z'.repeat(FACT_BODY_MAX_CHARS + 137);
    await expect(
      assertTool.handler({ scope: 'owner', scopeRef: 'su-test', key: 'k-overage', body } as never, ctx),
    ).rejects.toThrow(new RegExp(`${FACT_BODY_MAX_CHARS}-char cap`));
    expect(assertFactSpy).not.toHaveBeenCalled();
  });

  it('does NOT refuse (and reaches the write path) for a body within the cap', async () => {
    // A within-cap body must sail past the refusal check straight to assertFact.
    // Asserted at the write boundary itself — the handler resolves cleanly and
    // the store was called ONCE with the body verbatim (nothing clipped, no
    // truncation disclosure).
    const body = 'a short, tight conclusion well within the cap.';
    const result = await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'k-short', body } as never,
      ctx,
    );
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({ key: 'k-short', body });
    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    expect(payload.truncated).toBeUndefined();
  });

  it('acceptTruncation:true skips the refusal and reaches the write path instead', async () => {
    const body = 'y'.repeat(FACT_BODY_MAX_CHARS + 400);
    const result = await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'k-accept', body, acceptTruncation: true } as never,
      ctx,
    );
    // The escape hatch reaches the store with the FULL body (the store, not the
    // tool, owns the clamp) ...
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({ key: 'k-accept', body });
    // ... and the opt-in write is still DISCLOSED as clipped — accepting the
    // truncation must never mean silently accepting it (the EI-18685042986450096
    // failure mode was precisely a clipped write reported as clean).
    const payload = payloadOf(result);
    expect(payload.ok).toBe(true);
    expect(payload.truncated).toMatchObject({ storedChars: FACT_BODY_MAX_CHARS, droppedChars: 400 });
  });

  it('does not default a harness scope to the operator wildcard sentinel', async () => {
    await assertTool.handler(
      { scope: 'harness', key: 'k-wildcard-scope', body: 'a scoped fact' } as never,
      { isSuperuser: true, uiClientId: 'su-test-truncation-refusal', harnessSlug: '*' } as never,
    );
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({ scope: 'harness', scopeRef: null });
  });

  it('REFUSES an unroutable shareable fact before the write', async () => {
    await expect(
      assertTool.handler(
        { scope: 'workspace', key: 'k-unroutable-shareable', body: 'share me', shareable: true } as never,
        ctx,
      ),
    ).rejects.toThrow(/shareable.*federation scope|harness_slug/i);
    expect(resolveFactFederationSlugSpy).toHaveBeenCalledWith(null);
    expect(assertFactSpy).not.toHaveBeenCalled();
  });

  it('passes the resolved hive-home slug for a routable shareable fact', async () => {
    resolveFactFederationSlugSpy.mockResolvedValue('hive-home');
    await assertTool.handler(
      { scope: 'workspace', key: 'k-routable-shareable', body: 'share me', shareable: true } as never,
      { isSuperuser: true, uiClientId: 'su-test-truncation-refusal', harnessSlug: 'member-harness' } as never,
    );
    expect(resolveFactFederationSlugSpy).toHaveBeenCalledWith('member-harness');
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({ shareable: true, potHomeSlug: 'hive-home' });
  });

  it('uses an explicit harness scopeRef as the federation context for a shareable fact (EI-203398)', async () => {
    resolveFactFederationSlugSpy.mockResolvedValue('papercusp');
    await assertTool.handler(
      {
        scope: 'harness',
        scopeRef: 'papercusp',
        key: 'k-shareable-explicit-harness',
        body: 'share me with this harness',
        shareable: true,
      } as never,
      ctx,
    );
    expect(resolveFactFederationSlugSpy).toHaveBeenCalledWith('papercusp');
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({
      scope: 'harness',
      scopeRef: 'papercusp',
      shareable: true,
      potHomeSlug: 'papercusp',
    });
  });

  it('uses the documented harness alias as the federation context for a shareable fact (EI-203398)', async () => {
    resolveFactFederationSlugSpy.mockResolvedValue('papercusp');
    await assertTool.handler(
      {
        scope: 'harness',
        harness: 'papercusp',
        key: 'k-shareable-harness-alias',
        body: 'share me through the compatibility alias',
        shareable: true,
      } as never,
      ctx,
    );
    expect(resolveFactFederationSlugSpy).toHaveBeenCalledWith('papercusp');
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({
      scope: 'harness',
      scopeRef: 'papercusp',
      shareable: true,
      potHomeSlug: 'papercusp',
    });
  });

  it('the acceptTruncation arg description documents the escape hatch (P-007 regression guard stays visible)', () => {
    const description = assertSchemaField('acceptTruncation').description ?? '';
    expect(description).toMatch(/REFUSED/);
    expect(description).toMatch(/never/i);
  });

  it('marks a volatile measurement in the stored fact and response', async () => {
    const measuredAt = '2026-08-11T20:50:00.000Z';
    const result = await assertTool.handler(
      {
        scope: 'owner',
        scopeRef: 'su-test',
        key: 'k-snapshot',
        body: 'currently 29 supported rows',
        subjectVolatile: true,
        measuredAt,
      } as never,
      ctx,
    );
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({
      subjectVolatile: true,
      measuredAt,
    });
    const payload = payloadOf(result);
    expect(payload.fact).toMatchObject({ measurement: { subjectVolatile: true, measuredAt } });
    expect(payload.snapshotWarning).toMatchObject({ measuredAt });
  });

  it('normalizes the persisted/read measurement object into canonical flat write fields', async () => {
    const measuredAt = '2026-08-30T03:19:00.000Z';
    await assertTool.handler(
      {
        scope: 'owner',
        scopeRef: 'su-test',
        key: 'k-measurement-alias',
        body: 'currently 29 supported rows',
        kind: 'conclusion',
        confidence: 'verified',
        recheck: { probe: 'read the fact', falsifier: 'the value changed' },
        measurement: { subjectVolatile: true, measuredAt },
      } as never,
      ctx,
    );
    expect(assertFactSpy).toHaveBeenCalledTimes(1);
    expect(assertFactSpy.mock.calls[0][0]).toMatchObject({
      kind: 'conclusion',
      confidence: 'verified',
      subjectVolatile: true,
      measuredAt,
    });
    expect(assertFactSpy.mock.calls[0][0]).not.toHaveProperty('measurement');
  });

  it('refuses contradictory flat and nested measurement fields before the write', () => {
    expect(() =>
      normalizeMeasurementInput({
        measurement: { subjectVolatile: true, measuredAt: '2026-08-30T03:19:00.000Z' },
        subjectVolatile: false,
      }),
    ).toThrow(/measurement\.subjectVolatile conflicts/i);
    expect(() =>
      normalizeMeasurementInput({
        measurement: { subjectVolatile: true, measuredAt: '2026-08-30T03:19:00.000Z' },
        measuredAt: '2026-08-30T03:20:00.000Z',
      }),
    ).toThrow(/measurement\.measuredAt conflicts/i);
  });
});
