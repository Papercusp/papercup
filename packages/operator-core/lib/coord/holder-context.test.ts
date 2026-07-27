import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRepoFile, readRepoFile } from '@papercusp/test-config';
import {
  projectHolderContext,
  resolveHolderContext,
  asGoalRef,
  HOLDER_ASSUMPTION_KEY_CAP,
  INTENT_STALE_SEC,
  type HolderContext,
  type HolderGoalRecord,
} from './holder-context';
import { autoConvertClaimIntent } from '../plan-items/claim-holder';

/**
 * holder-context.test.ts — P-026's behaviour suite AND its D-047 row 7 PARITY
 * GATE (plan `unified-agent-state-plane-2026-07-27`, ruling D-083).
 *
 * The item's acceptance is "one exported resolver, consumed by at least one live
 * caller, with the D-047 row 7 parity test asserting no caller reaches goal data
 * by any other route". The first half is the behaviour section; the second half
 * is the three parity legs at the bottom.
 *
 * ⚠ WHY THE PARITY LEGS LAND NOW, AT ONE CONSUMER (the P-028 ordering rule, which
 * applies verbatim here). With one consumer the invariant is trivially true and
 * the gate is cheap to write. With the eight consumers D-055 enumerates, each has
 * independently had the chance to bypass it, and the gate must then litigate
 * eight existing call sites instead of preventing them. P-026 exists precisely
 * because "whichever consumer ships first defines the shape" is the failure mode.
 *
 * Legs B and C each carry a DELIBERATE VIOLATION proving the detector fires, and
 * leg C carries a NON-VACUITY assertion (D-076) proving the scan actually scanned.
 */

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const fresh = new Date(NOW - 60_000).toISOString();
const old = new Date(NOW - (INTENT_STALE_SEC + 600) * 1000).toISOString();

const goal = (over: Partial<HolderGoalRecord> = {}): HolderGoalRecord => ({
  itemId: 'P-026',
  intent: 'build the shared HolderContext projection',
  acquiredTs: fresh,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// The shape — D-055's five fields, no more
// ─────────────────────────────────────────────────────────────────────────────

describe('the D-055 shape is fixed', () => {
  /**
   * ⚠ THIS IS THE POINT OF THE WHOLE MODULE. D-055 fixed one shape so that eight
   * injection points do not invent eight; a field added for one consumer's
   * convenience is exactly how that erodes, and it erodes silently because the
   * extra field breaks nothing. If a successor genuinely needs a sixth field, the
   * change is a plan Decision amending D-055 and then this list — not a quiet
   * addition to the interface.
   */
  it('has exactly the five fields D-055 fixed', () => {
    const ctx = projectHolderContext(goal(), ['assumption:a'], NOW);
    expect(ctx).not.toBeNull();
    expect(Object.keys(ctx as HolderContext).sort()).toEqual(
      ['assumptions', 'declaredAt', 'goalRef', 'goalText', 'stale'].sort(),
    );
    expect(Object.keys((ctx as HolderContext).assumptions).sort()).toEqual(['count', 'keys']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule (c) — goalRef is a ref, never a raw bigint
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (c) — goalRef never carries a raw bigint', () => {
  it('passes through resolvable refs', () => {
    expect(asGoalRef('P-026')).toBe('P-026');
    expect(asGoalRef('WI-6389')).toBe('WI-6389');
    expect(asGoalRef('  EI-18802263047567602  ')).toBe('EI-18802263047567602');
  });

  it('nulls a bare bigint — D-046: a bigint is not a read surface', () => {
    // `agent_facts.id` and friends are bigints; a reader handed `184073` can do
    // nothing with it, so it must read as ABSENT rather than present-and-useless.
    expect(asGoalRef('184073')).toBeNull();
    expect(asGoalRef('')).toBeNull();
    expect(asGoalRef(null)).toBeNull();
  });

  it('keeps goalText when the ref is unusable, rather than dropping both', () => {
    const ctx = projectHolderContext(goal({ itemId: '184073' }), [], NOW);
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.goalText).toBe('build the shared HolderContext projection');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal text — reusing the honest-unknown discipline, not re-deriving it
// ─────────────────────────────────────────────────────────────────────────────

describe('goalText reuses declaredGoalOf rather than echoing the intent', () => {
  it('surfaces a declared goal', () => {
    expect(projectHolderContext(goal(), [], NOW)?.goalText).toBe(
      'build the shared HolderContext projection',
    );
  });

  /**
   * ⚠ THE REGRESSION THIS PINS. `plan_item_claims.intent` is 100% populated, but
   * a third of live claims hold the auto-convert MECHANISM string, which names
   * the tool call that took the claim rather than the work. Echoing it verbatim
   * would report that third as goals — the exact defect `declaredGoalOf` exists
   * to prevent, and re-deriving it here instead of importing it is how a second
   * copy would drift from the write site.
   */
  it('refuses the auto-convert mechanism string — it is not a goal', () => {
    const ctx = projectHolderContext(goal({ intent: autoConvertClaimIntent('P-026') }), [], NOW);
    expect(ctx?.goalText).toBeNull();
    expect(ctx?.goalRef).toBe('P-026'); // the claim is still real and still shown
  });

  it('treats a blank intent as an honest unknown, never an empty goal', () => {
    expect(projectHolderContext(goal({ intent: '   ' }), [], NOW)?.goalText).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule (d) — count plus a bounded expansion, never prose
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (d) — assumptions are a count plus a bounded key expansion', () => {
  it('de-duplicates and sorts keys for a stable projection', () => {
    const ctx = projectHolderContext(goal(), ['b', 'a', 'b'], NOW);
    expect(ctx?.assumptions).toEqual({ count: 2, keys: ['a', 'b'] });
  });

  /**
   * ⚠ `count` MUST stay the TRUE total when `keys` is capped. A cap that also
   * truncated the count would silently understate a holder's state — a reader
   * told "3 assumptions" for a holder with 30 makes a worse decision than one
   * told "30, here are the first 12".
   */
  it('caps the key expansion without understating the count', () => {
    const many = Array.from({ length: HOLDER_ASSUMPTION_KEY_CAP + 8 }, (_, i) =>
      `assumption:${String(i).padStart(2, '0')}`,
    );
    const ctx = projectHolderContext(goal(), many, NOW);
    expect(ctx?.assumptions.count).toBe(many.length);
    expect(ctx?.assumptions.keys).toHaveLength(HOLDER_ASSUMPTION_KEY_CAP);
  });

  it('drops malformed keys instead of rendering them', () => {
    const ctx = projectHolderContext(goal(), ['ok', '', '   ', null as unknown as string], NOW);
    expect(ctx?.assumptions).toEqual({ count: 1, keys: ['ok'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule (e) — stale is the GOAL's age
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (e) — stale is derived from declaredAt', () => {
  it('a freshly declared goal is not stale', () => {
    expect(projectHolderContext(goal({ acquiredTs: fresh }), [], NOW)?.stale).toBe(false);
  });

  it('a goal declared beyond INTENT_STALE_SEC ago is stale', () => {
    expect(projectHolderContext(goal({ acquiredTs: old }), [], NOW)?.stale).toBe(true);
  });

  /**
   * ⚠ UNKNOWN, NOT FALSE. An undated or unparseable goal must never read as
   * "freshly declared" — that is precisely the "stale value reads as current"
   * defect rule (e) exists to prevent, and `false` is the confident wrong answer.
   */
  it('an undated or unparseable goal yields UNKNOWN staleness, never false', () => {
    expect(projectHolderContext(goal({ acquiredTs: null }), ['a'], NOW)?.stale).toBeNull();
    expect(projectHolderContext(goal({ acquiredTs: 'not-a-date' }), ['a'], NOW)?.stale).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules (b) + (f) — absent-vs-unreadable, and totality
// ─────────────────────────────────────────────────────────────────────────────

describe('rule (b) — nothing disclosable is null, and unreadable looks like absent', () => {
  it('returns null when there is no goal and no visible assumption', () => {
    expect(projectHolderContext(null, [], NOW)).toBeNull();
    expect(projectHolderContext(undefined, [], NOW)).toBeNull();
  });

  it('still projects assumptions for a holder with no claim', () => {
    const ctx = projectHolderContext(null, ['assumption:x'], NOW);
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.assumptions.count).toBe(1);
  });

  /**
   * ⚠ THE INDISTINGUISHABILITY IS THE FEATURE (P-019's rule, applied to facts).
   * A reader who may not see a holder's assumptions gets the SAME answer as one
   * whose holder has none. If a refusal looked different from empty, a reader
   * could probe for the EXISTENCE of state it may not read — which is why the
   * item notes a refusal is not a probe oracle.
   */
  it('a refused assumptions read is indistinguishable from an empty one', async () => {
    const reader = { ownerId: 'su-reader' };
    const refused = await resolveHolderContext('su-holder', reader, {
      holderGoal: async () => goal(),
      holderAssumptionKeys: async () => {
        throw new Error('audience refused');
      },
    }, { nowMs: NOW });
    const empty = await resolveHolderContext('su-holder', reader, {
      holderGoal: async () => goal(),
      holderAssumptionKeys: async () => [],
    }, { nowMs: NOW });
    expect(refused).toEqual(empty);
  });
});

describe('rule (f) — total, and fails closed on a missing reader', () => {
  it('never throws on a hostile record', () => {
    expect(() =>
      projectHolderContext({ itemId: undefined as unknown as string, intent: 42 as unknown as string }, [], NOW),
    ).not.toThrow();
  });

  it('a dead goal source degrades ONE field, leaving assumptions intact', async () => {
    const ctx = await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, {
      holderGoal: async () => {
        throw new Error('pg down');
      },
      holderAssumptionKeys: async () => ['assumption:a'],
    }, { nowMs: NOW });
    expect(ctx?.goalRef).toBeNull();
    expect(ctx?.assumptions.count).toBe(1);
  });

  /**
   * ⚠ FAILS CLOSED, for the reason `getCell` requires a reader: an optional
   * audience is a defaulted audience, and a defaulted access check fails OPEN.
   * This is what makes it safe for a consumer to thread the reader optionally.
   */
  it('yields NO context when the reader is unidentified', async () => {
    const sources = {
      holderGoal: async () => goal(),
      holderAssumptionKeys: async () => ['assumption:a'],
    };
    expect(await resolveHolderContext('su-holder', undefined, sources, { nowMs: NOW })).toBeNull();
    expect(await resolveHolderContext('su-holder', { ownerId: '  ' }, sources, { nowMs: NOW })).toBeNull();
    expect(await resolveHolderContext('  ', { ownerId: 'su-reader' }, sources, { nowMs: NOW })).toBeNull();
  });

  it('omitted sources yield nothing rather than an approximation', async () => {
    expect(await resolveHolderContext('su-holder', { ownerId: 'su-reader' }, {}, { nowMs: NOW })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE D-047 ROW 7 PARITY GATE — no caller reaches goal data by another route
// ═════════════════════════════════════════════════════════════════════════════

const LIB_DIR = path.dirname(resolveRepoFile(__dirname, 'packages/operator-core/lib/cell-registry.ts'));
const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..');

/**
 * ⚠ THE SCAN READS CODE, NOT PROSE — and this is a correctness property, not a
 * tidiness one. Each leg below documents the anti-pattern it forbids, which means
 * each leg's own module WRITES that anti-pattern down in a comment. A detector
 * matching raw file text therefore fires on the warning ABOUT the bug as loudly
 * as on the bug — caught here on the first run, where all three legs flagged
 * their own docstrings. The cost of that failure mode is not a red test; it is
 * that the cheapest way to make the gate green becomes DELETING the explanation
 * of why the trap exists. A gate that punishes documenting the trap is worse than
 * no gate.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function scanLib(matches: (code: string) => boolean): string[] {
  const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.turbo']);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (matches(stripComments(readFileSync(full, 'utf8')))) {
        hits.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(LIB_DIR);
  return hits.sort();
}

describe('the scan strips comments before matching', () => {
  /**
   * The stripper is load-bearing for all three legs, so it gets its own check: an
   * over-eager stripper that ate CODE would make every leg silently vacuous, which
   * is the same "green because it stopped looking" failure the non-vacuity
   * assertions guard against from the other direction.
   */
  it('removes comment text but preserves code', () => {
    const src = [
      '/* never write kind = \'assumption\' */',
      "const q = `WHERE scope = 'owner'`;",
      "// and never SELECT intent FROM harness_shared.plan_item_claims",
      'const goalRef = resolve();',
    ].join('\n');
    const out = stripComments(src);
    expect(out).not.toMatch(/never write/);
    expect(out).not.toMatch(/plan_item_claims/);
    expect(out).toMatch(/WHERE scope = 'owner'/);
    expect(out).toMatch(/const goalRef = resolve\(\)/);
  });

  it('does not mistake a URL for a line comment', () => {
    expect(stripComments("const u = 'https://example.test/x';")).toMatch(/https:\/\/example/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG A — the resolver is the only DERIVATION: no consumer builds the shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A file assembling a holder context rather than consuming one.
 *
 * ⚠ KEYS ON THE PAIR, NOT ON `goalRef` ALONE — because `goalRef` alone is a
 * FIELD-NAME COLLISION, not the shape. `coordination/message-fields.ts` declares
 * `MessageWhy.goalRef` for P-014's message envelope (D-011: "a goal REF, never
 * prose"), which is a different record that legitimately names the same concept.
 * Flagging it would have taught the reader that this gate cries wolf, and the
 * first fix anyone reached for would be to widen the allowlist — spending the
 * gate's credibility on a file that was never the risk. The shape's actual
 * signature is `goalRef` TOGETHER WITH `assumptions`; nothing else in the tree
 * pairs them.
 */
const CONSTRUCTS_SHAPE = (code: string): boolean =>
  /\bgoalRef\b/.test(code) && /\bassumptions\b/.test(code);

const SHAPE_ALLOWLIST: Record<string, string> = {
  'packages/operator-core/lib/coord/holder-context.ts':
    'defines the projection — the one derivation every consumer reads',
};

describe('LEG A — only the resolver constructs a HolderContext', () => {
  it('no consumer assembles the shape itself', () => {
    const found = scanLib(CONSTRUCTS_SHAPE);

    // ⚠ NON-VACUITY (D-076). A walk that scanned zero files — a moved directory,
    // a bad anchor, an over-broad skip list — yields an empty `found`, filters to
    // an empty `offenders`, and reports GREEN: a gate that has stopped gating
    // while still looking healthy. The definer must always be found FIRST.
    expect(
      found,
      'the shape scan found nothing at all — it is not scanning the tree, so its GREEN is meaningless',
    ).toContain('packages/operator-core/lib/coord/holder-context.ts');

    const offenders = found.filter((f) => !(f in SHAPE_ALLOWLIST));
    expect(
      offenders,
      `these files construct a HolderContext-shaped object instead of calling ` +
        `resolveHolderContext: ${offenders.join(', ')}. D-055 fixed ONE shape for eight ` +
        `injection points; a second construction site is how eight shapes start.`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG B — the goal PRODUCER is read in one place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `plan_item_claims.intent` is THE goal producer (D-083 §2: 7 of 7 live claims
 * populated). A surface reading it directly to answer "what is this holder
 * doing" bypasses `declaredGoalOf`, and so re-introduces the mechanism-string
 * bug for its own readers — silently, because the column is 100% populated and
 * the wrong answer is a well-formed string.
 */
const READS_CLAIM_INTENT = (code: string): boolean =>
  /SELECT[\s\S]{0,400}?\bintent\b[\s\S]{0,400}?FROM\s+harness_shared\.plan_item_claims/i.test(code);

/**
 * ⚠ THE ALLOWLIST DRAWS THE LINE AT *RENDERING*, NOT AT *TOUCHING*. Reading the
 * column is not the defect — turning it into a goal shown to a reader without
 * `declaredGoalOf` is. So the claim STORE is allowlisted (it hands back the whole
 * row, and every rendering path downstream goes through a projection) while a NEW
 * direct SELECT is not, because that is what a surface inventing its own goal
 * rendering looks like.
 *
 * Note what is deliberately NOT here, having been checked rather than assumed:
 * `presence-tier1.ts` and `plan-item-coverage.ts` both mention the table but
 * select only `owner`/`item_id` — they never read the intent at all.
 */
const CLAIM_INTENT_ALLOWLIST: Record<string, string> = {
  'packages/operator-core/lib/agent-tools/coordination/holder-context-sources.ts':
    'P-026 goal source — the one reader-relative route, projected via declaredGoalOf',
  'packages/operator-core/lib/plan-items/claims.ts':
    'the claim STORE: returns the raw ClaimDbRow. Goal RENDERING happens downstream ' +
    'in claim-holder.ts (reader-independent) / holder-context.ts (reader-relative), ' +
    'both of which route through declaredGoalOf',
};

describe('LEG B — the goal producer has one reader', () => {
  it('every direct reader of the goal producer is allowlisted', () => {
    const found = scanLib(READS_CLAIM_INTENT);

    expect(
      found,
      'the producer scan found nothing at all — it is not scanning the tree, so its GREEN is meaningless',
    ).toContain('packages/operator-core/lib/agent-tools/coordination/holder-context-sources.ts');

    const offenders = found.filter((f) => !(f in CLAIM_INTENT_ALLOWLIST));
    expect(
      offenders,
      `these files read plan_item_claims.intent directly: ${offenders.join(', ')}. A raw ` +
        `intent is NOT a goal — a third of live claims hold the auto-convert mechanism ` +
        `string. Route through resolveHolderContext (or declaredGoalOf for the ` +
        `reader-independent projection), or add a reasoned allowlist entry.`,
    ).toEqual([]);
  });

  /** ⚠ THE DELIBERATE VIOLATION for leg B. */
  it('DELIBERATE VIOLATION: a new surface querying the producer is detected', () => {
    const violating = `
      const rows = await sql\`SELECT owner, intent FROM harness_shared.plan_item_claims WHERE owner = \${o}\`;
    `;
    expect(READS_CLAIM_INTENT(violating)).toBe(true);

    // ...and a compliant consumer, which never names the table, is not tripped.
    const compliant = `const ctx = await resolveHolderContext(owner, reader, holderContextSources());`;
    expect(READS_CLAIM_INTENT(compliant)).toBe(false);

    // ...nor is a WRITE, or a mere mention of the table without reading intent —
    // the gate targets goal RENDERING, not every use of the claim store.
    expect(READS_CLAIM_INTENT(`INSERT INTO harness_shared.plan_item_claims (owner, intent)`)).toBe(false);
    expect(READS_CLAIM_INTENT(`SELECT owner, item_id FROM harness_shared.plan_item_claims`)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG C — the assumptions producer is not read by `kind`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THE D-082-CLASS TRAP, GATED. `agent_facts.kind` has a CHECK constraint
 * admitting `'assumption'`, so `kind = 'assumption'` is the reading the schema
 * invites — and `kind` is populated on 13 of 2,076 rows. Such a query typechecks,
 * passes every hand-built fixture, and derives nothing in production. Only a
 * check against the producer catches it, so it is pinned here as a constant.
 */
const ASSUMPTION_KIND_FILTER_RE = /kind\s*(?:=|===)\s*['"`]assumption['"`]/;
const ASSUMPTION_KIND_FILTER = (code: string): boolean => ASSUMPTION_KIND_FILTER_RE.test(code);

describe('LEG C — assumptions are never keyed off the unpopulated `kind` column', () => {
  it('no file filters facts by kind = assumption', () => {
    const offenders = scanLib(ASSUMPTION_KIND_FILTER);
    expect(
      offenders,
      `these files filter agent_facts by kind='assumption': ${offenders.join(', ')}. That ` +
        `column is populated on 13 of 2,076 rows (D-083 §2), so the query derives nothing ` +
        `live while passing every fixture. Assumptions are the holder's live owner-scoped ` +
        `facts BY KEY.`,
    ).toEqual([]);
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION for leg C. Unlike legs A and B there is no
   * non-vacuity anchor available — the correct production state is ZERO hits, so
   * an empty result is the PASS rather than a suspicious one. This violation is
   * therefore the whole proof that the detector fires at all: without it, the
   * assertion above is indistinguishable from a regex that matches nothing.
   */
  it('DELIBERATE VIOLATION: a kind-filtered assumptions query is detected', () => {
    expect(ASSUMPTION_KIND_FILTER_RE.test(`AND kind = 'assumption'`)).toBe(true);
    expect(ASSUMPTION_KIND_FILTER_RE.test(`f.kind === "assumption"`)).toBe(true);

    // The correct production form — fold by scope + key — must NOT trip it.
    expect(
      ASSUMPTION_KIND_FILTER_RE.test(`foldFacts([{ scope: 'owner', scopeRef: owner }])`),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live consumer — acceptance requires at least one
// ─────────────────────────────────────────────────────────────────────────────

describe('the resolver has a live consumer', () => {
  it('enrich-busy (D-055 A1) resolves holder context through the shared resolver', () => {
    const src = readRepoFile(__dirname, 'packages/operator-core/lib/agent-tools/locks/enrich-busy.ts');
    expect(src).toMatch(/resolveHolderContext\(/);
    expect(src).toMatch(/holderContextSources\(\)/);
    // It must pass the BLOCKED caller through as the reader, not a default one:
    // holder context is reader-relative, and a defaulted audience fails open.
    expect(src).toMatch(/reader\s*\?\s*holderContextSources\(\)\s*:\s*null/);
  });
});
