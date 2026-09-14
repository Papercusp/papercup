/**
 * EI-20352525205864881 — the facts:assert `body` description must describe the
 * cap's REAL enforcement (refuse before the write) rather than the behaviour it
 * replaced (accept-and-clip, discovered afterwards).
 *
 * BACKGROUND. EI-18685042986450096 moved the body cap from "truncate and
 * disclose afterwards" to a REFUSAL BEFORE THE WRITE, because the silent clip
 * had dropped the operative clause of a real fact three times — and a fact
 * folds VERBATIM as binding context, so an unnoticed truncation is not a
 * clipped note, it is a wrong instruction presented as complete.
 *
 * WHAT IT MISSED, and why this guard exists. That change moved the BEHAVIOUR
 * but not the two agent-facing strings describing it. The `body` description
 * every agent reads went on saying an over-cap write was "accepted-and-clipped
 * rather than rejected-and-lost" and that the loss was "silently dropped …
 * only visible after the fact" — the exact OPPOSITE of what the code does. A
 * caller who believed it had no reason to shorten the body or to pass
 * acceptTruncation, so the call was refused. Measured 2026-09-05 on the live
 * invocation ledger, over-cap body was the single largest facts:assert failure
 * family: 497 of 994 invalid_input calls in 9 days (~50%).
 *
 * This is the same failure class as cap-prose-drift.test.ts — agent-facing
 * prose misdescribing enforcement at the moment an agent decides what to do —
 * but on a different axis. That guard keeps the cap NUMBER derived rather than
 * typed; a number can be perfectly derived while the sentence around it
 * describes the wrong outcome, which is what happened here. This guard covers
 * refuse-vs-clip.
 *
 * FALSIFIABILITY. The historical string is kept verbatim below as a permanent
 * positive control and run through the same predicate, so a weakened predicate
 * fails here rather than silently passing everything (a guard that has never
 * failed is a guard nobody has tested). The behavioural assertions at the end
 * pin the premise: if the cap ever legitimately returns to clipping, they fail
 * and force this prose to be revisited WITH the change, instead of leaving the
 * description to rot for weeks the way it just did.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import assertTool from './assert';
import { FACT_BODY_MAX_CHARS } from '../../agent-facts/store';

type AssertSchemaField = { description?: string };

/** Read a field's description off the REAL schema agents are served, not the source text. */
const assertSchemaField = (name: string): AssertSchemaField => {
  // EI-22064465906366039: read the PUBLISHED JSON Schema, not zod internals (the
  // old form reached into the root union's branch list, which no longer exists).
  const json = z.toJSONSchema(assertTool.args as never) as {
    properties?: Record<string, AssertSchemaField>;
  };
  const field = json.properties?.[name];
  if (!field) throw new Error(`facts:assert schema field missing: ${name}`);
  return field;
};

/**
 * Prose shapes that tell the caller an over-cap body is absorbed rather than
 * refused. Each one, believed, produces the same wrong action: send it anyway.
 */
const CLIP_SEMANTICS_PATTERNS: readonly RegExp[] = [
  /accepted-and-clipped/i,
  /rather than rejected-and-lost/i,
  /silently dropped/i,
  /only visible after the fact/i,
  /hard-clipped/i,
];

const violations = (prose: string): string[] =>
  CLIP_SEMANTICS_PATTERNS.filter((p) => p.test(prose)).map((p) => p.source);

/**
 * The description as it actually shipped while the code refused. Kept verbatim
 * as the positive control: the predicate MUST flag it, or the predicate is
 * broken and every assertion below is worthless.
 */
const HISTORICAL_STALE_DESCRIPTION =
  `HARD-CLIPPED AT ${FACT_BODY_MAX_CHARS} CHARS — size your write to this, not the 4000 schema ceiling ` +
  `(that 4000 is transport headroom only, so an over-cap write is accepted-and-clipped rather than ` +
  `rejected-and-lost; anything past ${FACT_BODY_MAX_CHARS} is silently dropped and only visible after ` +
  `the fact via the response's truncated.droppedTail). Front-load the operative clause.`;

describe('facts:assert — body-cap prose matches enforcement (EI-20352525205864881)', () => {
  it('POSITIVE CONTROL: the predicate flags the historical accept-and-clip description', () => {
    // If this ever returns [], the guard below is vacuous — fix the predicate,
    // do not delete this case.
    expect(violations(HISTORICAL_STALE_DESCRIPTION).length).toBeGreaterThan(0);
  });

  it('CALIBRATION: the predicate does not flag prose that correctly describes a refusal', () => {
    expect(
      violations(
        `REFUSED ABOVE ${FACT_BODY_MAX_CHARS} CHARS — NO WRITE HAPPENS; shorten it or re-call with acceptTruncation:true.`,
      ),
    ).toEqual([]);
  });

  it('the shipped body description does not promise clip-instead-of-refuse', () => {
    const prose = assertSchemaField('body').description ?? '';
    expect(prose).not.toBe('');
    expect(violations(prose)).toEqual([]);
  });

  it('the shipped body description names the refusal AND the way forward', () => {
    const prose = assertSchemaField('body').description ?? '';
    // Refusal must be stated: the caller has to know no write happened.
    expect(prose).toMatch(/REFUSED|NO WRITE HAPPENS/i);
    // ...and the escape hatch must be reachable from the same string, or the
    // caller learns only that they failed, not what to do about it.
    expect(prose).toContain('acceptTruncation');
    // The real cap must be interpolated, never a hand-typed digit.
    expect(prose).toContain(String(FACT_BODY_MAX_CHARS));
  });

  it('PREMISE: an over-cap body is still refused at args-parse without acceptTruncation', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'owner',
      scopeRef: 'su-body-cap-prose',
      key: 'k-prose-premise',
      body: 'x'.repeat(FACT_BODY_MAX_CHARS + 40),
      dryRun: true,
    });
    // If this starts passing, the cap no longer refuses and the prose this
    // guard enforces has become wrong in the other direction — update both.
    expect(parsed.success).toBe(false);
  });

  it('PREMISE: acceptTruncation:true is genuinely the documented way through', () => {
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        scopeRef: 'su-body-cap-prose',
        key: 'k-prose-premise-accepted',
        body: 'x'.repeat(FACT_BODY_MAX_CHARS + 40),
        acceptTruncation: true,
        ttlSec: 60,
        dryRun: true,
      }).success,
    ).toBe(true);
  });
});
