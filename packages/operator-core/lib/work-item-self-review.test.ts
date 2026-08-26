/**
 * Arm B (P-005) — the forced, ledger-corroborated self-review judgement.
 *
 * The controls here are the point. A gate that only ever sees well-formed input stops being
 * evidence that it discriminates at all, so every verdict has both a case that reaches it and
 * a neighbouring case that does not.
 */
import { describe, it, expect } from 'vitest';
import {
  SESSION_TURN_PARTS_WORKSPACE_ID,
  claimsSelfReview,
  itemIsArmB,
  judgeSelfReview,
  lastEditAtMs,
  normalizeToolName,
  selfReviewLedgerQuery,
  toSelfReviewLedgerRow,
  type SelfReviewLedgerRow,
} from './work-item-self-review';

const T = (min: number): number => Date.parse('2026-08-26T01:00:00Z') + min * 60_000;

const row = (
  toolName: string,
  min: number,
  status?: string,
): SelfReviewLedgerRow => ({ toolName, invokedAtMs: T(min), status });

const REVIEWED = { lookedAt: 'the full diff', findings: ['off-by-one in the retry bound'] };

describe('itemIsArmB — the opt-in marker (D-020)', () => {
  it('DEFAULTS TO FALSE for everything that is not explicitly arm B', () => {
    // The single most load-bearing assertion in this file. A true here would make arm A and
    // arm B the same arm AND refuse every in-flight close in the fleet.
    expect(itemIsArmB(undefined)).toBe(false);
    expect(itemIsArmB(null)).toBe(false);
    expect(itemIsArmB({})).toBe(false);
    expect(itemIsArmB({ payload: null })).toBe(false);
    expect(itemIsArmB({ payload: {} })).toBe(false);
    expect(itemIsArmB({ payload: 'B' })).toBe(false); // a string payload is not a marker
    expect(itemIsArmB({ payload: { pilotArm: 'A' } })).toBe(false);
    expect(itemIsArmB({ payload: { pilotArm: 'C' } })).toBe(false);
    expect(itemIsArmB({ payload: { pilotArm: true } })).toBe(false);
  });

  it('is true only on an explicit B, case- and whitespace-insensitive', () => {
    expect(itemIsArmB({ payload: { pilotArm: 'B' } })).toBe(true);
    expect(itemIsArmB({ payload: { pilotArm: 'b' } })).toBe(true);
    expect(itemIsArmB({ payload: { pilotArm: ' B ' } })).toBe(true);
  });
});

describe('selfReviewLedgerQuery — the false-absence seam (EI-21476445557415319)', () => {
  const q = selfReviewLedgerQuery({
    workspaceId: 'papercusp-workspace',
    coordOwnerId: 'su-abc',
    goalRef: 'WI-1',
    sinceMs: T(0),
  });

  it('does NOT filter by harness_slug', () => {
    // A workspace-scoped su session files under harness_slug='*', so a harness predicate
    // returns a clean zero for it — indistinguishable from "no review happened".
    expect(q.text).not.toMatch(/harness_slug/);
  });

  it('admits rows whose goal_ref is null rather than dropping them', () => {
    expect(q.text).toMatch(/goal_ref\s*=\s*\$3\s*OR\s*goal_ref\s+IS\s+NULL/i);
  });

  it('pins to workspace + owner + goal + window, in that parameter order', () => {
    expect(q.text).toMatch(/workspace_id\s*=\s*\$1/);
    expect(q.text).toMatch(/coord_owner_id\s*=\s*\$2/);
    expect(q.text).toMatch(/invoked_at\s*>=\s*\$4/);
    expect(q.values.slice(0, 3)).toEqual(['papercusp-workspace', 'su-abc', 'WI-1']);
    expect(q.values[3]).toBeInstanceOf(Date);
  });
});

describe('toSelfReviewLedgerRow', () => {
  it('accepts a Date and an ISO string alike', () => {
    const iso = new Date(T(3)).toISOString();
    expect(toSelfReviewLedgerRow({ tool_name: 'capability:git', invoked_at: iso })).toEqual({
      toolName: 'capability:git',
      invokedAtMs: T(3),
      status: undefined,
    });
    expect(
      toSelfReviewLedgerRow({ tool_name: 'capability:git', invoked_at: new Date(T(3)) })
        ?.invokedAtMs,
    ).toBe(T(3));
  });

  it('drops rows it cannot trust rather than inventing a timestamp', () => {
    // A row coerced to epoch 0 would silently read as "reviewed before everything",
    // which is the stale-review check's worst input.
    expect(toSelfReviewLedgerRow({ tool_name: 'capability:git', invoked_at: 'nonsense' })).toBeUndefined();
    expect(toSelfReviewLedgerRow({ invoked_at: new Date() })).toBeUndefined();
    expect(toSelfReviewLedgerRow({})).toBeUndefined();
  });
});

describe('claimsSelfReview', () => {
  it('is false for absent, empty, and whitespace-only evidence', () => {
    expect(claimsSelfReview(undefined)).toBe(false);
    expect(claimsSelfReview(null)).toBe(false);
    expect(claimsSelfReview({})).toBe(false);
    expect(claimsSelfReview({ lookedAt: '   ' })).toBe(false);
  });

  it('is true when any of the three fields carries content', () => {
    expect(claimsSelfReview({ lookedAt: 'the diff' })).toBe(true);
    expect(claimsSelfReview({ findings: ['a bug'] })).toBe(true);
    expect(claimsSelfReview({ changedAsResult: ['fixed it'] })).toBe(true);
  });

  it('counts an explicit zero-findings review as a claim, not as silence', () => {
    // The distinction that makes rubberStampRisk measurable rather than inferred.
    expect(claimsSelfReview({ lookedAt: 'the diff', findings: [] })).toBe(true);
  });
});

describe('lastEditAtMs', () => {
  it('returns the latest successful edit', () => {
    expect(
      lastEditAtMs([row('capability:edit', 1), row('capability:write', 5), row('capability:read', 9)]),
    ).toBe(T(5));
  });

  it('ignores edits that did not succeed', () => {
    // A refused edit changed nothing, so it must not move the clock a review has to beat.
    expect(lastEditAtMs([row('capability:edit', 1), row('capability:edit', 8, 'refused')])).toBe(T(1));
  });

  it('is undefined when nothing was edited', () => {
    expect(lastEditAtMs([row('capability:read', 3)])).toBeUndefined();
  });
});

describe('judgeSelfReview', () => {
  it('not-claimed when no review was recorded', () => {
    const v = judgeSelfReview({ evidence: {}, ledger: [row('capability:git', 5)] });
    expect(v.verdict).toBe('not-claimed');
    // Even with a real diff read in the ledger: the gate reports what was CLAIMED,
    // it does not award a review the agent never stated.
    expect(v.reviewCalls).toEqual([]);
  });

  it('uncorroborated when the claim rests on prose alone', () => {
    const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:edit', 1)] });
    expect(v.verdict).toBe('uncorroborated');
    expect(v.reason).toMatch(/prose alone/);
  });

  it('does NOT let incidental traffic corroborate a review', () => {
    // The failure that makes a gate worse than none: manufacturing evidence.
    const v = judgeSelfReview({
      evidence: REVIEWED,
      ledger: [row('coord:send', 4), row('plans:get', 5), row('work_items:get', 6)],
    });
    expect(v.verdict).toBe('uncorroborated');
  });

  it('does not count a refused read as a review', () => {
    const v = judgeSelfReview({
      evidence: REVIEWED,
      ledger: [row('capability:read', 5, 'refused')],
    });
    expect(v.verdict).toBe('uncorroborated');
  });

  it('corroborated when a real read is on the ledger', () => {
    const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:git', 5)] });
    expect(v.verdict).toBe('corroborated');
    expect(v.reviewCalls).toHaveLength(1);
  });

  describe('the stale-review check — a review must post-date the last edit', () => {
    it('catches a review that was overtaken by a later edit', () => {
      // Reads as compliant in a transcript: the diff read really happened.
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('capability:edit', 1), row('capability:git', 5), row('capability:edit', 9)],
      });
      expect(v.verdict).toBe('stale-review');
      expect(v.reason).toMatch(/predates the last edit/);
    });

    it('accepts the same history once the diff is re-read after the final edit', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [
          row('capability:edit', 1),
          row('capability:git', 5),
          row('capability:edit', 9),
          row('capability:git', 11),
        ],
      });
      expect(v.verdict).toBe('corroborated');
    });

    it('is not tripped by a failed edit after the review', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('capability:git', 5), row('capability:edit', 9, 'refused')],
      });
      expect(v.verdict).toBe('corroborated');
    });

    it('corroborates a review-only close, where nothing was edited at all', () => {
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:read', 5)] });
      expect(v.verdict).toBe('corroborated');
    });
  });

  describe('pilot measurements (P-007 reads these — they are not pass/fail)', () => {
    it('flags rubber-stamp risk on a corroborated review that found nothing', () => {
      const v = judgeSelfReview({
        evidence: { lookedAt: 'the diff', findings: [] },
        ledger: [row('capability:git', 5)],
      });
      expect(v.verdict).toBe('corroborated'); // still a pass — this is a measurement
      expect(v.rubberStampRisk).toBe(true);
    });

    it('does not flag rubber-stamp risk when the review found something', () => {
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:git', 5)] });
      expect(v.rubberStampRisk).toBe(false);
    });

    it('reports yieldedChange so a review YIELD can be computed per arm', () => {
      const found = judgeSelfReview({
        evidence: { ...REVIEWED, changedAsResult: ['clamped the bound'] },
        ledger: [row('capability:git', 5)],
      });
      expect(found.yieldedChange).toBe(true);

      const none = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability:git', 5)] });
      expect(none.yieldedChange).toBe(false);
    });

    it('still reports yield on an uncorroborated claim, so the arm is measurable either way', () => {
      const v = judgeSelfReview({
        evidence: { ...REVIEWED, changedAsResult: ['clamped the bound'] },
        // A non-empty ledger with no review in it. An EMPTY one is `unobservable`, a
        // different verdict with a different reason (EI-21481919801123128).
        ledger: [row('capability:edit', 1)],
      });
      expect(v.verdict).toBe('uncorroborated');
      expect(v.yieldedChange).toBe(true);
    });
  });

  it('matches a tool name in either the colon or the client-mangled spelling', () => {
    // Same fold the confinement matcher relies on: a denial or a credit that caught only one
    // spelling would be evadable by invoking the other.
    const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('capability_git', 5)] });
    expect(v.verdict).toBe('corroborated');
  });
});

/**
 * EI-21481919801123128 — the gate could only see agents who routed their reads through MCP.
 *
 * The controls matter more here than anywhere else in this file, because the fix WIDENS what
 * counts as evidence. Every "now passes" case below is paired with a case that must still
 * fail, or the fix would be indistinguishable from deleting the gate.
 */
describe('native-client review corroboration', () => {
  describe('normalizeToolName — the same call wears three names across two ledgers', () => {
    it('folds the colon, mangled-MCP, and native spellings onto one key', () => {
      // tool_invocations stores the first; session_turn_parts stores the second for that
      // IDENTICAL call, and the third for the native one.
      expect(normalizeToolName('capability:read')).toBe('capability_read');
      expect(normalizeToolName('mcp__papercusp-su__capability_read')).toBe('capability_read');
      expect(normalizeToolName('  capability:READ  ')).toBe('capability_read');
      expect(normalizeToolName('Read')).toBe('read');
    });

    it('strips only the mcp server segment, not a tool name that merely contains __', () => {
      // A greedy strip would eat the tool name itself and fold unrelated tools together.
      expect(normalizeToolName('mcp__papercusp-su__work_items_get')).toBe('work_items_get');
      expect(normalizeToolName('not_mcp__thing')).toBe('not_mcp__thing');
    });
  });

  describe('the fix: a review performed with native tools is corroborated', () => {
    it('corroborates a native Read — the motivating case', () => {
      // Before the fix this exact ledger produced `uncorroborated` and REFUSED an honest
      // close, while an agent doing the same read via capability:read passed.
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('Read', 5)] });
      expect(v.verdict).toBe('corroborated');
    });

    it('corroborates Grep and Glob, and the mangled MCP spelling from the transcript', () => {
      for (const tool of ['Grep', 'Glob', 'mcp__papercusp-su__capability_read']) {
        expect(judgeSelfReview({ evidence: REVIEWED, ledger: [row(tool, 5)] }).verdict, tool)
          .toBe('corroborated');
      }
    });
  });

  describe('the control: widening did not dissolve the gate', () => {
    it('STILL refuses a claimed review with no read of the code in a VISIBLE ledger', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('coord:send', 4), row('Write', 5), row('work_items:get', 6)],
      });
      expect(v.verdict).toBe('uncorroborated');
    });

    it('does NOT let a shell command corroborate a review', () => {
      // Bash is the highest-volume native tool and is arbitrary — `git diff` is a review,
      // `npm test` is not. Admitting the class would manufacture evidence, which the module
      // docstring calls worse than having no gate at all.
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('Bash', 5)] });
      expect(v.verdict).toBe('uncorroborated');
      // ...and the refusal says so, so a Bash-only reviewer can comply with one call rather
      // than guessing why an honest review was rejected.
      expect(v.reason).toMatch(/shell commands/i);
    });

    it('does not treat a shell command as an EDIT either — the mirror defect', () => {
      // If Bash counted as an edit, any command after a review would read as a subsequent
      // mutation and turn honest closes into `stale-review`.
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('Read', 5), row('Bash', 9)],
      });
      expect(v.verdict).toBe('corroborated');
    });
  });

  describe('native EDITS move the clock a review must beat', () => {
    // The defect that widening reviews alone would have introduced: a native-editing agent
    // would have had NO recorded edits, so `lastEditAtMs` would be undefined and the
    // stale-review check could never fire for exactly the agents newly able to pass.
    it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])(
      'a native %s after the review is stale-review, not a pass',
      (editTool) => {
        const v = judgeSelfReview({
          evidence: REVIEWED,
          ledger: [row('Read', 5), row(editTool, 9)],
        });
        expect(v.verdict).toBe('stale-review');
      },
    );

    it('a native review AFTER a native edit is corroborated', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('Edit', 5), row('Read', 9)],
      });
      expect(v.verdict).toBe('corroborated');
    });

    it('lastEditAtMs sees native edits', () => {
      expect(lastEditAtMs([row('Edit', 1), row('Write', 5), row('Read', 9)])).toBe(T(5));
    });
  });

  describe('`unobservable` — a blind instrument must not refuse', () => {
    it('an EMPTY ledger is unobservable, not uncorroborated', () => {
      // Reaching work_items:complete requires having made at least one call in the window,
      // so zero rows is positive evidence of blindness — not evidence of inactivity.
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [] });
      expect(v.verdict).toBe('unobservable');
      expect(v.ledgerVisible).toBe(false);
      expect(v.reason).toMatch(/blind/i);
    });

    it('a VISIBLE ledger with no review is still uncorroborated — the discriminating pair', () => {
      // One row apart from the case above. If both returned the same verdict, the blindness
      // detector would just be a blanket amnesty.
      const v = judgeSelfReview({ evidence: REVIEWED, ledger: [row('coord:send', 1)] });
      expect(v.verdict).toBe('uncorroborated');
      expect(v.ledgerVisible).toBe(true);
    });

    it('still refuses not-claimed even when blind — that needs no ledger to establish', () => {
      const v = judgeSelfReview({ evidence: {}, ledger: [] });
      expect(v.verdict).toBe('not-claimed');
    });
  });

  describe('cross-source dedup — one MCP call lands in BOTH ledgers', () => {
    it('counts a single call once, however many ledgers recorded it', () => {
      // `reviewCalls` is recorded on the completion and read as a pilot measurement. Without
      // dedup it silently doubles for MCP-routing agents — measuring tool routing again,
      // which is the very confound this whole fix exists to remove.
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [
          { toolName: 'capability:read', invokedAtMs: T(5), source: 'invocations' },
          { toolName: 'mcp__papercusp-su__capability_read', invokedAtMs: T(5) + 240, source: 'turn-parts' },
        ],
      });
      expect(v.verdict).toBe('corroborated');
      expect(v.reviewCalls).toHaveLength(1);
      // The surviving row is the one carrying a real `status`.
      expect(v.reviewCalls[0]!.source).toBe('invocations');
    });

    it('does NOT collapse two genuinely distinct reads', () => {
      const v = judgeSelfReview({
        evidence: REVIEWED,
        ledger: [row('Read', 5), row('Read', 9)],
      });
      expect(v.reviewCalls).toHaveLength(2);
    });
  });
});

describe('selfReviewLedgerQuery — the second ledger (EI-21481919801123128)', () => {
  const q = selfReviewLedgerQuery({
    workspaceId: 'papercusp-workspace',
    coordOwnerId: 'su-abc',
    goalRef: 'WI-1',
    sinceMs: T(0),
  });

  it('reads session_turn_parts alongside tool_invocations', () => {
    expect(q.text).toMatch(/harness_shared\.tool_invocations/);
    expect(q.text).toMatch(/harness_shared\.session_turn_parts/);
    expect(q.text).toMatch(/UNION ALL/i);
  });

  it('pins the turn-parts leg to the CORPUS namespace, not the tenant workspace', () => {
    // session_turn_parts carries workspace_id='default' on every one of its rows; pinning it
    // to the item's workspace would return a clean zero — the same false-absence shape as
    // the harness_slug trap, one table over.
    expect(SESSION_TURN_PARTS_WORKSPACE_ID).toBe('default');
    expect(q.text).toMatch(/workspace_id = 'default'/);
    expect(q.text).not.toMatch(/session_turn_parts[\s\S]*workspace_id = \$1/);
  });

  it('scopes the turn-parts leg by owner and window', () => {
    expect(q.text).toMatch(/owner = \$2/);
    expect(q.text).toMatch(/ts >= \$4/);
  });

  it('keeps the part_kind literal the partial index depends on', () => {
    // Migration 968 indexes (owner, ts) WHERE part_kind = 'tool_use'. Relaxing this to an
    // IN (...) loses the index and puts a 2.4M-row seq scan on the completion hot path.
    expect(q.text).toMatch(/part_kind = 'tool_use'/);
  });

  it('tags each leg with its source so the rows can be told apart', () => {
    expect(q.text).toMatch(/'invocations' AS source/);
    expect(q.text).toMatch(/'turn-parts' AS source/);
  });
});
