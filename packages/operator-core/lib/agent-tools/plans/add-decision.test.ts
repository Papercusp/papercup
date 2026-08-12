/**
 * plans:add-decision — `itemRefs` alias for `refs` (EI-18735663944089262).
 *
 * plans:get echoes a decision's item refs back under the field name
 * `itemRefs`, but plans:add-decision only ever declared `refs` — so writing
 * back exactly what you just read was rejected with `Unrecognized key:
 * "itemRefs"`. This declares `itemRefs` as an accepted alias (schema-level,
 * so the EI-10883 closed-shape guard still rejects genuinely unknown keys)
 * and has the handler prefer `refs` when both are supplied.
 *
 * Schema-only (no DB): `tool.args` is the same `strictArgs(...)`-wrapped
 * zod schema the dispatcher validates every call against, so a
 * `safeParse` here exercises exactly what a live call would hit.
 */
import { describe, it, expect } from 'vitest';
import tool, {
  findRetryDuplicateOfLastDecision,
  appendDecisionToBody,
  allocateNextDecisionId,
} from './add-decision';
import { parsePlan } from './parser';

describe('plans:add-decision — itemRefs alias for refs', () => {
  it('accepts `itemRefs` on a single-decision call (the exact read-then-write repro)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      itemRefs: ['P-008', 'P-012'],
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts the canonical `refs` field', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      refs: ['P-008'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts `itemRefs` on a per-item entry of a bulk `items` call', () => {
    const parsed = tool.args.safeParse({
      items: [
        { slug: 'some-plan', title: 'A decision', body: 'Body text.', itemRefs: ['P-008'] },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('documents the shared P-NNN namespace on the itemRefs alias', () => {
    expect(tool.args.shape.itemRefs.description).toMatch(/same in-plan `P-NNN` reference format/i);
  });

  it('still rejects a genuinely unknown key (EI-10883 closed shape intact)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      notAField: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed itemRefs entry the same way refs is validated (P-NNN shape)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      itemRefs: ['not-a-p-id'],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * EI-19383795443003151: an MCP write can time out client-side with no
 * response, leaving the outcome unknown. `plans:add-decision` only ever
 * appends, so a blind retry risked minting a duplicate decision. These pin
 * `findRetryDuplicateOfLastDecision` — the pure check that makes a retry
 * safe — both standalone and threaded through the real append/allocate
 * helpers so a plan body constructed exactly like the live write path is
 * exercised (no DB — those helpers are pure string transforms).
 */
describe('plans:add-decision — retry-safety (EI-19383795443003151)', () => {
  const BASE_PLAN = [
    '---',
    'slug: some-plan',
    'status: active',
    '---',
    '',
    '## Now',
    'State: testing',
    '',
    '## Decisions',
    '',
  ].join('\n');

  function appendOne(body: string, title: string, decisionBody: string, refs: string[] = []): string {
    const id = allocateNextDecisionId(body);
    return appendDecisionToBody(body, id, title, decisionBody, '2026-08-03', refs);
  }

  it('findRetryDuplicateOfLastDecision: no decisions yet → null', () => {
    expect(findRetryDuplicateOfLastDecision([], 'Title', 'Body')).toBeNull();
  });

  it('an exact-match retry of the MOST RECENT decision is found', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    expect(parsed.decisions).toHaveLength(1);

    const dup = findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'We chose A because it is simpler.');
    expect(dup).not.toBeNull();
    expect(dup?.id).toBe(parsed.decisions[0]?.id);
  });

  it('a DIFFERENT title against the same last decision does not match', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    expect(findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option B', 'We chose A because it is simpler.')).toBeNull();
  });

  it('a DIFFERENT body against the same last decision does not match', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    expect(findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'Actually we chose B.')).toBeNull();
  });

  it('an identical title+body recorded EARLIER (not the last decision) is NOT deduped', () => {
    // Two genuinely distinct decisions can legitimately share the same text
    // (e.g. a decision reaffirmed later under a new id) — only the TAIL
    // decision is eligible, so retrying the FIRST one's exact text after a
    // second, different decision has landed must not match it.
    let body = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    body = appendOne(body, 'Pick option C', 'Later we also chose C for a separate reason.');
    const parsed = parsePlan(body, { filePath: 'some-plan.md' });
    expect(parsed.decisions).toHaveLength(2);

    // Retrying the FIRST decision's exact text now finds nothing — it is no
    // longer the tail, so this correctly falls through to allocating a new id
    // rather than silently colliding with an unrelated later decision.
    expect(findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'We chose A because it is simpler.')).toBeNull();
    // Retrying the SECOND (actually most recent) decision's exact text does match.
    const dup = findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option C', 'Later we also chose C for a separate reason.');
    expect(dup?.id).toBe(parsed.decisions[1]?.id);
  });

  it('refs on the original call do not defeat the match (containment, not equality)', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.', ['P-001', 'P-002']);
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    const dup = findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'We chose A because it is simpler.');
    expect(dup?.id).toBe(parsed.decisions[0]?.id);
  });

  it('whitespace-only differences in title/body still match (both sides are trimmed)', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    const dup = findRetryDuplicateOfLastDecision(
      parsed.decisions,
      '  Pick option A  ',
      '  We chose A because it is simpler.  ',
    );
    expect(dup?.id).toBe(parsed.decisions[0]?.id);
  });
});
