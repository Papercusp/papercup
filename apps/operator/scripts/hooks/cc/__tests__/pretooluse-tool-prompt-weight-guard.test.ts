/**
 * pretooluse-tool-prompt-weight-guard — the BLOCKING half of the P-011
 * prompt-weight pair (EI-20204186116417704).
 *
 * The sibling nudge's test file argues that a guard test which only exercises
 * helpers against synthetic fixtures is worthless. That applies here with one
 * extra edge: this hook DENIES, so it has a failure mode the advisory sibling
 * does not — a FALSE deny wedges an author out of a file they are entitled to
 * edit. Both directions therefore have to be pinned:
 *
 *   1. IT ACTUALLY BLOCKS — the real binary, over stdin, must deny an edit that
 *      grows a tool past the budget. A guard that cannot be shown to fire is
 *      indistinguishable from one that is silently inert, which is exactly the
 *      state the PostToolUse sibling was already in (it fired, and the breach
 *      landed anyway).
 *   2. IT DOES NOT BLOCK ITS OWN REMEDY — the load-bearing case. A tool that is
 *      over budget and getting SMALLER must PASS. Get this wrong and a
 *      grandfathered or already-breached tool becomes uneditable: the guard
 *      refuses the very edit that would fix the thing it is complaining about.
 *      Every `ALLOW` case below is a real trap, not filler.
 *   3. IT AGREES WITH THE GATE — a deny is only legitimate if the green
 *      checkpoint would actually red on the same file. The tiers and the
 *      exemption list are read from the production module, so this asserts the
 *      hook's verdict against `budgetViolations()` rather than against a
 *      restatement of it.
 *   4. IT FAILS OPEN — an unreadable budget module, an unknown exemption list,
 *      an inexact edit reconstruction, an unmeasurable template literal. Each
 *      must ALLOW. A blocking hook that guesses is worse than no hook.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  BUDGET,
  HARD_CAP,
  budgetViolations,
} from '../../../../../../packages/operator-core/lib/agent-tools/tool-guidance-budget';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../pretooluse-tool-prompt-weight-guard.mjs');

type Decision = { decision: 'allow' | 'deny'; reason: string };

/** Run the hook binary exactly as the harness does: JSON on stdin. */
function runHook(payload: unknown): Decision {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    // The hook writes the reason to stderr too; keep it off the test log.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!out.trim()) return { decision: 'allow', reason: '' };
  const o = JSON.parse(out).hookSpecificOutput as {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
  return o.permissionDecision === 'deny'
    ? { decision: 'deny', reason: o.permissionDecisionReason ?? '' }
    : { decision: 'allow', reason: '' };
}

const toolSrc = (name: string, len: number) =>
  `export default defineTool({ name: '${name}', description: '${'x'.repeat(len)}' });\n`;

describe('pretooluse-tool-prompt-weight-guard', () => {
  let dir = '';
  const toolDir = () => join(dir, 'packages/operator-core/lib/agent-tools/x');
  const target = () => join(toolDir(), 't.ts');
  const budgetPath = () => join(dir, 'packages/operator-core/lib/agent-tools/tool-guidance-budget.ts');

  /** Put the file on disk at `before` chars, then ask the hook about a Write taking it to `after`. */
  const attempt = (before: number, after: number, name = 't:x'): Decision => {
    writeFileSync(target(), toolSrc(name, before));
    return runHook({ tool_name: 'Write', tool_input: { file_path: target(), content: toolSrc(name, after) } });
  };

  const writeBudgetModule = (allow: string) =>
    writeFileSync(
      budgetPath(),
      `export const BUDGET = ${BUDGET};\nexport const HARD_CAP = ${HARD_CAP};\n${allow}`,
    );

  beforeAll(() => {
    // Built OUTSIDE the shared tree on purpose: proving a guard can fail must
    // never mutate the working checkout, because git-sync sweeps the whole tree
    // on a schedule and would commit the mutant.
    dir = mkdtempSync(join(tmpdir(), 'ppw-guard-'));
    mkdirSync(toolDir(), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    writeBudgetModule('export const ALLOW_OVER_BUDGET = new Set<string>([]);\n');
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe('1. it actually blocks', () => {
    it('an edit growing a tool past the budget is DENIED', () => {
      const { decision, reason } = attempt(BUDGET - 100, BUDGET + 20);
      expect(decision).toBe('deny');
      expect(reason).toContain('t:x');
      expect(reason).toContain(String(BUDGET + 20));
      expect(reason).toContain('Cut >=20');
    });

    it('the denial states the GROWTH, so the author can see what their edit did', () => {
      const { reason } = attempt(BUDGET - 100, BUDGET + 20);
      expect(reason).toContain(`was ${BUDGET - 100}`);
      expect(reason).toContain('+120');
    });

    it('the denial carries the zero-loss remedy and the escape hatch, not just a complaint', () => {
      const { reason } = attempt(BUDGET - 100, BUDGET + 20);
      expect(reason).toContain('guidance.returns');
      expect(reason).toContain('PAPERCUSP_ALLOW_TOOL_PROMPT_WEIGHT');
    });

    it('one character over is still over — the boundary is not fuzzy', () => {
      expect(attempt(BUDGET - 100, BUDGET + 1).decision).toBe('deny');
    });

    it('a brand-new file whose tool is born over budget is DENIED', () => {
      const fresh = join(toolDir(), 'brand-new.ts');
      const d = runHook({
        tool_name: 'Write',
        tool_input: { file_path: fresh, content: toolSrc('t:new', BUDGET + 50) },
      });
      expect(d.decision).toBe('deny');
      expect(d.reason).toContain('no prior measurable weight');
    });
  });

  describe('2. it does not block its own remedy (the load-bearing direction)', () => {
    it('over budget and SHRINKING → allowed', () => {
      expect(attempt(BUDGET + 100, BUDGET + 50).decision).toBe('allow');
    });

    it('over budget and UNCHANGED → allowed (an unrelated edit elsewhere in the file)', () => {
      expect(attempt(BUDGET + 50, BUDGET + 50).decision).toBe('allow');
    });

    it('over budget and shrinking to exactly the budget → allowed', () => {
      expect(attempt(BUDGET + 50, BUDGET).decision).toBe('allow');
    });

    it('growth that stays UNDER the budget → allowed (growing is normal and usually fine)', () => {
      expect(attempt(BUDGET - 200, BUDGET - 10).decision).toBe('allow');
    });

    it('exactly AT the budget → allowed (the boundary is not a breach)', () => {
      expect(attempt(BUDGET - 100, BUDGET).decision).toBe('allow');
    });
  });

  describe('3. it agrees with the gate it exists to protect', () => {
    it.each([
      ['under budget', BUDGET - 1],
      ['at budget', BUDGET],
      ['over budget', BUDGET + 20],
      ['over hard cap', HARD_CAP + 20],
    ])('a %s tool is denied iff budgetViolations() would red on it', (_label, weight) => {
      // Growth from zero, so the worsening predicate never masks the tier logic.
      const denied = attempt(1, weight).decision === 'deny';
      const gateReds = budgetViolations([{ name: 't:x', weight }]).length > 0;
      expect(denied).toBe(gateReds);
    });

    it('an ordinary tool over the HARD CAP is told to cut to the BUDGET, not to the cap', () => {
      // Cutting only to the hard cap would leave it over the budget and STILL red —
      // the guard would then refuse the author's next edit after they did as asked.
      const { reason } = attempt(1, HARD_CAP + 20);
      expect(reason).toContain(`Cut >=${HARD_CAP + 20 - BUDGET}`);
      expect(reason).toContain(`${BUDGET}-char budget`);
    });

    it('a GRANDFATHERED tool over budget is allowed — the gate exempts it, so the guard must too', () => {
      writeBudgetModule("export const ALLOW_OVER_BUDGET = new Set<string>(['t:gf']);\n");
      try {
        expect(attempt(BUDGET - 100, BUDGET + 50, 't:gf').decision).toBe('allow');
        // ...but the HARD CAP still binds, grandfathered or not.
        expect(attempt(BUDGET - 100, HARD_CAP + 10, 't:gf').decision).toBe('deny');
      } finally {
        writeBudgetModule('export const ALLOW_OVER_BUDGET = new Set<string>([]);\n');
      }
    });
  });

  describe('4. it fails open on anything less than an exact reading', () => {
    it('an UNKNOWN exemption list allows (unknown is not the same as empty)', () => {
      writeBudgetModule(''); // no ALLOW_OVER_BUDGET at all
      try {
        expect(attempt(BUDGET - 100, BUDGET + 20).decision).toBe('allow');
      } finally {
        writeBudgetModule('export const ALLOW_OVER_BUDGET = new Set<string>([]);\n');
      }
    });

    it('an unparseable budget module allows rather than substituting a default', () => {
      writeFileSync(budgetPath(), 'export const SOMETHING_ELSE = 5;\n');
      try {
        expect(attempt(BUDGET - 100, BUDGET + 20).decision).toBe('allow');
      } finally {
        writeBudgetModule('export const ALLOW_OVER_BUDGET = new Set<string>([]);\n');
      }
    });

    it('an Edit whose old_string is absent allows (that edit will never land)', () => {
      writeFileSync(target(), toolSrc('t:x', BUDGET - 100));
      const d = runHook({
        tool_name: 'Edit',
        tool_input: { file_path: target(), old_string: 'not-present-anywhere', new_string: 'x'.repeat(500) },
      });
      expect(d.decision).toBe('allow');
    });

    it('an unmeasurable template literal allows — a weight we cannot compare is not one we may refuse on', () => {
      writeFileSync(target(), toolSrc('t:x', BUDGET - 100));
      const d = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: target(),
          content: 'export default defineTool({ name: "t:x", description: `a${x}b` });\n',
        },
      });
      expect(d.decision).toBe('allow');
    });

    it('a file outside the tool-registry roots is ignored entirely', () => {
      const outside = join(dir, 'packages/operator-core/lib/not-a-tool.ts');
      writeFileSync(outside, toolSrc('t:x', BUDGET + 200));
      expect(
        runHook({ tool_name: 'Write', tool_input: { file_path: outside, content: toolSrc('t:x', BUDGET + 400) } })
          .decision,
      ).toBe('allow');
    });

    it('a non-edit tool is ignored', () => {
      expect(runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).decision).toBe('allow');
    });

    it('malformed stdin fails open', () => {
      const out = execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8', timeout: 60_000 });
      expect(out.trim()).toBe('');
    });
  });

  it('the embedded --self-test passes', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8', timeout: 60_000 });
    expect(out).toContain('all cases passed');
  });
});
