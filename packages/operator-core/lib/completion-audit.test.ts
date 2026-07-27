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
import { describe, it, expect } from 'vitest';
import {
  auditPredicateSql,
  auditPredicateSqlFor,
  citesScreenshotArtifact,
  COMPLETION_AUDITS,
  hasIntermittentFailureRateEvidence,
  isBackedLiveDroveUiClaim,
  KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES,
  looksLikeIntermittentClassification,
  RECONCILER_SYSTEM_ACTOR,
  touchesLayoutBearingFiles,
} from './completion-audit';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from './coord-lifecycle/records';

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

  it('every declared audit produces a predicate (no silently-unhandled enum member)', () => {
    for (const a of COMPLETION_AUDITS) {
      const f = frag(auditPredicateSql(recordingSql(), a));
      expect(f.text.trim().length).toBeGreaterThan(0);
    }
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
describe('isBackedLiveDroveUiClaim (WI-5891)', () => {
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
