/**
 * physical-drill-iteration-speed-2026-09-29 P-006 (R-8): the hive-git drill's driver
 * runbook states the "two drill failures with different causes, then audit the harness
 * before the next run" rule, in one paragraph an agent can follow. `driver-audit-rule.ts`
 * explains why the rule is pinned in prose at all (P-505: 32 runs, one summary line, five
 * different harness defects). The base persona carries the same rule (see the sibling
 * `driver-audit-rule.test.ts`); this file pins the drill-specific statement, plus the two
 * facts a driver needs to act on it: where each run's evidence is kept, and the audit-note
 * marker that clears the loop gate.
 *
 * The subject path is overridable (PAPERCUSP_DRILL_RUNBOOK_DOC) so falsifiability can be
 * proved against a copy outside the tree, never by mutating the shared checkout. The
 * control case below proves the same thing in-file: the real doc with its rule paragraph
 * removed must fail the judge.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';
import { judgeDriverAuditRule } from './driver-audit-rule';
import { ATTEMPT_AUDIT_MARKER } from '../verification-attempts/loop-gate';

const DOC_RELPATH = 'apps/operator-docs/src/content/docs/agent-insights/hive-git-physical-drill-driver-runbook.mdx';

/**
 * The doc BODY. The frontmatter is dropped because its one-line `description` (the search
 * index hook) also summarises the rule, and the judge would accept that block as the
 * paragraph — a rule that exists only in an index hook is not an instruction a reader sees.
 */
const doc = (): string =>
  readFileSync(process.env.PAPERCUSP_DRILL_RUNBOOK_DOC ?? join(ROOT, DOC_RELPATH), 'utf8').replace(
    /^---\n[\s\S]*?\n---\n/,
    '',
  );

describe('the hive-git drill driver runbook states the audit rule (R-8)', () => {
  it('carries trigger, action and timing in one paragraph', () => {
    const v = judgeDriverAuditRule(doc());
    expect(v.missing, `drill runbook is missing: ${v.missing.join(', ')}`).toEqual([]);
    expect(v.ok).toBe(true);
    // The rule is about THE DRILL, not a generic restatement of the persona.
    expect(v.paragraph).toMatch(/drill failures/);
  });

  it('names the loop-gate backstop by the marker the gate actually reads', () => {
    const v = judgeDriverAuditRule(doc());
    // Pinned to the code's constant, so renaming the marker without the doc fails here.
    expect(v.paragraph).toContain(ATTEMPT_AUDIT_MARKER);
  });

  it('tells the driver where each run keeps its evidence, as the drill actually does it', () => {
    const text = doc();
    const drill = readFileSync(join(ROOT, 'papercusp-desktop/bin/hive-git-drill.sh'), 'utf8');
    for (const token of ['HIVE_GIT_PHYSICAL_RUNS_DIR', '.papercusp-drill-physical-runs']) {
      expect(drill, `drill no longer uses ${token}; update the runbook with it`).toContain(token);
      expect(text).toContain(token);
    }
  });

  it('control: the same doc with its rule paragraph removed fails the judge', () => {
    const text = doc();
    const v = judgeDriverAuditRule(text);
    expect(v.paragraph).toBeTruthy();
    const without = text.replace(v.paragraph!, 'The drill is expensive; run it carefully.');
    expect(without).not.toBe(text);
    expect(judgeDriverAuditRule(without).ok).toBe(false);
  });
});
