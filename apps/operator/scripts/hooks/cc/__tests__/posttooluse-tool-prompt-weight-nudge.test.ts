/**
 * posttooluse-tool-prompt-weight-nudge — the EDIT-TIME detector for the P-011
 * prompt-weight budget (EI-19459260956682226).
 *
 * The point of this file is NOT "the hook is well-formed". A guard's unit test
 * that only exercises its helpers against synthetic fixtures is the exact
 * failure this repo just spent a work-item on: `lint:mock-cast-escape`'s logic
 * test stayed green across the entire window its real-tree count drifted +45,
 * and 39 of 63 test-referenced guards here turned out to be logic-only. The
 * discriminator is whether the test EXECUTES the subject over REAL files.
 *
 * So the load-bearing cases here are:
 *   1. AGREEMENT WITH PRODUCTION — the hook's AST weigher is compared against
 *      the real `promptWeight()` on REAL tool modules imported from the tree.
 *      If these ever diverge the nudge is reporting a number the gate does not
 *      recognise, which is worse than no nudge at all.
 *   2. NO DRIFT IN THE LIMITS — `readBudgets` parses the REAL
 *      tool-guidance-budget.ts and must equal the module's own exported
 *      constants. This is what keeps ONE source of truth honest rather than
 *      merely asserted in a comment.
 *   3. FALSIFIABILITY END-TO-END — the hook binary, over stdin, against a
 *      fixture repo built OUTSIDE the shared tree (never mutating it), must
 *      FIRE on an over-budget tool and stay SILENT on an under-budget one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  BUDGET,
  HARD_CAP,
  promptWeight,
} from '../../../../../../packages/operator-core/lib/agent-tools/tool-guidance-budget';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-tool-prompt-weight-nudge.mjs');
const BUDGET_SRC = resolve(ROOT, 'packages/operator-core/lib/agent-tools/tool-guidance-budget.ts');

const ts = createRequire(join(ROOT, 'package.json'))('typescript');

type Hook = {
  isCandidateFile: (p: string) => boolean;
  findRepoRoot: (p: string, exists?: (p: string) => boolean) => string | null;
  readBudgets: (ts: unknown, src: string) => { BUDGET: number; HARD_CAP: number } | null;
  staticStringValue: (ts: unknown, node: unknown) => string | null;
  weighToolObject: (ts: unknown, obj: unknown) => number | null;
  weighToolsInSource: (ts: unknown, src: string, file?: string) => Array<{ name: string; weight: number }>;
  violationsFor: (
    tools: Array<{ name: string; weight: number }>,
    b: { BUDGET: number; HARD_CAP: number },
  ) => Array<{ name: string; weight: number; hardCap: boolean; limit: number; cutAtLeast: number }>;
  formatNudge: (v: ReturnType<Hook['violationsFor']>) => string;
  nudgeFor: (p: string) => string;
};

async function loadHook(): Promise<Hook> {
  return (await import(`file://${HOOK}`)) as unknown as Hook;
}

/** Run the hook binary exactly as the harness does: JSON on stdin. */
function runHook(payload: unknown): string {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (!out.trim()) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

describe('posttooluse-tool-prompt-weight-nudge', () => {
  describe('1. agreement with the PRODUCTION promptWeight (real files, not fixtures)', () => {
    // Real tool modules, deliberately spanning both a small and a heavily
    // documented tool. Each is imported for its true weight AND parsed from
    // source by the hook; the two numbers must be identical.
    const REAL_TOOLS = [
      'packages/operator-core/lib/agent-tools/loop/status.ts',
      'packages/operator-core/lib/agent-tools/loop/arm.ts',
      'packages/operator-core/lib/agent-tools/work_items/get.ts',
    ];

    it.each(REAL_TOOLS)('AST weight === promptWeight() for %s', async (rel) => {
      const hook = await loadHook();
      const mod = (await import(`file://${resolve(ROOT, rel)}`)) as { default?: unknown };
      const tool = mod.default as { name?: string } | undefined;
      expect(tool, `${rel} should default-export a tool`).toBeTruthy();

      const truth = promptWeight(tool as Parameters<typeof promptWeight>[0]);
      const parsed = hook.weighToolsInSource(ts, readFileSync(resolve(ROOT, rel), 'utf8'), rel);
      const mine = parsed.find((t) => t.name === tool!.name);

      expect(mine, `hook should measure ${tool!.name} in ${rel}`).toBeTruthy();
      expect(mine!.weight).toBe(truth);
    });

    it('measures a real file to a NON-ZERO weight (a zero would pass every assertion vacuously)', async () => {
      const hook = await loadHook();
      const rel = 'packages/operator-core/lib/agent-tools/loop/status.ts';
      const [t] = hook.weighToolsInSource(ts, readFileSync(resolve(ROOT, rel), 'utf8'), rel);
      expect(t).toBeTruthy();
      expect(t.weight).toBeGreaterThan(100);
    });
  });

  describe('2. the limits come from ONE source of truth, and cannot drift', () => {
    it('readBudgets(real tool-guidance-budget.ts) === the module’s exported constants', async () => {
      const hook = await loadHook();
      const parsed = hook.readBudgets(ts, readFileSync(BUDGET_SRC, 'utf8'));
      expect(parsed).not.toBeNull();
      expect(parsed!.BUDGET).toBe(BUDGET);
      expect(parsed!.HARD_CAP).toBe(HARD_CAP);
    });

    it('fails OPEN (null) rather than substituting a default when the constants are absent', async () => {
      const hook = await loadHook();
      expect(hook.readBudgets(ts, 'export const SOMETHING_ELSE = 5;')).toBeNull();
    });
  });

  describe('3. falsifiability, end-to-end through the real binary', () => {
    let dir = '';
    const toolDir = () => join(dir, 'packages/operator-core/lib/agent-tools/loop');

    beforeAll(() => {
      // Built OUTSIDE the shared tree on purpose: proving a guard can fail must
      // never mutate the working checkout, because git-sync sweeps the whole
      // tree on a schedule and would commit the mutant.
      dir = mkdtempSync(join(tmpdir(), 'ppw-nudge-'));
      mkdirSync(toolDir(), { recursive: true });
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
      writeFileSync(
        join(dir, 'packages/operator-core/lib/agent-tools/tool-guidance-budget.ts'),
        `export const BUDGET = ${BUDGET};\nexport const HARD_CAP = ${HARD_CAP};\n`,
      );
      const def = (name: string, len: number) =>
        `export default defineTool({ name: '${name}', description: '${'x'.repeat(len)}' });\n`;
      writeFileSync(join(toolDir(), 'ok.ts'), def('loop:ok', BUDGET));
      writeFileSync(join(toolDir(), 'over.ts'), def('loop:over', BUDGET + 68));
      writeFileSync(join(toolDir(), 'hard.ts'), def('loop:hard', HARD_CAP + 93));
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('exactly AT the budget → SILENT (the boundary is not a breach)', () => {
      expect(runHook({ tool_name: 'Edit', tool_input: { file_path: join(toolDir(), 'ok.ts') } })).toBe('');
    });

    it('over the budget → FIRES, naming the tool and the exact cut', () => {
      const msg = runHook({ tool_name: 'Edit', tool_input: { file_path: join(toolDir(), 'over.ts') } });
      expect(msg).toContain('loop:over');
      expect(msg).toContain(String(BUDGET + 68));
      expect(msg).toContain('Cut >=68');
      // The actionable remedy, not just the complaint.
      expect(msg).toContain('guidance.returns');
    });

    it('over the HARD CAP → reported against the hard cap, not the soft budget', () => {
      const msg = runHook({ tool_name: 'Edit', tool_input: { file_path: join(toolDir(), 'hard.ts') } });
      expect(msg).toContain('HARD CAP');
      expect(msg).toContain('Cut >=93');
    });

    it('a non-edit tool is ignored', () => {
      expect(runHook({ tool_name: 'Read', tool_input: { file_path: join(toolDir(), 'over.ts') } })).toBe('');
    });

    it('malformed stdin fails open (exit 0, no output)', () => {
      const out = execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8', timeout: 60_000 });
      expect(out.trim()).toBe('');
    });

    it('the embedded --self-test passes', () => {
      const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8', timeout: 60_000 });
      expect(out).toContain('all cases passed');
    });
  });

  describe('scope: only real tool-definition files', () => {
    it.each([
      ['packages/operator-core/lib/agent-tools/loop/status.ts', true],
      ['packages/agent-mcp/src/tools/foo.ts', true],
      ['packages/operator-core/lib/agent-tools/loop/status.test.ts', false],
      ['packages/operator-core/lib/agent-tools/loop/status.d.ts', false],
      ['apps/operator/lib/release/green-checkpoint.ts', false],
      ['papercusp-desktop/src-tauri/sidecar/apps/o/agent-tools/a.ts', false],
      ['packages/operator-core/lib/agent-tools/_retired/old.ts', false],
      ['node_modules/x/agent-tools/y.ts', false],
    ])('%s → %s', async (p, want) => {
      const hook = await loadHook();
      expect(hook.isCandidateFile(p)).toBe(want);
    });
  });

  describe('parsing shapes a regex would get wrong (the reason this is AST-based)', () => {
    it('an escaped quote is ONE character, not two', async () => {
      const hook = await loadHook();
      const [t] = hook.weighToolsInSource(ts, `export default defineTool({ name: 't', description: 'a\\'b' });`);
      expect(t.weight).toBe(3);
    });

    it('adjacent concatenation is summed, not truncated at the first literal', async () => {
      const hook = await loadHook();
      const [t] = hook.weighToolsInSource(ts, `export default defineTool({ name: 't', description: 'abc' + 'de' });`);
      expect(t.weight).toBe(5);
    });

    it('counts when/notWhen/chaining and per-role, but NOT returns/seeAlso', async () => {
      const hook = await loadHook();
      const src = `export default defineTool({ name: 't', description: 'abcde', guidance: {
        when: 'xx', notWhen: 'yyy', chaining: 'z',
        returns: '${'r'.repeat(200)}', seeAlso: '${'s'.repeat(200)}',
        byRole: { su: { when: 'ab', notWhen: 'c' } },
      } });`;
      const [t] = hook.weighToolsInSource(ts, src);
      expect(t.weight).toBe(5 + 2 + 3 + 1 + 2 + 1);
    });

    it('an unmeasurable template literal is SKIPPED, never guessed at', async () => {
      const hook = await loadHook();
      expect(hook.weighToolsInSource(ts, 'export default defineTool({ name: "t", description: `a${x}b` });')).toEqual([]);
    });

    it('an object without a name is not a tool', async () => {
      const hook = await loadHook();
      expect(hook.weighToolsInSource(ts, 'export const x = { description: "abc" };')).toEqual([]);
    });
  });

  describe('violation tiers mirror budgetViolations()', () => {
    const b = { BUDGET, HARD_CAP };
    it('at the budget is not a violation', async () => {
      const hook = await loadHook();
      expect(hook.violationsFor([{ name: 'a', weight: BUDGET }], b)).toEqual([]);
    });
    it('one over the budget is', async () => {
      const hook = await loadHook();
      const [v] = hook.violationsFor([{ name: 'a', weight: BUDGET + 1 }], b);
      expect(v).toMatchObject({ hardCap: false, limit: BUDGET, cutAtLeast: 1 });
    });
    it('over the hard cap switches tier', async () => {
      const hook = await loadHook();
      const [v] = hook.violationsFor([{ name: 'a', weight: HARD_CAP + 1 }], b);
      expect(v).toMatchObject({ hardCap: true, limit: HARD_CAP, cutAtLeast: 1 });
    });
  });
});
