/**
 * CLAUDE.md's log-triage recipes must anchor every house machine-line marker on its
 * required field (WI-37636; sibling of `gate-candidate-ref.test.ts`, same P-004 family).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. Each
 * fixture reproduces a shape that MUST be caught — including the exact recipe CLAUDE.md
 * itself shipped for months (`grep -o 'GATE_HELD_BY.*' <log> | tail -1`).
 */
import { describe, it, expect } from 'vitest';
import { judgeMachineLineGrepAnchors, CANONICAL_ANCHOR } from './machine-line-grep-anchors';
import { CORPUS_FLOORS, SUBJECT_LABEL, readCorpus } from './corpus-subject';

/** Pad a fixture past the short-read refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'filler prose line\n'.repeat(200)}`;

const fence = (cmd: string): string => ['```bash', cmd, '```'].join('\n');

describe('CLAUDE.md machine-line grep anchors', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it("catches the bare GATE_HELD_BY recipe CLAUDE.md actually shipped — the WI-37636 defect", () => {
      const verdict = judgeMachineLineGrepAnchors(
        pad(fence("grep -o 'GATE_HELD_BY.*' <log> | tail -1")),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.unanchoredSites).toHaveLength(1);
      expect(verdict.unanchoredSites[0]!.marker).toBe('GATE_HELD_BY');
      expect(verdict.violations.join('\n')).toMatch(/e\.g\. `GATE_HELD_BY count=`/);
    });

    it('catches every other house marker in its bare form', () => {
      for (const [marker, anchor] of Object.entries(CANONICAL_ANCHOR)) {
        const verdict = judgeMachineLineGrepAnchors(
          pad(fence(`grep -o '${marker}.*' <log> | tail -1`)),
        );
        expect(verdict.ok, `${marker} must be caught unanchored`).toBe(false);
        expect(verdict.violations.join('\n')).toContain(`${marker} ${anchor}`);
      }
    });

    it('catches a bare occurrence sitting BESIDE an anchored one on the same line', () => {
      // One correct use must not launder a second, incorrect one.
      const verdict = judgeMachineLineGrepAnchors(
        pad(fence("grep -E 'GATE_HELD_BY count=|GATE_HELD_BY' <log>")),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.unanchoredSites[0]!.marker).toBe('GATE_HELD_BY');
    });

    it('REFUSES a short/empty read instead of reporting it clean', () => {
      // The false-absence shape: a failed read must never look like a passing gate.
      expect(() => judgeMachineLineGrepAnchors('')).toThrow(/Refusing to judge/);
      expect(() => judgeMachineLineGrepAnchors("grep -o 'GATE_HELD_BY.*'")).toThrow(
        /Refusing to judge/,
      );
    });
  });

  describe('negative controls (the detector must NOT over-fire)', () => {
    it('does NOT fire on PROSE that quotes the bad form to warn about it', () => {
      // CLAUDE.md's own warning contains a literal bare `grep -o 'GATE_HELD_BY.*'`.
      // Judging prose would fire on the documentation of the very bug being fixed.
      const verdict = judgeMachineLineGrepAnchors(
        pad("⚠ Keep the ` count=` — a bare `grep -o 'GATE_HELD_BY.*'` returns a TEST NAME."),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.checkedLines).toBe(0);
    });

    it('does NOT fire on a fenced EXAMPLE-OUTPUT comment (no grep on the line)', () => {
      const verdict = judgeMachineLineGrepAnchors(
        pad(['```bash', '# GATE_HELD_BY count=1 truncated=false entries=["x"]', '```'].join('\n')),
      );
      expect(verdict.ok).toBe(true);
    });

    it('accepts a REAL line whose first field is not the canonical suggestion', () => {
      // The bug this control exists to catch, found in the first version of this judge:
      // the rule pinned ONE field per marker, derived from lines I happened to observe,
      // and was wrong for TEST_FILE_RESULT — which really emits `requested=` first. A
      // one-key rule flags a correct recipe AND sends agents to grep a string no log
      // contains. The emitters legitimately vary their first field, so the rule is
      // "some key=", never a specific key.
      for (const cmd of [
        "grep -o 'TEST_FILE_RESULT requested=.*' <log>", // the REAL shape
        "grep -o 'TEST_FILE_RESULT status=.*' <log>",
        "grep -o 'GATE_HELD_BY entries=.*' <log>",
        "grep -o 'AFFECTED_TESTS_RESULT failed=.*' <log>",
      ]) {
        const verdict = judgeMachineLineGrepAnchors(pad(fence(cmd)));
        expect(verdict.ok, `must accept: ${cmd}`).toBe(true);
      }
    });

    it('accepts the anchored form, including a trailing comment', () => {
      const verdict = judgeMachineLineGrepAnchors(
        pad(fence("grep -o 'AFFECTED_TESTS_FAILING_FILES run=.*' <log> | tail -1   # keep ` run=`")),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.checkedLines).toBe(1);
    });

    it('ignores greps that name no house marker', () => {
      const verdict = judgeMachineLineGrepAnchors(
        pad(fence("grep -oE '(FAIL +|❯ +)[^ ]+\\.(test|spec)\\.[cm]?[jt]sx?' <log>")),
      );
      expect(verdict.ok).toBe(true);
    });
  });

  describe('the live claim', () => {
    // The CORPUS, not CLAUDE.md — the fenced grep recipes this guard judges live in
    // prose, which the client projection deliberately omits (0 of 5 survive it). See
    // corpus-subject.ts.
    const source = readCorpus();

    it('the corpus anchors every machine-line grep recipe it prescribes', () => {
      const verdict = judgeMachineLineGrepAnchors(source);
      // `violations` is string[] here (unlike retired-surfaces', which are objects), so
      // the subject is prefixed onto each rather than read off a `.line` field.
      expect(verdict.violations.map((v) => `${SUBJECT_LABEL} — ${v}`)).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('actually inspected the recipes — a rule that matched nothing proves nothing', () => {
      // Guards against the subject being restructured — or SWAPPED, which is how this
      // nearly happened — such that the judge silently scopes to zero lines and reports
      // a vacuous pass. `ok: true` means "no violations among the lines I checked", so
      // on an empty read it is TRUE and meaningless; this is the assertion that catches
      // that, and it is the one that fires on a projected client file (0 checked lines).
      const verdict = judgeMachineLineGrepAnchors(source);
      expect(verdict.checkedLines).toBeGreaterThanOrEqual(CORPUS_FLOORS.checkedLines);
    });
  });
});
