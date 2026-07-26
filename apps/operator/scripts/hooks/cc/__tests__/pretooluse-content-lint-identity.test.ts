/**
 * pretooluse-content-lint-identity.test.ts — the edit-time identity-leak advisory
 * (EI-18670296139788697) and the two-form matcher behind it (EI-18670349543629060).
 *
 * WHY THIS SUITE EXISTS
 * A named owner-provenance tag in shipped source reds the green-checkpoint's
 * lint:identity-leak leg the tick it lands and freezes `main` for the entire fleet —
 * 4h10m with 41 commits buffered on 2026-07-26, caused by 20 findings across 10 files.
 * The advisory in pretooluse-content-lint.mjs moves that feedback to the author's own
 * turn. Two properties have to hold or it makes things WORSE, so both are pinned here:
 *
 *   1. IT MUST AGREE WITH THE GATE. The hook and scripts/check-no-owner-name-tags.mjs
 *      import the SAME detector. If the advisory stayed silent on something the gate
 *      rejects, an author would trust it and still freeze `main`.
 *   2. IT MUST NEVER BLOCK, AND NEVER NAG ON CARRY SURFACES. A false positive here
 *      would wedge every agent's edits fleet-wide; nagging on work items / plans /
 *      .papercusp (where the NAMED form is correct) teaches agents to ignore it.
 *
 * WHY THE FIXTURES ARE ASSEMBLED FROM FRAGMENTS — READ BEFORE "TIDYING" THEM
 * This file is tracked source, so it is scanned by the very lint under test. A fixture
 * written as a literal named tag therefore FAILS THE GATE and freezes `main` — this
 * suite would become the outage it exists to prevent. Writing the first draft with
 * literal fixtures produced exactly that: 11 findings, latent and invisible, because
 * check-no-owner-name-tags.mjs scans `git ls-files` and a brand-new file is UNTRACKED —
 * the lint reported clean right up until the commit that tracked it would have red-ed
 * the gate. (That blind spot is itself the reason the edit-time hook checks the incoming
 * edit rather than the tracked tree: it does not care whether the file is tracked yet.)
 *
 * So the name lives in NAME, built by concatenation, and every fixture interpolates it.
 * `[owner:${NAME}` does not match the matcher — the character after the colon is `$`,
 * not a letter — while the string the detector actually receives at runtime is the real
 * leak. Keep it this way: inlining NAME re-arms the trap.
 *
 * `Quillon` is fictional and deliberately NOT in PLACEHOLDER_NAMES, so it must be
 * DETECTED; `Jane` IS a placeholder, so it must be IGNORED. Never substitute a real
 * contributor's name for either.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runHookProcess } from './spawn-hook';

// __tests__ -> cc -> hooks -> scripts -> operator -> apps -> <repo root>
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const HOOK = join(__dirname, '..', 'pretooluse-content-lint.mjs');
const DETECTOR = join(REPO_ROOT, 'scripts', 'lib', 'identity-leak-patterns.mjs');

/** Split so this file never contains a literal named tag — see the header. */
const NAME = `Quill${'on'}`;

type Leak = { line: number; name: string; form: 'bracket' | 'paren'; text: string };
interface Detector {
  findOwnerNameLeaks(text: string): Leak[];
  isSkippedPath(file: string): boolean;
  renderLeak(f: Leak): string;
  FIX_HINT: string;
}
const loadDetector = (): Promise<Detector> => import(DETECTOR) as Promise<Detector>;

/** Run the hook with a synthetic PreToolUse payload and return its advisory text (or ''). */
async function runHook(
  toolInput: Record<string, unknown>,
  tool = 'Edit',
): Promise<{ text: string; status: number | null }> {
  const res = await runHookProcess(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput }),
    env: process.env,
  });
  let text = '';
  if (res.stdout.trim()) {
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop() as string);
    text = parsed?.hookSpecificOutput?.additionalContext ?? '';
  }
  return { text, status: res.status };
}

const repoFile = (rel: string) => join(REPO_ROOT, rel);
const SRC = 'packages/operator-core/lib/automation/pane-categories.ts';

describe('identity-leak detector (shared by the gate lint and the edit-time hook)', () => {
  it('catches the BRACKET form the gate always caught', async () => {
    const { findOwnerNameLeaks } = await loadDetector();
    const hits = findOwnerNameLeaks(`[owner:${NAME} 2026-07-25] scope directive`);
    expect(hits.map((h) => [h.form, h.name])).toEqual([['bracket', NAME]]);
  });

  // EI-18670349543629060: three of the 11 leaks that froze `main` were this form and
  // the bracket-only matcher saw none of them.
  it.each([
    ['OWNER RULE', ` * OWNER RULE (${NAME}, 2026-07-25): "in the ask fleet section"`],
    ['OWNER MANDATE', ` * OWNER MANDATE (${NAME}, 2026-07-25, verbatim): "WE NEED ALL"`],
    ['no date', ` * OWNER ASK (${NAME}): "do it"`],
  ])('catches the PARENTHETICAL form (%s)', async (_label, line) => {
    const { findOwnerNameLeaks } = await loadDetector();
    const hits = findOwnerNameLeaks(line);
    expect(hits.map((h) => [h.form, h.name])).toEqual([['paren', NAME]]);
  });

  // Each of these can sit in an attribution slot. A false positive here would wedge
  // edits fleet-wide, which is why the paren matcher requires a Capitalized, digit-free
  // token in a terminated attribution position rather than hunting bare names.
  it.each([
    ['sanctioned tier-only tag', '[owner 2026-07-13] no name here'],
    ['sanctioned bare date', '[owner:2026-07-13] no name'],
    ['placeholder name', '[owner:Jane 2026-07-13] fixture'],
    ['peer session id', '[peer:su-707029ce] a peer'],
    ['sanctioned paren form', 'OWNER MANDATE (2026-07-25): "no name"'],
    ['lower-case prose', 'OWNER RULE (see the docs for detail)'],
    ['work-item ref', 'OWNER DECISION (WI-5811, 2026-07-25)'],
    ['session id in paren', 'OWNER RULE (su-707029ce, 2026-07-25)'],
    ['ownerId identifier noise', 'const ownerId = ctx.ownerId; // owner asks (many) things'],
  ])('does NOT flag %s', async (_label, line) => {
    const { findOwnerNameLeaks } = await loadDetector();
    expect(findOwnerNameLeaks(line)).toEqual([]);
  });

  // The suite's own fixtures depend on this: interpolation must defeat the matcher, or
  // the header's whole scheme is void and this file silently re-arms the gate trap.
  it('does NOT flag the interpolated form this file uses for its own fixtures', async () => {
    const { findOwnerNameLeaks } = await loadDetector();
    expect(findOwnerNameLeaks('const s = `[owner:${NAME} 2026-07-25]`;')).toEqual([]);
    expect(findOwnerNameLeaks('const s = ` * OWNER MANDATE (${NAME}, 2026-07-25)`;')).toEqual([]);
  });

  it('treats carry surfaces as out of scope, where the NAMED form is correct', async () => {
    const { isSkippedPath } = await loadDetector();
    for (const p of ['docs/plans/x.md', '.papercusp/state/x.md', 'agent-briefs/x.md']) {
      expect(isSkippedPath(p), p).toBe(true);
    }
    expect(isSkippedPath(SRC)).toBe(false);
  });
});

describe('pretooluse-content-lint hook — edit-time identity advisory', () => {
  it('warns on a parenthetical leak in shipped source', async () => {
    const { text, status } = await runHook({
      file_path: repoFile(SRC),
      new_string: ` * OWNER MANDATE (${NAME}, 2026-07-25, verbatim): "WE NEED ALL ROUTINES"`,
    });
    expect(text).toContain('identity-leak');
    expect(text).toContain(NAME);
    expect(text).toContain('FIX:');
    expect(status).toBe(0); // advisory, never a block
  });

  it('warns on a bracket leak in a non-.ts file (the curly-quote rule is .ts-only, this is not)', async () => {
    const { text } = await runHook(
      { file_path: repoFile('docs/briefs/some-brief.md'), content: `[owner:${NAME} 2026-07-25] directive` },
      'Write',
    );
    expect(text).toContain('identity-leak');
  });

  it('reports every leak in a MultiEdit, not just the first', async () => {
    const { text } = await runHook(
      {
        file_path: repoFile(SRC),
        edits: [
          { new_string: `[owner:${NAME} 2026-07-25] one` },
          { new_string: ` * OWNER RULE (${NAME}, 2026-07-25): "two"` },
        ],
      },
      'MultiEdit',
    );
    expect(text).toMatch(/2 named owner-provenance tag/);
  });

  it.each([
    ['docs/plans (carry surface)', 'docs/plans/some-plan.md'],
    ['.papercusp (carry surface)', '.papercusp/state/notes.md'],
  ])('stays silent on %s', async (_label, rel) => {
    const { text } = await runHook(
      { file_path: repoFile(rel), content: `[owner:${NAME} 2026-07-25] fine here` },
      'Write',
    );
    expect(text).toBe('');
  });

  it('stays silent on a placeholder name', async () => {
    const { text } = await runHook({ file_path: repoFile(SRC), new_string: '[owner:Jane 2026-07-25] fixture' });
    expect(text).toBe('');
  });

  it('stays silent on a clean edit', async () => {
    const { text } = await runHook({ file_path: repoFile(SRC), new_string: 'const ownerId = ctx.ownerId;' });
    expect(text).toBe('');
  });

  // FAIL-OPEN contract: the detector is resolved by walking up from the edited file, so a
  // file outside any repo that has it must be silently allowed, never an error.
  it.each([
    [
      'a file outside any repo',
      { file_path: '/tmp/unrelated-content-lint-probe.ts', content: `[owner:${NAME} 2026-07-25] x` },
      'Write',
    ],
    ['a payload with no file_path', { content: `[owner:${NAME} 2026-07-25] x` }, 'Write'],
    ['an unrelated tool', { file_path: repoFile(SRC) }, 'Read'],
  ] as const)('fails open on %s', async (_label, input, tool) => {
    const { text, status } = await runHook(input as Record<string, unknown>, tool);
    expect(text).toBe('');
    expect(status).toBe(0);
  });

  it('still enforces the original curly-quote rule (no regression from WI-5543)', async () => {
    const { text, status } = await runHook({ file_path: repoFile(SRC), new_string: 'const a = ‘x’;' });
    expect(text).toContain('content-lint');
    expect(text).toContain('curly');
    expect(status).toBe(0);
  });
});
