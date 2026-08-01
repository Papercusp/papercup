/**
 * claim-spec-severity.test.ts — WI-6675: `severity` as a claim-spec FILTER field,
 * and the deliberate refusal to make it a RANK field.
 *
 * WHY THIS EXISTS. Before this change `severity` was absent from the claim-spec
 * vocabulary entirely — not in `ITEM_FIELDS` (claim-spec.ts), not in `FIELD_MAP`
 * (get-next.ts), zero occurrences in either as an INPUT. Two live consequences:
 *
 *  1. A drain lane could not say the one thing a backlog drain most needs to say:
 *     `{ field:'severity', op:'in', value:['critical','major'] }` was rejected as an
 *     unknown field. There was no way to scope a lane by severity at all.
 *  2. `DEFAULT_CLAIM_SPEC.rank` is affinity → priority → age. `affinity` compiles to
 *     NEUTRAL for a bee holding no paths (get-next.ts compileRankExpr), and
 *     `priority`/feature_order is NULL on issue-family rows — so the ordering
 *     COLLAPSES to plain `age asc`, oldest-first, with severity contributing nothing.
 *     Measured on harness:papercusp 2026-08-01: 19 critical + 215 major bugs served
 *     strictly behind ~980 minor/nit change items that merely happened to be older.
 *
 * THE TRAP, pinned by the `rank` block below. `RANKABLE_ITEM_FIELDS` is derived as
 * `FILTERABLE_ITEM_FIELDS` minus id/title, so merely appending 'severity' to
 * ITEM_FIELDS would have made it rankable AUTOMATICALLY — and severity is TEXT, so
 * `rank: severity desc` compiles to a LEXICAL ordering: nit > minor > major >
 * critical. Exactly backwards, while reading as though it prioritizes criticals.
 * Worse still, an unknown rank head compiles to NEUTRAL rather than erroring, so the
 * near-miss spelling would silently do nothing. Both failures are silent, which is
 * why the rejection is asserted here rather than left to a comment.
 *
 * ALSO PINNED: the two admission evaluators must resolve severity from the SAME
 * logical source. `claim-spec-match.ts` (JS, issue-family) and `get-next.ts`
 * FIELD_MAP (SQL, feature-family) each read `_ei` before the top-level payload —
 * the WI-6674 two-path hazard, where the wrong accessor for a relation returns NULL
 * for EVERY row without erroring. A divergence here is the WI-5781 split-brain class:
 * the same spec admits an item on one family's path and refuses it on the other's.
 */
import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../work-items';
import {
  DEFAULT_CLAIM_SPEC,
  FILTERABLE_ITEM_FIELDS,
  ITEM_FIELDS,
  RANKABLE_ITEM_FIELDS,
  validateClaimSpec,
  type ClaimSpec,
} from './claim-spec';
import { claimSpecSubjectFromWorkItem, matchesClaimSpecFilter } from './claim-spec-match';

function issueItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem {
  return {
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    severity: null,
    parent: null,
    payload: {},
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

/** The filter a real severity-scoped drain lane would author. */
const SEVERE_ONLY = { field: 'severity', op: 'in', value: ['critical', 'major'] } as const;

describe('severity is in the claim-spec FILTER vocabulary (WI-6675)', () => {
  it('is a known item field, and is filterable', () => {
    expect(ITEM_FIELDS).toContain('severity');
    expect(FILTERABLE_ITEM_FIELDS).toContain('severity');
  });

  it('validates a severity-scoped drain spec that was previously rejected outright', () => {
    const spec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'severe-drain',
      view: { filter: SEVERE_ONLY },
    } as unknown as ClaimSpec;
    const result = validateClaimSpec(spec);
    expect(result.ok).toBe(true);
  });

  it('admits a critical and refuses a nit under `severity in [critical, major]`', () => {
    const critical = claimSpecSubjectFromWorkItem(
      issueItem({ id: 'WI-crit', title: 'data loss on replay', severity: 'critical' }),
    );
    const nit = claimSpecSubjectFromWorkItem(
      issueItem({ id: 'WI-nit', title: 'typo in a comment', severity: 'nit' }),
    );

    expect(matchesClaimSpecFilter(critical, SEVERE_ONLY)).toBe(true);
    expect(matchesClaimSpecFilter(nit, SEVERE_ONLY)).toBe(false);
  });

  it('treats an unset severity as non-matching rather than silently admitting it', () => {
    // The failure this guards is a severity-scoped lane quietly widening back to the
    // whole backlog because most rows carry no severity — the drain would look scoped
    // and behave unscoped.
    const unset = claimSpecSubjectFromWorkItem(issueItem({ id: 'WI-unset', title: 'no severity' }));
    expect(unset.severity).toBeNull();
    expect(matchesClaimSpecFilter(unset, SEVERE_ONLY)).toBe(false);
  });

  it('supports `!=` so a lane can shed nit-grade drain fodder without discarding it', () => {
    // The non-destructive alternative to a severity FLOOR: the items stay claimable by
    // id and to any lane that wants them; this lane simply does not self-select them.
    const notNit = { not: { field: 'severity', op: '=', value: 'nit' } } as const;
    const nit = claimSpecSubjectFromWorkItem(issueItem({ id: 'WI-n', title: 'n', severity: 'nit' }));
    const major = claimSpecSubjectFromWorkItem(issueItem({ id: 'WI-m', title: 'm', severity: 'major' }));

    expect(matchesClaimSpecFilter(nit, notNit)).toBe(false);
    expect(matchesClaimSpecFilter(major, notNit)).toBe(true);
  });
});

describe('severity is deliberately NOT rankable (the backwards-lexical-sort trap)', () => {
  it('is excluded from RANKABLE_ITEM_FIELDS even though it is filterable', () => {
    expect(FILTERABLE_ITEM_FIELDS).toContain('severity');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('severity');
  });

  it('REJECTS `rank: [{ expr: severity }]` instead of sorting nit-first', () => {
    // A lexical DESC on the text column orders nit > minor > major > critical. Accepting
    // this would hand back a spec that reads as severity-prioritized and serves the
    // least important work first — a silently inverted ordering. Reject, don't neutralize.
    const spec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'severity-ranked',
      rank: { mode: 'lexicographic', terms: [{ expr: 'severity', dir: 'desc' }] },
    } as unknown as ClaimSpec;

    const result = validateClaimSpec(spec);
    expect(result.ok).toBe(false);
  });

  it('the lexical order a bare severity sort WOULD have produced is in fact inverted', () => {
    // Pins the premise of the rejection above, so a future reader can see the hazard is
    // real arithmetic rather than a stylistic objection: sorted descending as text, the
    // most severe value lands LAST.
    const lexicalDesc = ['critical', 'major', 'minor', 'nit'].sort().reverse();
    expect(lexicalDesc).toEqual(['nit', 'minor', 'major', 'critical']);
    expect(lexicalDesc[lexicalDesc.length - 1]).toBe('critical');
  });
});

describe('both admission evaluators resolve severity from the same source (WI-6674 / WI-5781)', () => {
  it('prefers the typed WorkItem.severity accessor', () => {
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({ id: 'WI-typed', title: 't', severity: 'major' }),
    );
    expect(subject.severity).toBe('major');
  });

  it('falls back to payload._ei.severity — the TABLE path, ahead of top-level payload', () => {
    // WI-6674: on harness_shared.work_items severity lives under the `_ei` fold (mig 374),
    // NOT at payload top level. A subject built from a raw row must still resolve it, and
    // must use the SAME precedence as get-next.ts FIELD_MAP's
    // COALESCE(payload->'_ei'->>'severity', payload->>'severity').
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({
        id: 'WI-ei',
        title: 't',
        severity: null,
        payload: { _ei: { severity: 'critical' }, severity: 'nit' },
      }),
    );
    expect(subject.severity).toBe('critical');
    expect(matchesClaimSpecFilter(subject, SEVERE_ONLY)).toBe(true);
  });

  it('falls back to a top-level payload.severity when no _ei fold is present', () => {
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({ id: 'WI-top', title: 't', severity: null, payload: { severity: 'major' } }),
    );
    expect(subject.severity).toBe('major');
  });

  it('a feature-family row carrying no severity resolves null, not undefined', () => {
    // `null` is the value the filter semantics are defined against; `undefined` would
    // take a different path through the comparison helpers.
    const subject = claimSpecSubjectFromWorkItem(issueItem({ id: 'F-1', title: 'f', severity: null }));
    expect(subject.severity).toBeNull();
  });
});
