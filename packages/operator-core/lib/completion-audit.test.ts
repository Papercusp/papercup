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
  COMPLETION_AUDITS,
  looksLikeCitedProseEvidence,
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
  it("'no-evidence' keys on the EVIDENCE payload — NOT on terminal_completion_ref", () => {
    const f = frag(auditPredicateSql(recordingSql(), 'no-evidence'));

    // The fix: it must test for the evidence key…
    expect(f.text).toContain('payload');
    expect(f.text).toContain('?'); // jsonb key-existence
    expect(f.params).toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);

    // …and must NOT be the old, unfireable predicate. THIS is the falsification: the
    // pre-fix code produced exactly `terminal_completion_ref IS NULL` here.
    expect(f.text).not.toContain('terminal_completion_ref');
  });

  it("'no-completion-record' preserves the OLD check as its own, separately-named audit", () => {
    const f = frag(auditPredicateSql(recordingSql(), 'no-completion-record'));
    expect(f.text).toContain('terminal_completion_ref IS NULL');
    expect(f.params).not.toContain(TERMINAL_COMPLETION_EVIDENCE_KEY);
  });

  it('a NULL payload reads as NO evidence (it must not drop out of the audit)', () => {
    // The row that never carried a payload is the MOST suspect, so `payload ? key`
    // alone (which is NULL, not false, for a NULL payload) would be a silent miss.
    const f = frag(auditPredicateSql(recordingSql(), 'no-evidence'));
    expect(f.text).toContain("COALESCE(payload, '{}'::jsonb)");
  });

  it('the aliased form (a joined query) keys on the SAME field as the unaliased one', () => {
    const plain = frag(auditPredicateSql(recordingSql(), 'no-evidence'));
    const aliased = frag(auditPredicateSqlFor(recordingSql(), 'no-evidence', 'ei'));

    expect(aliased.text).toContain('ei.payload');
    expect(aliased.params).toEqual(plain.params); // same evidence key, same semantics
    expect(aliased.text).not.toContain('terminal_completion_ref');

    // The two forms must stay structurally identical modulo the alias — the 6 call
    // sites drifting apart is the class of bug this whole module exists to kill.
    expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
  });

  it('the aliased no-completion-record form also matches its unaliased twin', () => {
    const plain = frag(auditPredicateSql(recordingSql(), 'no-completion-record'));
    const aliased = frag(auditPredicateSqlFor(recordingSql(), 'no-completion-record', 'ei'));
    expect(aliased.text.replace(/ei\./g, '')).toBe(plain.text);
  });

  it('every declared audit produces a predicate (no silently-unhandled enum member)', () => {
    for (const a of COMPLETION_AUDITS) {
      const f = frag(auditPredicateSql(recordingSql(), a));
      expect(f.text.trim().length).toBeGreaterThan(0);
    }
  });
});

// EI-13424 — the audit's own false-positive rate: a `no-evidence` hit whose prose
// completion.summary already cites real verification detail should not read as a bare
// done-assertion. These are close paraphrases of the three real completions the bug
// report cites (WI-4669 / WI-4999 / WI-5089), each of which the audit flagged despite
// carrying rich, cited verification prose.
describe('looksLikeCitedProseEvidence (EI-13424)', () => {
  it('flags a ref citing a live tool observation + field-by-field spec check (WI-4669-shaped)', () => {
    const ref =
      'Live-verified events:status { event } in production right now, called twice this session; ' +
      'checked every requirement in the spec against the actual returned field, including a live ' +
      "observation (\"fired\" on event 'rig-heal-federation-green'), waiters[]/wake_outcomes[] field-by-field.";
    expect(looksLikeCitedProseEvidence(ref)).toBe(true);
  });

  it('flags a ref citing a drill run + cross-referenced peer drillIds (WI-4999-shaped)', () => {
    const ref =
      "Verified via session:carry-drill{op:'report'} at 2026-07-17T03:20Z: perClass = " +
      '[claude-interactive: drills:1, gaps:0, sufficient:true], cross-referenced against TWO ' +
      'independent fresh drills from fleet peers (su-b7b40c9b drillId 828c3534-e29b-4716-a716-446655440000).';
    expect(looksLikeCitedProseEvidence(ref)).toBe(true);
  });

  it('flags a ref citing a file:line, measured numbers, and a commit sha (WI-5089-shaped)', () => {
    const ref =
      'Verified the actual doc content is present and committed: desktop-release-upload-runbook.mdx ' +
      "has a '## Keep cargo caches warm' section (lines 187-228) with the measured numbers " +
      '(cold 428-crate rebuild 143s vs warm incremental 4s) and the commit sha d3ca309e076992e162b319f035fbb8624692716c.';
    expect(looksLikeCitedProseEvidence(ref)).toBe(true);
  });

  it('does NOT flag a genuinely bare done-assertion', () => {
    expect(looksLikeCitedProseEvidence('done')).toBe(false);
    expect(looksLikeCitedProseEvidence('Completed all tasks, looks good.')).toBe(false);
    expect(looksLikeCitedProseEvidence(null)).toBe(false);
    expect(looksLikeCitedProseEvidence(undefined)).toBe(false);
    expect(looksLikeCitedProseEvidence('')).toBe(false);
  });

  it('does NOT flag a short ref even if it happens to contain a number (length floor)', () => {
    // Under the length floor — a short ref shouldn't earn "evidenced" status just
    // because it contains digits; that would recreate the over-detection failure mode
    // this exists to avoid, just shifted to short refs instead of long ones.
    expect(looksLikeCitedProseEvidence('Fixed bug #123, done.')).toBe(false);
  });
});
