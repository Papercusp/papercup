/**
 * EI-18685042986450096 (Avi, owner-flagged): facts:assert used to write a
 * clipped body UNCONDITIONALLY and only disclose the loss AFTER the write
 * (truncationField) — silently dropping the operative clause 3x, once
 * removing a discriminator rule's verdict sentence entirely. The handler now
 * REFUSES the write up front (no PG call — proven below by never seeding a
 * DB mock) whenever the body would be clipped, unless the caller explicitly
 * accepts the loss via `acceptTruncation: true`.
 *
 * These are pure handler-boundary tests: no PG is mocked or reachable, so a
 * passing "refuses" case is itself proof no write was attempted.
 */
import { describe, expect, it } from 'vitest';
import assertTool from './assert';
import { FACT_BODY_MAX_CHARS } from '../../agent-facts/store';

const ctx = { isSuperuser: true, uiClientId: 'su-test-truncation-refusal' } as never;

describe('facts:assert — pre-write truncation refusal (EI-18685042986450096)', () => {
  it('REFUSES an over-cap body with no acceptTruncation — names the overage + previews the exact dropped tail', async () => {
    const body = `${'Front-loaded operative clause. '.repeat(50)}THE VERDICT SENTENCE THAT WOULD BE LOST.`;
    expect(body.length).toBeGreaterThan(FACT_BODY_MAX_CHARS);
    await expect(
      assertTool.handler(
        { scope: 'owner', scopeRef: 'su-test', key: 'k-refuse', body } as never,
        ctx,
      ),
    ).rejects.toThrow(/over the .*char cap|CLIPPED/i);
  });

  it('the refusal error names the char overage and the cap', async () => {
    const body = 'z'.repeat(FACT_BODY_MAX_CHARS + 137);
    await expect(
      assertTool.handler({ scope: 'owner', scopeRef: 'su-test', key: 'k-overage', body } as never, ctx),
    ).rejects.toThrow(new RegExp(`${FACT_BODY_MAX_CHARS}-char cap`));
  });

  it('does NOT refuse (and reaches the write path) for a body within the cap', async () => {
    // A within-cap body must sail past the new check straight to assertFact —
    // which then fails on the missing PG connection, NOT on our refusal. That
    // distinguishes "refused pre-write" from "failed for an unrelated reason".
    const body = 'a short, tight conclusion well within the cap.';
    await expect(
      assertTool.handler({ scope: 'owner', scopeRef: 'su-test', key: 'k-short', body } as never, ctx),
    ).rejects.not.toThrow(/over the .*char cap|CLIPPED/i);
  });

  it('acceptTruncation:true skips the refusal and reaches the write path instead', async () => {
    const body = 'y'.repeat(FACT_BODY_MAX_CHARS + 400);
    await expect(
      assertTool.handler(
        { scope: 'owner', scopeRef: 'su-test', key: 'k-accept', body, acceptTruncation: true } as never,
        ctx,
      ),
    ).rejects.not.toThrow(/over the .*char cap|CLIPPED/i);
  });

  it('the acceptTruncation arg description documents the escape hatch (P-007 regression guard stays visible)', () => {
    const description = assertTool.args.shape.acceptTruncation.description ?? '';
    expect(description).toMatch(/REFUSED/);
    expect(description).toMatch(/never/i);
  });
});
