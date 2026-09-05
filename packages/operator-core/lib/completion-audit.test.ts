/**
 * EI-10867 — the completion-integrity audit must key on EVIDENCE, not on the
 * completion gate's own bookkeeping column.
 *
 * The defect: `audit:'no-evidence'` keyed on `terminal_completion_ref IS NULL`. That
 * column is FORCED non-null by the completion gate (setWorkItemState/setIssueState
 * reject a terminal transition without a completionRef, and work_items:complete
 * auto-fills it from completion.summary) — so the audit was structurally incapable of
 * returning a row for anything closed through the sanctioned path. Live store when
 * found: 4,119 of 5,979 terminal rows with a completion ref had NO verification
 * evidence, and every one read as clean.
 *
 * These tests capture the SQL fragment each audit produces, so the regression that
 * matters — an audit silently keying on the wrong field — fails here, without needing
 * a live Postgres.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { blankPng, contentPng } from '@papercusp/image-blankness/testing';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  auditPredicateSql,
  auditPredicateSqlFor,
  auditStateScope,
  auditWhereSql,
  WORK_ITEM_AUDITS,
  WORKED_THEN_ABANDONED_STALE_DAYS,
  citedImagePaths,
  citesAssertionBearingRun,
  citesBrowserDriveEvidence,
  citesScreenshotArtifact,
  citesWebProbeEvidence,
  classifyTerminalOwner,
  completionAuthorityPredicateSql,
  COMPLETION_AUDITS,
  COMPLETION_AUTHORITY_FILTERS,
  hasIntermittentFailureRateEvidence,
  isBackedLiveDroveUiClaim,
  isBackedLiveServiceClaim,
  KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES,
  looksLikeIntermittentClassification,
  RECONCILER_SYSTEM_ACTOR,
  touchesLayoutBearingFiles,
  verifyLiveDroveUiArtifacts,
} from './completion-audit';
import { WORK_ITEM_COMPLETION_AUTHORITIES } from './work-item-completion-authority';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from './coord-lifecycle/records';
import {
  COMPLETION_CLAIM_RECHECK_KEY,
  COMPLETION_CLAIM_RECHECK_REGRESSED,
} from './completion-claim-recheck';

/**
 * A postgres.js-shaped tagged template that records the SQL text + bound params
 * instead of executing. `sql.unsafe(s)` interpolates raw (that is what the real tag
 * does for an identifier fragment).
 */
function recordingSql() {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = '';
    const params: unknown[] = [];
    strings.forEach((s, i) => {
      text += s;
      if (i < values.length) {
        const v = values[i] as { __raw?: string };
        if (v && typeof v === 'object' && typeof v.__raw === 'string') text += v.__raw;
        else {
          params.push(values[i]);
          text += `$${params.length}`;
        }
      }
    });
    return { text, params };
  };
  tag.unsafe = (raw: string) => ({ __raw: raw });
  return tag as unknown as Parameters<typeof auditPredicateSql>[0] & {
    unsafe: (s: string) => unknown;
  };
}

describe("live-service completion evidence (EI-20096763429995249)", () => {
  it.each([
    'MainPID=4242',
    'NRestarts=0',
    'ActiveState=active',
    'HTTP/1.1 200',
    'GET http://localhost:3170/api/health -> 200',
  ])('accepts a named service plus falsifiable runtime observation: %s', (observation) => {
    expect(
      isBackedLiveServiceClaim({
        verifiedHow: 'live-service',
        testsRun: 'dev:restart followed by systemctl show papercup-staging-api.service',
        testResult: observation,
      }),
    ).toBe(true);
  });

  it('accepts a non-systemd process when it is concretely named', () => {
    expect(
      isBackedLiveServiceClaim({
        verifiedHow: 'live-service',
        testsRun: 'restarted process: papercusp-inference-gateway',
        testResult: 'GET http://localhost:8788/health returned 204',
      }),
    ).toBe(true);
  });

  it('rejects a unit/integration test run with no live runtime observation', () => {
    expect(
      isBackedLiveServiceClaim({
        verifiedHow: 'live-service',
        testsRun: 'npm run test:file -- bundle-host.test.ts',
        testResult: '18/18 tests passed',
      }),
    ).toBe(false);
  });

  it('rejects runtime-looking values that name no concrete service or process', () => {
    expect(
      isBackedLiveServiceClaim({
        verifiedHow: 'live-service',
        testsRun: 'restarted it and checked health',
        testResult: 'ActiveState=active; MainPID=4242; HTTP 200',
      }),
    ).toBe(false);
  });

  it('rejects a named service with only a subjective success claim', () => {
    expect(
      isBackedLiveServiceClaim({
        verifiedHow: 'live-service',
        testsRun: 'restarted papercup-staging-api.service',
        testResult: 'came up clean and looked healthy',
      }),
    ).toBe(false);
  });

  it('does not launder summary prose into runtime evidence', () => {
    expect(
      isBackedLiveServiceClaim({
        verifiedHow: 'live-service',
        summary: 'papercup-staging-api.service had ActiveState=active and MainPID=4242',
      }),
    ).toBe(false);
  });

  it.each([undefined, 'unit', 'integration', 'live-drove-ui', 'manual', 'already-passing'])(
    'leaves other verifiedHow labels untouched: %s',
    (verifiedHow) => {
      expect(isBackedLiveServiceClaim(verifiedHow ? { verifiedHow } : undefined)).toBe(true);
    },
  );
});

const frag = (x: unknown) => x as unknown as { text: string; params: unknown[] };

describe('completion-audit predicates (EI-10867)', () => {
  // P-006/D-003: the 'no-evidence' bareness audit was DELETED — P-004 made structured
  // evidence required at WRITE time (an evidence-less close lands authority:'proposed'),
  // so there is no longer a wrong value for a later sweep to re-verify. This asserts the
  // deletion stuck: re-adding the bucket should have to re-argue D-003, not slip back in.
  it("'no-evidence' is GONE from the audit vocabulary (P-006/D-003)", () => {
    expect(COMPLETION_AUDITS).not.toContain('no-evidence');
  });

  it("'no-completion-record' preserves the OLD check as its own, separately-named audit", () => {
    const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record'));
    expect(f.text).toContain('terminal_completion_ref IS NULL');
    expect(f.params).not.toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);
  });

  it('the aliased no-completion-record form also matches its unaliased twin', () => {
    const plain = frag(auditPredicateSql(recordingSql(), 'no-completion-record'));
    const aliased = frag(auditPredicateSqlFor(recordingSql(), 'no-completion-record', 'ei'));
    expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
  });

  // EI-18676290701611705 — the ACTIONABLE subset of no-completion-record: excludes the
  // small, audited set of skipCompletionGate system identities (a NULL ref there is
  // EXPECTED, not a bug), so a hit here means an undiscovered write path bypassed the
  // completion-integrity gate.
  describe("'no-completion-record-suspicious' (EI-18676290701611705)", () => {
    it('still requires terminal_completion_ref IS NULL (a strict subset of no-completion-record)', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record-suspicious'));
      expect(f.text).toContain('terminal_completion_ref IS NULL');
    });

    it('excludes rows whose terminal_owner is one of the known system-bypass identities', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record-suspicious'));
      expect(f.text).toContain('terminal_owner');
      expect(f.text).toContain('NOT');
      expect(f.params).toEqual([KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES]);
    });

    it('the known-identity list carries every documented skipCompletionGate `by` value (grep-verified against the 5 call sites)', () => {
      expect(KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES).toEqual(
        expect.arrayContaining([
          'watchdog-auto-close',
          'improvement-hygiene',
          'watchdog-orphan-superseded',
          'hive-bee-exit',
          'autonomy-revert',
        ]),
      );
    });

    it('a NULL terminal_owner is ALSO suspicious (no completion AND no credited actor at all)', () => {
      // The predicate must not accidentally treat "nobody" as "a recognized system actor" —
      // NULL is neither IN nor NOT IN a value list under SQL's three-valued logic, so this
      // must be handled explicitly (the `owner IS NULL OR NOT (owner = ANY(...))` shape).
      const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record-suspicious'));
      expect(f.text).toContain('terminal_owner IS NULL');
    });

    it('the aliased form matches its unaliased twin', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'no-completion-record-suspicious'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'no-completion-record-suspicious', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    });

    // EI-18821460229478708: a federated (origin='remote') row's bare shape is not
    // evidence about THIS install's write paths — it reflects federation transport, or
    // the ORIGIN pot's own completion integrity. Scoping to origin='local' is what makes
    // the bucket's own "structurally impossible for a gated caller" claim true again;
    // measured live, 82% of the pre-fix bucket was exactly this false signal.
    it("is scoped to origin = 'local' — a federated row never counts as suspicious here", () => {
      const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record-suspicious'));
      expect(f.text).toContain("origin = 'local'");
    });
  });

  // EI-18821460229478708: the non-actionable federated sibling of `-suspicious` — same
  // bare shape, but origin='remote'. Keeps the count VISIBLE (never silently dropped)
  // while making it un-actionable against this install.
  describe("'no-completion-record-federated' (EI-18821460229478708)", () => {
    it("requires the SAME bare shape as -suspicious, but origin = 'remote'", () => {
      const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record-federated'));
      expect(f.text).toContain('terminal_completion_ref IS NULL');
      expect(f.text).toContain('authority IS NULL');
      expect(f.text).toContain("origin = 'remote'");
      expect(f.params).toEqual([KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES]);
    });

    it('is disjoint from no-completion-record-suspicious (local vs remote are mutually exclusive)', () => {
      const suspicious = frag(auditPredicateSql(recordingSql(), 'no-completion-record-suspicious'));
      const federated = frag(auditPredicateSql(recordingSql(), 'no-completion-record-federated'));
      expect(suspicious.text).toContain("origin = 'local'");
      expect(federated.text).toContain("origin = 'remote'");
    });

    it('the aliased form matches its unaliased twin', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'no-completion-record-federated'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'no-completion-record-federated', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    });
  });

  /**
   * EI-18677799334390930, rescued by D-012. A plan-item-reconcile close mirrors an
   * ADJACENT plan item's status onto a work-item and is never independently verified.
   * This rule used to ride INSIDE the deleted `no-evidence` branch; P-006 promoted it to
   * its own bucket precisely so deleting that branch could not drop it silently.
   */
  describe("'reconciler-sourced' (EI-18677799334390930, rescued by D-012)", () => {
    it('keys on terminal_owner = RECONCILER_SYSTEM_ACTOR', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'reconciler-sourced'));
      expect(f.text).toContain('terminal_owner');
      expect(f.params).toContain(RECONCILER_SYSTEM_ACTOR);
    });

    /**
     * The load-bearing assertion. Keyed on the ACTOR, never on an evidence key — so
     * adding a well-meaning `_completionEvidence` stamp to the reconcile write path
     * cannot make these rows vanish from the audit.
     */
    it('does NOT depend on the evidence key (an evidence stamp cannot defeat it)', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'reconciler-sourced'));
      expect(f.params).not.toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);
    });

    it('the aliased form matches the unaliased twin (modulo alias)', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'reconciler-sourced'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'reconciler-sourced', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    });
  });

  /**
   * WI-2142447 — the one bucket whose finding is NOT decidable from the row. Re-evaluating
   * an AST claim is not expressible as a WHERE clause, and the finding is a TRANSITION that
   * even a perfect view of the current tree could not distinguish from a claim that was
   * already false at close. So the sweep judges in process and STAMPS the row, and this
   * predicate selects that stamp.
   */
  describe("'claim-since-falsified' selects the sweep's stamp (WI-2142447)", () => {
    it('reads the recheck key, not the close evidence the sweep must never mutate', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'claim-since-falsified'));
      expect(f.text).toContain(COMPLETION_CLAIM_RECHECK_KEY);
      expect(f.text).toContain("->>'verdict'");
      expect(f.text).not.toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);
    });

    it('matches the SAME constant the sweep writes — not a re-typed string literal', () => {
      // A predicate keyed on a value nothing writes returns zero rows forever, with no
      // error. This is the pairing that stops the read and the write drifting apart.
      const f = frag(auditPredicateSql(recordingSql(), 'claim-since-falsified'));
      expect(f.params).toEqual([COMPLETION_CLAIM_RECHECK_REGRESSED]);
    });

    it('the aliased form matches the unaliased twin (modulo alias)', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'claim-since-falsified'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'claim-since-falsified', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
      expect(aliased.params).toEqual(plain.params);
    });

    it('is a TERMINAL-scope bucket — an open row has no close whose claims could go stale', () => {
      expect(auditStateScope('claim-since-falsified')).toBe('terminal');
    });
  });

  it('every declared audit produces a predicate (no silently-unhandled enum member)', () => {
    for (const a of WORK_ITEM_AUDITS) {
      const f = frag(auditPredicateSql(recordingSql(), a));
      expect(f.text.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * EI-19320339017813143 — the FIRST audit bucket defined over OPEN rows, and the
   * state-scope plumbing it forced.
   *
   * Before this bucket the scope was not part of an audit's definition: eleven call
   * sites in work-items.ts and issues-engineer.ts each re-typed a literal
   * `state = ANY(<TERMINAL>) AND <predicate>`. That is invisible while every bucket
   * shares one scope and catastrophic the moment one does not — a terminal-only clause
   * ANDed onto an open-only predicate returns ZERO ROWS, forever, with no error. An
   * audit reporting "nothing to see" is indistinguishable from an audit that is clean,
   * which is the precise confusion EI-10867 (this file's own subject) was filed for.
   *
   * So these tests guard the SCOPE, not just the predicate text.
   */
  describe("'worked-then-abandoned' — the open-row bucket (EI-19320339017813143)", () => {
    /** Like `recordingSql`, but INLINES a nested fragment instead of binding it as a
     *  parameter — `auditWhereSql` composes fragments, so the composed text is the
     *  thing under test and must not collapse to a `$n`. */
    function composingSql() {
      const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
        let text = '';
        const params: unknown[] = [];
        strings.forEach((s, i) => {
          text += s;
          if (i >= values.length) return;
          const v = values[i] as { __raw?: string; text?: string; params?: unknown[] };
          if (v && typeof v === 'object' && typeof v.__raw === 'string') text += v.__raw;
          else if (v && typeof v === 'object' && typeof v.text === 'string') {
            text += v.text;
            params.push(...(v.params ?? []));
          } else {
            params.push(values[i]);
            text += `$${params.length}`;
          }
        });
        return { text, params };
      };
      tag.unsafe = (raw: string) => ({ __raw: raw });
      return tag as unknown as Parameters<typeof auditWhereSql>[0] & { unsafe: (s: string) => unknown };
    }

    const issueOpts = { stateColumn: 'state', terminalStates: ['resolved', 'closed', 'deprecated', 'done'] };

    it('is classified as an OPEN-scope bucket, and every completion audit stays TERMINAL', () => {
      expect(auditStateScope('worked-then-abandoned')).toBe('open');
      for (const a of COMPLETION_AUDITS) expect(auditStateScope(a)).toBe('terminal');
    });

    it('keys on the release stamps the release path writes — not on any completion column', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'worked-then-abandoned'));
      expect(f.text).toContain('last_released_by IS NOT NULL');
      expect(f.text).toContain('last_released_at <');
      // It must NOT smuggle in a completion-shaped test: this bucket is about the
      // LIFECYCLE, and an open row has no completion columns populated by construction.
      expect(f.text).not.toContain('terminal_completion_ref');
      expect(f.text).not.toContain('authority');
      expect(f.params).toContain(WORKED_THEN_ABANDONED_STALE_DAYS);
    });

    it('the aliased form matches its unaliased twin', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'worked-then-abandoned'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'worked-then-abandoned', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    });

    /**
     * THE LOAD-BEARING ASSERTION. If a future edit reverts the scope to the old
     * hard-coded terminal conjunct, this bucket silently matches nothing — so assert the
     * membership test is NEGATED, not merely that some SQL was produced.
     */
    it('scopes to NON-terminal rows — the terminal membership test is negated', () => {
      const f = frag(auditWhereSql(composingSql(), 'worked-then-abandoned', issueOpts));
      expect(f.text).toContain('NOT (state = ANY(');
      // The predicate really did compose in (not collapse to a bound parameter).
      expect(f.text).toContain('last_released_by IS NOT NULL');
      // A bare, UN-negated terminal conjunct is the regression. Strip the legitimate
      // negated occurrences first — asserting on the raw text cannot distinguish them,
      // since `NOT (state = ANY(` contains `(state = ANY(` verbatim.
      expect(f.text.replace(/NOT \(state = ANY\(/g, '')).not.toContain('state = ANY(');
    });

    it('treats a NULL state as non-terminal rather than dropping the row', () => {
      const f = frag(auditWhereSql(composingSql(), 'worked-then-abandoned', issueOpts));
      // NOT(NULL) is NULL, which would silently exclude a malformed row — exactly the
      // kind an audit should surface. The IS NULL arm is what keeps it visible.
      expect(f.text).toContain('state IS NULL OR');
    });

    /**
     * ⚠ THE FALSE-POSITIVE GUARD, and the most expensive thing this bucket got wrong
     * before it shipped.
     *
     * `ISSUE_TERMINAL_STATES` is resolved/closed/deprecated/done and omits `dropped`.
     * Negating the CALLER's family list therefore reclassified every dropped issue as
     * open: measured live 2026-08-30, 645 issue-family hits of which 263 (41%, the
     * single largest category) were dropped — deliberately closed work presented to a
     * reader as abandoned. An open scope must negate the CROSS-FAMILY union, because a
     * state terminal in either family means the row is closed whichever view read it.
     */
    it('an OPEN scope negates the cross-family union, so `dropped` is never treated as open', () => {
      // The caller passes the NARROW issue list, exactly as issues-engineer.ts does.
      const f = frag(auditWhereSql(composingSql(), 'worked-then-abandoned', issueOpts));
      const closed = f.params.find((p): p is string[] => Array.isArray(p)) ?? [];
      expect(closed).toContain('dropped'); // absent from issueOpts.terminalStates
      expect(closed).toContain('passed'); // likewise feature-only
      for (const s of issueOpts.terminalStates) expect(closed).toContain(s);
    });

    it('a TERMINAL scope still honours the caller family list (existing buckets unchanged)', () => {
      const f = frag(auditWhereSql(composingSql(), 'reconciler-sourced', issueOpts));
      const states = f.params.find((p): p is string[] => Array.isArray(p)) ?? [];
      expect(states).toEqual(issueOpts.terminalStates);
      expect(states).not.toContain('dropped');
    });

    it('a TERMINAL bucket still gets the positive membership test through the same helper', () => {
      const f = frag(auditWhereSql(composingSql(), 'reconciler-sourced', issueOpts));
      expect(f.text).toMatch(/\(\s*state = ANY\(/);
      expect(f.text).not.toContain('NOT (state = ANY(');
      expect(f.text).toContain('terminal_owner =');
    });

    it('applies the caller dialect: alias and state column are not hard-coded', () => {
      const aliased = frag(
        auditWhereSql(composingSql(), 'worked-then-abandoned', { ...issueOpts, alias: 'ei' }),
      );
      expect(aliased.text).toContain('ei.last_released_by');
      expect(aliased.text).toContain('NOT (ei.state = ANY(');

      const feature = frag(
        auditWhereSql(composingSql(), 'worked-then-abandoned', {
          stateColumn: 'status',
          terminalStates: ['done', 'passed', 'dropped', 'deprecated'],
        }),
      );
      expect(feature.text).toContain('NOT (status = ANY(');
    });
  });

  // WI-5891 — the P-014/WI-5874 audit follow-up: a layout-bearing filesChanged closed
  // with verifiedHow 'unit'/absent never had its pixels looked at.
  describe("'geometry-unverified' (WI-5891)", () => {
    it('checks filesChanged for a layout-bearing extension via jsonb_array_elements_text', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'geometry-unverified'));
      expect(f.text).toContain('jsonb_array_elements_text');
      expect(f.text).toContain('filesChanged');
      expect(f.text).toContain('css|tsx|jsx');
    });

    it('checks verifiedHow is NOT one of the genuinely-verified values', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'geometry-unverified'));
      expect(f.text).toContain('verifiedHow');
      expect(f.text).toContain('NOT');
      expect(f.params).toContainEqual(['integration', 'live-drove-ui', 'manual', 'already-passing']);
    });

    it('the aliased form matches its unaliased twin', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'geometry-unverified'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'geometry-unverified', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    });
  });

  // EI-18716652701919665 — evidence-SHAPE mismatch for a title classified intermittent/flaky:
  // N consecutive passes is a sample, not a demonstration, unless a failure rate or root
  // cause is stated.
  describe("'intermittent-underevidenced' (EI-18716652701919665)", () => {
    it('checks the title for an intermittent/flaky/racy classification', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'intermittent-underevidenced'));
      expect(f.text).toContain('title');
      expect(f.text).toContain('~*');
      // The regex pattern itself is a BOUND parameter (not spliced into the SQL text), so
      // its content is asserted against params, not text.
      expect(f.params).toContain(
        '\\y(intermittent(ly)?|flaky|flake|racy|race condition|nondeterministic|non-deterministic)\\y',
      );
    });

    it('requires structured evidence to be PRESENT (testResult/testsRun non-NULL) before flagging', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'intermittent-underevidenced'));
      expect(f.text).toContain('testResult');
      expect(f.text).toContain('testsRun');
      expect(f.text).toContain('IS NOT NULL');
    });

    it('checks the evidence text is NOT a failure-rate / root-cause statement', () => {
      const f = frag(auditPredicateSql(recordingSql(), 'intermittent-underevidenced'));
      expect(f.text).toContain('AND NOT (');
      expect(f.params).toContain(
        '(\\d+(\\.\\d+)?\\s*%|failure rate|flake rate|flakiness|historically|root cause|regression test|deterministic repro|observed.{0,40}fail)',
      );
    });

    it('the aliased form matches its unaliased twin', () => {
      const plain = frag(auditPredicateSql(recordingSql(), 'intermittent-underevidenced'));
      const aliased = frag(auditPredicateSqlFor(recordingSql(), 'intermittent-underevidenced', 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    });
  });
});

// WI-5891 — pure heuristics feeding both the `geometry-unverified` audit bucket and the
// `isBackedLiveDroveUiClaim` completion-boundary gate.
describe('touchesLayoutBearingFiles (WI-5891)', () => {
  it('flags a .css file', () => {
    expect(touchesLayoutBearingFiles(['apps/operator/app/globals.css'])).toBe(true);
  });
  it('flags a .tsx file', () => {
    expect(touchesLayoutBearingFiles(['apps/operator/app/adv/hud/HudView.tsx'])).toBe(true);
  });
  it('flags a .jsx file', () => {
    expect(touchesLayoutBearingFiles(['some/Component.jsx'])).toBe(true);
  });
  it('does NOT flag a non-layout file (e.g. a .ts backend module)', () => {
    expect(touchesLayoutBearingFiles(['packages/operator-core/lib/work-items.ts'])).toBe(false);
  });
  it('does NOT flag an empty or missing list', () => {
    expect(touchesLayoutBearingFiles([])).toBe(false);
    expect(touchesLayoutBearingFiles(null)).toBe(false);
    expect(touchesLayoutBearingFiles(undefined)).toBe(false);
  });
});

describe('citesScreenshotArtifact (WI-5891)', () => {
  it('flags an image artifact path', () => {
    expect(citesScreenshotArtifact('saved to /tmp/hud-card-fix.png')).toBe(true);
  });
  it('flags the canonical vmctl PPM artifact path', () => {
    expect(citesScreenshotArtifact('saved to /home/dev/run/verify/screen.ppm')).toBe(true);
  });
  it('flags a tauri-agent-tools capture/screenshot/check invocation', () => {
    expect(citesScreenshotArtifact('ran tauri-agent-tools capture --out /tmp/shot.png')).toBe(true);
    expect(citesScreenshotArtifact('tauri-agent-tools check hud-card-flex')).toBe(true);
  });
  it('does NOT flag bare prose with no artifact', () => {
    expect(citesScreenshotArtifact('drove the UI and it looked fine')).toBe(false);
    expect(citesScreenshotArtifact('2 vitest runs green')).toBe(false);
    expect(citesScreenshotArtifact(null)).toBe(false);
    expect(citesScreenshotArtifact(undefined)).toBe(false);
    expect(citesScreenshotArtifact('')).toBe(false);
  });
});

// WI-5891 — the completion-boundary hard gate itself: the exact WI-5874/P-001 shape
// (verifiedHow:'live-drove-ui' citing only vitest runs) must fail this check.
/**
 * EI-20411096292493737 — a real Playwright drive of a deployed WEB app had no truthful
 * label, because the accepted-artifact set was Tauri-shaped. The filed harm is NOT the
 * rejection: it is that `'unit'`/`'integration'`/`'manual'` were all FALSE for that
 * close, so the cheapest way past the gate was to write a wrong `verifiedHow` into the
 * ledger the gate exists to protect. Mislabels are silent; rejections are not.
 *
 * The negative cases below are the load-bearing half — they pin that this is a widening
 * along the ORIGINAL falsifiability principle (an asserting run that could have exited
 * non-zero), not a hole.
 */
describe('citesBrowserDriveEvidence — web live-drive (EI-20411096292493737)', () => {
  it('ACCEPTS a recorded playwright invocation against a live http(s) target', () => {
    expect(
      citesBrowserDriveEvidence({
        verifiedHow: 'live-drove-ui',
        testsRun: 'npx playwright test e2e/dockview.spec.ts --reporter=line',
        testResult: '13/13 checks green against https://sidestage.buyrestart.com',
      }),
    ).toBe(true);
  });

  it('ACCEPTS a verdict check naming the URL it drove', () => {
    expect(
      citesBrowserDriveEvidence({
        verifiedHow: 'live-drove-ui',
        summary: 'verdict check https://example.com/pricing — sash drag asserted, exit 0',
      }),
    ).toBe(true);
  });

  it('REJECTS prose that merely NAMES the tool, even with a URL present', () => {
    // The exact shape a wider window would have wrongly accepted. `playwright` is an
    // ordinary word in completion narrative; the binary name alone proves nothing ran.
    expect(
      citesBrowserDriveEvidence({
        verifiedHow: 'live-drove-ui',
        summary: 'we use Playwright for e2e coverage of https://example.com these days',
      }),
    ).toBe(false);
    expect(
      citesBrowserDriveEvidence({
        verifiedHow: 'live-drove-ui',
        summary: 'a 13-check Playwright suite exercises https://example.com',
      }),
    ).toBe(false);
  });

  it('REJECTS a real driver invocation with NO live target — a local fixture run is not a live drive', () => {
    expect(
      citesBrowserDriveEvidence({
        verifiedHow: 'live-drove-ui',
        testsRun: 'npx playwright test e2e/dockview.spec.ts',
        testResult: '13/13 passed',
      }),
    ).toBe(false);
  });

  it('REJECTS a bare URL with no driver invocation (that is the web-probe path, which needs a status)', () => {
    expect(
      citesBrowserDriveEvidence({
        verifiedHow: 'live-drove-ui',
        summary: 'looked at https://example.com and it seemed fine',
      }),
    ).toBe(false);
  });
});

describe('isBackedLiveDroveUiClaim (WI-5891)', () => {
  it('is BACKED by a recorded browser-driver run against a live URL (EI-20411096292493737)', () => {
    expect(
      isBackedLiveDroveUiClaim({
        verifiedHow: 'live-drove-ui',
        testsRun: 'npx playwright test e2e/dockview.spec.ts',
        testResult: '13/13 green against https://sidestage.buyrestart.com',
      }),
    ).toBe(true);
  });

  it('stays UNBACKED when the driver is only named in prose (EI-20411096292493737)', () => {
    expect(
      isBackedLiveDroveUiClaim({
        verifiedHow: 'live-drove-ui',
        summary: 'a 13-check Playwright suite covers https://sidestage.buyrestart.com',
      }),
    ).toBe(false);
  });

  it("the WI-5874/P-001 shape — verifiedHow:'live-drove-ui' backed by nothing but vitest runs — is UNBACKED", () => {
    expect(
      isBackedLiveDroveUiClaim({
        verifiedHow: 'live-drove-ui',
        testsRun: 'npm run test:file -- hud.test.ts',
        testResult: '2/2 vitest runs green',
      }),
    ).toBe(false);
  });

  it("is UNBACKED when verifiedHow:'live-drove-ui' cites nothing at all", () => {
    expect(isBackedLiveDroveUiClaim({ verifiedHow: 'live-drove-ui' })).toBe(false);
  });

  it('is BACKED when testResult cites a screenshot artifact path', () => {
    expect(
      isBackedLiveDroveUiClaim({
        verifiedHow: 'live-drove-ui',
        testResult: 'confirmed via tauri-agent-tools capture, saved /tmp/hud-fix.png',
      }),
    ).toBe(true);
  });

  it('is BACKED when summary cites a falsifiable check artifact', () => {
    expect(
      isBackedLiveDroveUiClaim({
        verifiedHow: 'live-drove-ui',
        summary: 'LIVE EVIDENCE — /tmp/wi37549-check.json via tauri-agent-tools check --pid 255538 --json',
      }),
    ).toBe(true);
  });

  it('is BACKED when filesChanged itself carries the screenshot path', () => {
    expect(
      isBackedLiveDroveUiClaim({
        verifiedHow: 'live-drove-ui',
        filesChanged: ['apps/operator/app/globals.css', '/tmp/verification/hud-fix.png'],
      }),
    ).toBe(true);
  });

  it('is a no-op (returns true / nothing to enforce) for every OTHER verifiedHow, including absent', () => {
    expect(isBackedLiveDroveUiClaim({ verifiedHow: 'unit' })).toBe(true);
    expect(isBackedLiveDroveUiClaim({ verifiedHow: 'manual' })).toBe(true);
    expect(isBackedLiveDroveUiClaim({ verifiedHow: 'integration' })).toBe(true);
    expect(isBackedLiveDroveUiClaim({ verifiedHow: 'already-passing' })).toBe(true);
    expect(isBackedLiveDroveUiClaim({})).toBe(true);
    expect(isBackedLiveDroveUiClaim(null)).toBe(true);
    expect(isBackedLiveDroveUiClaim(undefined)).toBe(true);
  });
});

// EI-18797014705631713 — the artifact half. isBackedLiveDroveUiClaim above proves a
// path was WRITTEN DOWN; these prove it was real. The gap between the two is the whole
// bug: a capture of a window that never painted writes a valid PNG and exits 0, so the
// most convincing-looking evidence type was the easiest to produce by accident.
describe('verifyLiveDroveUiArtifacts (EI-18797014705631713)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'completion-audit-artifacts-'));
    await writeFile(join(dir, 'blank.png'), blankPng());
    await writeFile(join(dir, 'real.png'), contentPng());
    await writeFile(join(dir, 'empty.png'), Buffer.alloc(0));
    await writeFile(join(dir, 'shot.jpg'), Buffer.from('not really a jpeg, but on disk'));
    await writeFile(join(dir, 'screen.ppm'), Buffer.from('P6\n2 2\n255\n\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('REJECTS the laundering case: a cited screenshot that is on disk but blank', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testsRun: `tauri-agent-tools screenshot --pid 1234 --output ${dir}/blank.png`,
      testResult: 'captured the HUD with the modal open',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('BLANK');
    // The message must name the file — an agent has to know WHICH artifact failed.
    expect(verdict.reason).toContain('blank.png');
    expect(verdict.artifacts[0].status).toBe('blank');
  });

  it('REJECTS the WI-5874/P-001 case: a cited path with no file behind it', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testResult: `verified live, see ${dir}/never-taken.png`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('does not exist');
    expect(verdict.artifacts[0].status).toBe('missing');
  });

  it('treats a 0-byte capture as blank, not as an unreadable file', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      filesChanged: [join(dir, 'empty.png')],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('0-byte');
  });

  it('ACCEPTS a cited screenshot that actually rendered', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testsRun: `tauri-agent-tools screenshot --output ${dir}/real.png`,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe('image');
    expect(verdict.artifacts[0].status).toBe('content');
  });

  it('ACCEPTS the canonical vmctl PPM screenshot artifact', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testResult: `vmctl verified the desktop; screenshot at ${dir}/screen.ppm`,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe('image');
    expect(verdict.artifacts[0].cited).toBe(join(dir, 'screen.ppm'));
    expect(verdict.artifacts[0].status).not.toBe('missing');
  });

  it('ACCEPTS a falsifiable `check` run with no image at all — the path the rejection recommends', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testsRun: 'tauri-agent-tools check --pid 1234 --eval "document.querySelectorAll(\'[data-col]\').length" --json',
      testResult: '{"passed":true}, exit 0',
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe('assertion');
    // A `check` asserts something and can fail, so it needs nothing on disk.
    expect(verdict.artifacts).toHaveLength(0);
  });

  it('accepts when ANY cited artifact is real, even alongside a blank one', async () => {
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testsRun: `first attempt ${dir}/blank.png, retried after fixing GL: ${dir}/real.png`,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.artifacts.map((a) => a.status).sort()).toEqual(['blank', 'content']);
  });

  // The direction of failure is the whole safety argument: a wrong rejection blocks a
  // close on work that was genuinely done, so anything less than a confident negative
  // must pass. Each case below is a way the check could be WRONG, not merely unsure.
  describe('fails open wherever the evidence is only unclear', () => {
    it('passes a format it cannot decode rather than guessing', async () => {
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        filesChanged: [join(dir, 'shot.jpg')],
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.artifacts[0].status).toBe('unjudged');
    });

    it('passes a bare filename with no directory — its location is unknowable, not absent', async () => {
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        testResult: 'saved as hud-verified.png',
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.artifacts[0].status).toBe('unresolvable');
    });

    it('ignores a URL rather than resolving it to a local path that was never there', async () => {
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        testsRun: `drove the UI, reference shot at https://example.com/expected.png and ${dir}/real.png`,
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.artifacts.map((a) => a.cited)).toEqual([join(dir, 'real.png')]);
    });

    it('expands ~ before deciding a cited artifact is missing', async () => {
      // Resolving `~/x.png` literally would stat './~/x.png' and condemn a path that
      // was never the one cited.
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        testResult: 'saved ~/definitely-not-here-8f3a.png',
      });
      expect(verdict.artifacts[0].resolved).toBe(join(homedir(), 'definitely-not-here-8f3a.png'));
    });

    it('never applies to any other verifiedHow, and never to a bare completion', async () => {
      for (const verifiedHow of ['unit', 'integration', 'manual', 'already-passing'] as const) {
        const verdict = await verifyLiveDroveUiArtifacts({ verifiedHow, filesChanged: [join(dir, 'blank.png')] });
        expect(verdict).toMatchObject({ ok: true, basis: 'not-applicable' });
      }
      expect(await verifyLiveDroveUiArtifacts(null)).toMatchObject({ ok: true });
      expect(await verifyLiveDroveUiArtifacts(undefined)).toMatchObject({ ok: true });
      expect(await verifyLiveDroveUiArtifacts({})).toMatchObject({ ok: true });
    });
  });

  it('REJECTS a `screenshot` run cited with no output path — the words alone satisfy the text gate', async () => {
    // The text check passes on the mere phrase "tauri-agent-tools screenshot", so this
    // reaches the artifact check with nothing to inspect and nothing that could have failed.
    const verdict = await verifyLiveDroveUiArtifacts({
      verifiedHow: 'live-drove-ui',
      testsRun: 'tauri-agent-tools screenshot --pid 1234',
      testResult: 'looked right',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.basis).toBe('none');
    expect(verdict.reason).toContain('no image path');
  });

  it('resolves a relative citation against the given cwd', async () => {
    const verdict = await verifyLiveDroveUiArtifacts(
      { verifiedHow: 'live-drove-ui', testResult: 'see ./blank.png' },
      { cwd: dir },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.artifacts[0].resolved).toBe(join(dir, 'blank.png'));
  });

  // EI-18822892068318552 — the false NEGATIVE, which is the costlier direction for this
  // gate than the false positive it was built to stop. Repo-relative is how every path in
  // this repo is written, but the operator's cwd is not the repo root, so a real capture
  // was reported as non-existent. The trap is what that teaches: the cheapest way to clear
  // the error is to downgrade verifiedHow to 'manual' — the exact under-claiming the gate
  // exists to prevent.
  describe('resolves a REPO-RELATIVE citation, not only a cwd-relative one', () => {
    let repo: string;
    let nested: string;
    const savedRepoRootEnv = process.env.PAPERCUSP_REPO_ROOT;

    beforeAll(async () => {
      repo = await mkdtemp(join(tmpdir(), 'completion-audit-repo-'));
      // A VALID .git entry — a dir with HEAD. hasValidGitEntry deliberately refuses a
      // stray empty `.git` (WI-4722), so an empty mkdir here would not mark a root.
      await mkdir(join(repo, '.git'), { recursive: true });
      await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
      await mkdir(join(repo, '.papercusp-artifacts'), { recursive: true });
      await writeFile(join(repo, '.papercusp-artifacts', 'wi6443-experiments.png'), contentPng());
      // Where the operator actually runs from: deeper in the tree, so the citation does
      // NOT resolve against it.
      nested = join(repo, 'apps', 'operator');
      await mkdir(nested, { recursive: true });
    });

    afterAll(async () => {
      if (savedRepoRootEnv === undefined) delete process.env.PAPERCUSP_REPO_ROOT;
      else process.env.PAPERCUSP_REPO_ROOT = savedRepoRootEnv;
      await rm(repo, { recursive: true, force: true });
    });

    it('ACCEPTS the real file when cwd is deeper than the repo root (the reported case)', async () => {
      delete process.env.PAPERCUSP_REPO_ROOT; // proves the git-root walk carries it alone
      const verdict = await verifyLiveDroveUiArtifacts(
        {
          verifiedHow: 'live-drove-ui',
          testResult: 'drove the Experiments view, capture at .papercusp-artifacts/wi6443-experiments.png',
        },
        { cwd: nested },
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.artifacts[0].status).toBe('content');
      expect(verdict.artifacts[0].resolved).toBe(join(repo, '.papercusp-artifacts', 'wi6443-experiments.png'));
    });

    it('ACCEPTS via PAPERCUSP_REPO_ROOT when no git root is reachable from cwd', async () => {
      const elsewhere = await mkdtemp(join(tmpdir(), 'completion-audit-cwd-'));
      process.env.PAPERCUSP_REPO_ROOT = repo;
      try {
        const verdict = await verifyLiveDroveUiArtifacts(
          { verifiedHow: 'live-drove-ui', testResult: 'see .papercusp-artifacts/wi6443-experiments.png' },
          { cwd: elsewhere },
        );
        expect(verdict.ok).toBe(true);
        expect(verdict.artifacts[0].status).toBe('content');
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });

    // The negative control: widening the search must not blunt the gate.
    it('still REJECTS a citation that is absent under EVERY base — and names the bases tried', async () => {
      delete process.env.PAPERCUSP_REPO_ROOT;
      const verdict = await verifyLiveDroveUiArtifacts(
        { verifiedHow: 'live-drove-ui', testResult: 'see .papercusp-artifacts/never-captured.png' },
        { cwd: nested },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.artifacts[0].status).toBe('missing');
      // The whole point of the fix's second half: a diagnosable message, not a flat
      // assertion the reporter can disprove with one `ls`.
      expect(verdict.reason).toContain('looked under');
      expect(verdict.reason).toContain(repo);
      expect(verdict.artifacts[0].basesTried).toEqual([nested, repo]);
    });

    it('leaves an ABSOLUTE citation on exactly one candidate — nothing to explain', async () => {
      const verdict = await verifyLiveDroveUiArtifacts(
        { verifiedHow: 'live-drove-ui', testResult: `see ${join(repo, 'nope.png')}` },
        { cwd: nested },
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.artifacts[0].basesTried).toBeUndefined();
      expect(verdict.reason).not.toContain('looked under');
    });
  });

  // EI-18855312333744373 — the artifact extractor treated URL PATHS from an HTTP probe
  // transcript as local filesystem citations, so any web-deploy `live-drove-ui`
  // verification was rejected as fabricated.
  describe('accepts a deployed-URL + status-code pair as evidence, not a filesystem citation (EI-18855312333744373)', () => {
    it('ACCEPTS the exact repro: a URL and a bare path, both paired with an HTTP status', async () => {
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        testResult: 'https://example.com/about -> 200; /me.jpg -> 200',
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.basis).toBe('url');
      expect(verdict.artifacts).toHaveLength(0);
    });

    it('ACCEPTS the real WI-6553 shape: several probed paths, none of them on disk', async () => {
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        testResult:
          'deployed and verified live:\n' +
          'https://papercusp.com/about -> 200 (5,214 B)\n' +
          '/me.jpg -> 200 (121,060 B)\n' +
          '/shots/shot-oddsmith.png -> 200 (89,004 B)',
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.basis).toBe('url');
    });

    it('is NOT satisfied by a bare status-shaped number with no URL anywhere in the evidence', async () => {
      // Ambiguous on purpose: nothing here proves an HTTP request happened at all.
      expect(citesWebProbeEvidence({ testResult: '/tmp/notes.png -> 200 lines changed' })).toBe(false);
    });

    it('still REJECTS a genuinely missing LOCAL artifact cited on its own line, unrelated to any URL', async () => {
      const verdict = await verifyLiveDroveUiArtifacts({
        verifiedHow: 'live-drove-ui',
        testResult: `verified live, see ${dir}/never-taken.png`,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.basis).toBe('image');
    });
  });
});

describe('citedImagePaths / citesAssertionBearingRun (EI-18797014705631713)', () => {
  it('pulls every distinct image path out of the evidence, across all three fields', () => {
    expect(
      citedImagePaths({
        testsRun: 'tauri-agent-tools screenshot --output /tmp/a.png then /tmp/b.jpeg',
        testResult: 'compare against /tmp/a.png',
        filesChanged: ['apps/operator/app/x.tsx', '/tmp/c.webp'],
      }),
    ).toEqual(['/tmp/a.png', '/tmp/b.jpeg', '/tmp/c.webp']);
  });

  it('pulls a canonical vmctl PPM path out of the evidence', () => {
    expect(citedImagePaths({ testResult: 'vmctl screenshot at /home/dev/run/verify/screen.ppm' })).toEqual([
      '/home/dev/run/verify/screen.ppm',
    ]);
  });

  it('counts only `check` as assertion-bearing — screenshot and capture cannot fail', () => {
    expect(citesAssertionBearingRun({ testsRun: 'tauri-agent-tools check --eval "x" --json' })).toBe(true);
    // These two exit 0 whether or not anything painted, which is the entire bug.
    expect(citesAssertionBearingRun({ testsRun: 'tauri-agent-tools screenshot --output /tmp/a.png' })).toBe(false);
    expect(citesAssertionBearingRun({ testsRun: 'tauri-agent-tools capture --out /tmp/a.png' })).toBe(false);
  });

  // EI-18855312333744373
  it('excludes an image-extensioned path immediately followed by an HTTP status — a probe result, not a file', () => {
    expect(
      citedImagePaths({ testResult: 'https://example.com/about -> 200; /me.jpg -> 200 (121,060 B)' }),
    ).toEqual([]);
  });

  it('still keeps a genuine local citation that merely SHARES a line with an unrelated URL', () => {
    // The narrow-adjacency rule matters here: a whole-line "mentions a URL somewhere"
    // heuristic would wrongly launder /tmp/real.png too.
    expect(
      citedImagePaths({
        testsRun: 'reference shot at https://example.com/expected.png and /tmp/real.png',
      }),
    ).toEqual(['/tmp/real.png']);
  });

  it('citesWebProbeEvidence requires an actual URL scheme, not just a status-shaped number', () => {
    expect(citesWebProbeEvidence({ testResult: 'https://papercusp.com/about -> 200' })).toBe(true);
    expect(citesWebProbeEvidence({ testResult: '/me.jpg -> 200, no scheme mentioned anywhere' })).toBe(false);
  });
});

// EI-18716652701919665 — pure heuristics feeding the `intermittent-underevidenced` audit
// bucket.
describe('looksLikeIntermittentClassification (EI-18716652701919665)', () => {
  it('flags a title containing "intermittent" / "intermittently"', () => {
    expect(looksLikeIntermittentClassification('live-federation-gate fails intermittently on B->A')).toBe(true);
    expect(looksLikeIntermittentClassification('Intermittent test failure in content-matrix')).toBe(true);
  });

  it('flags "flaky" / "flake"', () => {
    expect(looksLikeIntermittentClassification('flaky integration test in hyperbee suite')).toBe(true);
    expect(looksLikeIntermittentClassification('this test is a known flake')).toBe(true);
  });

  it('flags "race condition" / "racy" / "nondeterministic"', () => {
    expect(looksLikeIntermittentClassification('race condition in claim reconciliation')).toBe(true);
    expect(looksLikeIntermittentClassification('racy ordering in the SSE fan-out')).toBe(true);
    expect(looksLikeIntermittentClassification('nondeterministic ordering breaks the snapshot')).toBe(true);
    expect(looksLikeIntermittentClassification('non-deterministic plan selection')).toBe(true);
  });

  it('does NOT flag an unrelated title', () => {
    expect(looksLikeIntermittentClassification('coord:escalations is over the prompt-weight hard cap')).toBe(false);
  });

  it('does NOT flag a partial-word collision (word-bounded)', () => {
    // "flakiness" contains "flak" but not the bare word "flaky"/"flake" — still should NOT
    // false-positive on an unrelated word that merely shares a substring.
    expect(looksLikeIntermittentClassification('reflaky is not a real word, sanity check')).toBe(false);
  });

  it('does NOT flag null/undefined/empty', () => {
    expect(looksLikeIntermittentClassification(null)).toBe(false);
    expect(looksLikeIntermittentClassification(undefined)).toBe(false);
    expect(looksLikeIntermittentClassification('')).toBe(false);
  });
});

describe('hasIntermittentFailureRateEvidence (EI-18716652701919665)', () => {
  it('flags a stated percentage / failure rate', () => {
    expect(hasIntermittentFailureRateEvidence('observed a ~12% failure rate across 50 runs')).toBe(true);
    expect(hasIntermittentFailureRateEvidence('failure rate dropped to 0 after the fix')).toBe(true);
  });

  it('flags root-cause / deterministic-repro language', () => {
    expect(hasIntermittentFailureRateEvidence('root cause: unawaited promise in the SSE fan-out')).toBe(true);
    expect(hasIntermittentFailureRateEvidence('added a deterministic repro + regression test')).toBe(true);
  });

  it('flags "historically" / "flakiness" / "flake rate"', () => {
    expect(hasIntermittentFailureRateEvidence('historically fails about 1 in 5 runs')).toBe(true);
    expect(hasIntermittentFailureRateEvidence('flakiness dropped after the timeout fix')).toBe(true);
  });

  it("does NOT flag a bare consecutive-passes streak (the WI-5673 shape this audit exists for)", () => {
    expect(hasIntermittentFailureRateEvidence('2 consecutive runs, 10/10 both times')).toBe(false);
  });

  it('does NOT flag null/undefined/empty', () => {
    expect(hasIntermittentFailureRateEvidence(null)).toBe(false);
    expect(hasIntermittentFailureRateEvidence(undefined)).toBe(false);
    expect(hasIntermittentFailureRateEvidence('')).toBe(false);
  });
});

/**
 * P-013 — the completion-AUTHORITY filter: the read half D-012 left open.
 *
 * P-006/D-003 deleted the 'no-evidence' bareness audit because P-004 made evidence a
 * WRITE-time requirement — but that also removed the only way to LIST under-evidenced
 * closes after the fact. The judgement is a column now, so the replacement is a filter
 * over it. These tests pin the SQL fragment (no live Postgres needed), because the
 * regression that matters is the same one EI-10867 caught for the audit: a predicate
 * silently keying on the wrong field, which reads as "everything is fine".
 */
describe('completionAuthorityPredicateSql (P-013)', () => {
  it("'unjudged' tests the authority column for NULL — not for a literal string", () => {
    const f = frag(completionAuthorityPredicateSql(recordingSql(), 'unjudged'));
    expect(f.text).toContain('authority IS NULL');
    // The bug this forbids: binding 'unjudged' as a value, so the predicate becomes
    // `authority = 'unjudged'` and matches NOTHING — an empty result that reads as
    // "no unjudged closes exist" when in fact 61.8% of them are unjudged.
    expect(f.params).not.toContain('unjudged');
  });

  it('a real judgement binds as a PARAMETER, never interpolated into the SQL text', () => {
    const f = frag(completionAuthorityPredicateSql(recordingSql(), 'proposed'));
    expect(f.params).toContain('proposed');
    expect(f.text).not.toContain("'proposed'");
    expect(f.text).toContain('authority =');
  });

  it('every stampable authority value is expressible as a filter', () => {
    for (const a of WORK_ITEM_COMPLETION_AUTHORITIES) {
      const f = frag(completionAuthorityPredicateSql(recordingSql(), a));
      expect(f.params).toContain(a);
    }
  });

  /**
   * The `satisfies` on COMPLETION_AUTHORITY_FILTERS proves each entry is LEGAL but cannot
   * prove the list is COMPLETE — a newly-added authority omitted from it still compiles,
   * and the failure mode is silent: the store can hold the value but no caller can select
   * it. Asserted here instead.
   */
  it('the filter vocabulary covers every stampable authority, plus unjudged', () => {
    for (const a of WORK_ITEM_COMPLETION_AUTHORITIES) {
      expect(COMPLETION_AUTHORITY_FILTERS).toContain(a);
    }
    expect(COMPLETION_AUTHORITY_FILTERS).toContain('unjudged');
    expect(COMPLETION_AUTHORITY_FILTERS).toHaveLength(WORK_ITEM_COMPLETION_AUTHORITIES.length + 1);
  });

  it('the aliased form matches its unaliased twin (mirrors the audit predicate contract)', () => {
    for (const v of ['unjudged', 'committed'] as const) {
      const plain = frag(completionAuthorityPredicateSql(recordingSql(), v));
      const aliased = frag(completionAuthorityPredicateSql(recordingSql(), v, 'ei'));
      expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
    }
  });

  it("qualifies the column with the alias when one is given (topic-joined branches select from a join)", () => {
    const f = frag(completionAuthorityPredicateSql(recordingSql(), 'unjudged', 'ei'));
    expect(f.text).toContain('ei.authority IS NULL');
  });

  /**
   * 'unjudged' must never be readable as "unevidenced". Only work_items:complete stamps
   * an authority, so a close made through the bare state-write path lands NULL however
   * well evidenced it was — its evidence goes to terminal_completion_ref, and complete's
   * structured evidence goes to payload._completionEvidence. Three different places, so
   * this predicate deliberately tests exactly ONE of them and no caller may read it as a
   * total evidence verdict. Pinned so a later "helpful" widening has to argue with a test.
   */
  it('is a judgement test ONLY — it never inspects the two evidence stores', () => {
    const f = frag(completionAuthorityPredicateSql(recordingSql(), 'unjudged'));
    expect(f.text).not.toContain('terminal_completion_ref');
    expect(f.text).not.toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);
    expect(f.params).not.toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);
  });
});

/**
 * EI-19313376980892266 fix B — the terminal-owner classifier behind work_items:burn_down's
 * `deltaBy`. Pinned HERE, in the module that owns the identity constants, so the structural
 * prefix rule cannot be quietly narrowed to a membership-only test without a red.
 */
describe('classifyTerminalOwner', () => {
  it('classifies the `system:` routine convention as system', () => {
    expect(classifyTerminalOwner('system:plan-item-reconcile')).toBe('system');
    expect(classifyTerminalOwner('system:replication-liveness')).toBe('system');
    expect(classifyTerminalOwner('system:condition-bridge')).toBe('system');
    expect(classifyTerminalOwner(RECONCILER_SYSTEM_ACTOR)).toBe('system');
  });

  /**
   * The case a constants-only classifier gets WRONG. `watchdog-green-resolve` is written
   * as a bare string literal in harness/improvements/auto-close.ts with no exported
   * constant, so it appears in NO registry — yet it closed 42 items in 30 days (measured
   * 2026-08-03). Without the prefix rule every one is credited to an agent.
   */
  it('classifies un-constanted `watchdog-` identities as system', () => {
    expect(classifyTerminalOwner('watchdog-green-resolve')).toBe('system');
    expect(classifyTerminalOwner('watchdog-auto-close')).toBe('system');
    expect(classifyTerminalOwner('watchdog-orphan-superseded')).toBe('system');
  });

  it('classifies every known bypass identity as system', () => {
    for (const id of KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES) {
      expect(classifyTerminalOwner(id), `${id} must classify as system`).toBe('system');
    }
  });

  it('classifies agent owner ids as agent', () => {
    expect(classifyTerminalOwner('su-5b23300b-ff55-49d4-957a-3e4b31710443')).toBe('agent');
    expect(classifyTerminalOwner('cup-abc123')).toBe('agent');
    // A bare uuid with no prefix is still a named actor, not automation.
    expect(classifyTerminalOwner('6781c9f6-2c64-45a1-8972-9efe499c531e')).toBe('agent');
  });

  /**
   * `unattributed` must never collapse into `system`: "nobody recorded who closed this"
   * and "automation closed this" are different facts, and merging them would hide the
   * mass-unattributed-close signature EI-18820653360383242 exists to keep visible.
   */
  it('keeps a missing owner distinct from automation', () => {
    expect(classifyTerminalOwner(null)).toBe('unattributed');
    expect(classifyTerminalOwner(undefined)).toBe('unattributed');
    expect(classifyTerminalOwner('   ')).toBe('unattributed');
  });
});
