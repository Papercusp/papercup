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
 *
 * THE SAME RULE NOW APPLIES TO TWO MORE CLASSES (EI-18759401203875869). The hook grew from one
 * identity class to three, and each new class's fixtures are self-referential in the same way:
 *
 *   - CLASS 2 (hardcoded home paths) — a literal `/home/<user>/…` in this file fails
 *     lint:no-box-identity. So `HOME`/`MUNGED`/`USER_SEG` below are assembled at runtime, exactly
 *     like `NAME`. Inlining any of them re-arms the trap.
 *   - CLASS 3 (bare box-identity literals) — a fixture CANNOT spell this box's git name, email,
 *     hostname or OS account without failing lint:no-identity-literals. Two consequences, both
 *     deliberate: the detector-level tests pass SYNTHETIC literals (which is why
 *     `findIdentityLiterals` takes them as a parameter instead of resolving internally), and the
 *     one hook-level test that must use a REAL literal reads it from the environment at run time
 *     and never writes it down. On a bare/CI box where nothing resolves, that test skips — the
 *     same documented no-op the gate lint has.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHookProcess } from './spawn-hook';

// __tests__ -> cc -> hooks -> scripts -> operator -> apps -> <repo root>
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const HOOK = join(__dirname, '..', 'pretooluse-content-lint.mjs');
const DETECTOR = join(REPO_ROOT, 'scripts', 'lib', 'identity-leak-patterns.mjs');

/** Split so this file never contains a literal named tag — see the header. */
const NAME = `Quill${'on'}`;

/** Split so this file never contains a literal home path / munged home path — see the header. */
const HOME = `/ho${'me'}`;
const MUNGED = `-ho${'me'}`;
const USER_SEG = `quill${'on'}`;

/** The gate's OWN identity-lint family list, so a fourth class cannot be added there without
 *  being given edit-time coverage here.
 *
 *  ⚠ This USED to scrape `{ script: '…', label: '…' }` from the whole gate file on the stated
 *  assumption that the shape "is unique to that block". It is not, and was not guaranteed to
 *  stay so: agent-state-plane-verification P-020 added a SECOND family in exactly that shape
 *  (`lint:plane-producers`, `lint:declared-consumed`, `lint:no-bespoke-state-read`,
 *  `lint:plane-ratchet`, `lint:plane-guards`), the unscoped scrape swallowed all five, and this
 *  suite reded the release gate for the whole fleet over a change that had nothing to do with
 *  identity. P-005 later folded the identity jobs into the bounded `lowMemoryLintSpecs` table,
 *  so anchor to that canonical table and select only entries whose `outcomeKey` is
 *  `lintIdentity`. */
const GATE = join(REPO_ROOT, 'apps', 'operator', 'lib', 'release', 'green-checkpoint.ts');
function gateIdentityLints(): string[] {
  const src = readFileSync(GATE, 'utf8');
  const block = src.match(
    /const lowMemoryLintSpecs:[^=]*=\s*\[([\s\S]*?)\n\s*\];\s*\n\s*const lowMemoryOutcomeKeys:/,
  );
  // Throw rather than fall back to a whole-file scrape or an empty list: if the gate renames
  // or restructures that table, the honest outcome is a loud failure here, not a silently
  // vacuous assertion that green-lights an identity class with no edit-time coverage.
  if (!block) {
    throw new Error(
      'green-checkpoint.ts: could not locate the `lowMemoryLintSpecs` table — this suite can no longer ' +
        'tell which lints are the identity family. Re-anchor gateIdentityLints() to its new shape.',
    );
  }
  const identityScripts = [...block[1]!.matchAll(/\{([\s\S]*?)\n\s*\},?/g)]
    .map((entry) => entry[1]!)
    .filter((entry) => /outcomeKey:\s*["']lintIdentity["']/.test(entry))
    .map((entry) => entry.match(/script:\s*["'](lint:[^"']+)["']/)?.[1])
    .filter((script): script is string => Boolean(script));
  if (identityScripts.length === 0) {
    throw new Error(
      'green-checkpoint.ts: `lowMemoryLintSpecs` contains no parseable `lintIdentity` members — ' +
        'this suite would otherwise green-light an identity class with no edit-time coverage.',
    );
  }
  return identityScripts;
}

type Leak = { line: number; name: string; form: 'bracket' | 'paren'; text: string };
type PathLeak = { line: number; user: string; text: string };
type LiteralLeak = { line: number; key: string; text: string };
interface Detector {
  findOwnerNameLeaks(text: string): Leak[];
  findBoxIdentityPaths(text: string): PathLeak[];
  findIdentityLiterals(
    text: string,
    entries: [string, string][],
    opts?: { vendor?: boolean },
  ): LiteralLeak[];
  resolveIdentityLiteralScopes(): {
    box: Record<string, string>;
    owner: Record<string, string>;
    all: Record<string, string>;
  };
  isSidecarCopiedIdentityPath(file: string): boolean;
  isSkippedPath(file: string): boolean;
  isSkippedPathForIdentityLiterals(file: string): boolean;
  renderLeak(f: Leak): string;
  FIX_HINT: string;
  BOX_IDENTITY_FIX_HINT: string;
  IDENTITY_LITERAL_FIX_HINT: string;
}
const loadDetector = (): Promise<Detector> => import(DETECTOR) as Promise<Detector>;

/** Run the hook with a synthetic PreToolUse payload and return its advisory text (or ''). */
async function runHook(
  toolInput: Record<string, unknown>,
  tool = "Edit",
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string; status: number | null }> {
  const res = await runHookProcess(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput }),
    env,
  });
  let text = "";
  if (res.stdout.trim()) {
    const parsed = JSON.parse(res.stdout.trim().split("\n").pop() as string);
    text = parsed?.hookSpecificOutput?.additionalContext ?? "";
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

describe('class 2 — hardcoded home paths (detector shared with check-no-box-identity.mjs)', () => {
  it('catches the slash form and the slash-munged form', async () => {
    const { findBoxIdentityPaths } = await loadDetector();
    const slash = findBoxIdentityPaths(`const p = '${HOME}/${USER_SEG}/CLAUDE.md';`);
    expect(slash.map((h) => h.user)).toEqual([USER_SEG]);
    const munged = findBoxIdentityPaths(`let dir = "${MUNGED}-${USER_SEG}-papercusp";`);
    expect(munged.map((h) => h.user)).toEqual([USER_SEG]);
  });

  // A false positive here would nag on every edit until agents ignored the advisory, so the
  // negatives matter as much as the positives.
  it.each([
    ['a CI / shared-install account', `${HOME}/runner/x`],
    ['a file that merely lives in /home', `${HOME}/instructions.txt`],
    ['a 1-2 char stand-in that names nobody', `${HOME}/ab/x`],
    ['a placeholder ending a sentence', `see ${HOME}/jdoe.`],
    ['ordinary kebab-case prose', 'className="some-home-page-header"'],
  ])('does NOT flag %s', async (_label, line) => {
    const { findBoxIdentityPaths } = await loadDetector();
    expect(findBoxIdentityPaths(line)).toEqual([]);
  });
});

describe('class 3 — bare box-identity literals (detector shared with check-no-identity-literals.mjs)', () => {
  /** SYNTHETIC literals — see the header: a fixture cannot spell this box's real identity. */
  const SYNTH: [string, string][] = [
    ['build-git-email', 'quil@example.test'],
    ['build-git-name', 'Quil'],
  ];
  const SHORT: [string, string][] = [['build-git-name', 'Quil']];

  it('catches a high-entropy literal anywhere in the line', async () => {
    const { findIdentityLiterals } = await loadDetector();
    const hits = findIdentityLiterals('// ping quil@example.test about the build box', SYNTH);
    expect(hits.map((h) => h.key)).toEqual(['build-git-email']);
  });

  // needs_word_boundary(), ported from the release audit: a short literal matched loosely
  // drowns in false positives (a file extension, a longer proper noun, vendored lexicons).
  it('matches a SHORT literal only as a whole word, and case-sensitively', async () => {
    const { findIdentityLiterals } = await loadDetector();
    expect(findIdentityLiterals('a note from Quil here', SHORT).map((h) => h.key)).toEqual([
      'build-git-name',
    ]);
    expect(findIdentityLiterals('a note from Quillon here', SHORT)).toEqual([]);
    expect(findIdentityLiterals('a note from quil here', SHORT)).toEqual([]);
  });

  // is_vendor(): a bare short name is not vendor's fault to carry, but a high-entropy literal
  // there DOES mean our own build baked it in.
  it('scopes low-entropy literals out of vendored code but keeps hunting high-entropy ones', async () => {
    const { findIdentityLiterals } = await loadDetector();
    expect(findIdentityLiterals('Quil', SHORT, { vendor: true })).toEqual([]);
    expect(
      findIdentityLiterals('quil@example.test', SYNTH, { vendor: true }).map((h) => h.key),
    ).toEqual(['build-git-email']);
  });

  it('is a no-op when no identity resolves (the documented bare / CI-box behaviour)', async () => {
    const { findIdentityLiterals } = await loadDetector();
    expect(findIdentityLiterals('anything at all', [])).toEqual([]);
  });

  // This class hunts BARE literals with no structural anchor, so it deliberately polices a wider
  // path set than its siblings: a scratch artifact that RECORDS a past leak as data is not a leak.
  it('polices a WIDER path set than classes 1-2', async () => {
    const { isSkippedPath, isSkippedPathForIdentityLiterals } = await loadDetector();
    expect(isSkippedPathForIdentityLiterals('scratchpad/lexicon-audit-dump.md')).toBe(true);
    expect(isSkippedPath('scratchpad/lexicon-audit-dump.md')).toBe(false);
    expect(isSkippedPathForIdentityLiterals(SRC)).toBe(false);
  });
});

/**
 * EI-18759401203875869 — THE RECURRENCE GUARD.
 *
 * The bug: all three identity lints were reachable ONLY from the green-checkpoint gate
 * (green-checkpoint.ts) and CI (.github/workflows/test.yml). A one-word doc edit therefore red-ed
 * the whole fleet's gate ~20 minutes later with zero local feedback — five consecutive reds and 60
 * stranded commits, with 40,469 tests passing. `green-checkpoint-real-deps.test.ts` already asserts
 * the GATE end of the wiring; this suite asserts the EDIT-TIME end, which is what was missing.
 *
 * Add a fourth identity lint to the gate and this suite fails until it also has a hook probe.
 */
describe('every gate identity class has EDIT-TIME coverage (EI-18759401203875869)', () => {
  const FAMILY: Record<string, { script: string }> = {
    'lint:no-owner-name-tags': { script: 'scripts/check-no-owner-name-tags.mjs' },
    'lint:no-box-identity': { script: 'scripts/check-no-box-identity.mjs' },
    'lint:no-identity-literals': { script: 'scripts/check-no-identity-literals.mjs' },
  };

  it('this suite covers exactly the family the gate enforces — no class left gate-only', () => {
    expect(gateIdentityLints().sort()).toEqual(Object.keys(FAMILY).sort());
  });

  // The property that stops the advisory from green-lighting what the gate rejects. Re-inline a
  // matcher into any gate script and this fails.
  it('each gate lint IMPORTS the shared detector instead of carrying its own copy', () => {
    for (const { script } of Object.values(FAMILY)) {
      const src = readFileSync(join(REPO_ROOT, script), 'utf8');
      expect(src, script).toMatch(
        /from ["']\.\/lib\/identity-leak-patterns\.mjs["']/,
      );
    }
  });

  it('lint:no-box-identity class — warns at edit time on a hardcoded home path', async () => {
    const { text, status } = await runHook({
      file_path: repoFile(SRC),
      new_string: `const p = '${HOME}/${USER_SEG}/CLAUDE.md';`,
    });
    expect(text).toContain('identity-leak');
    expect(text).toContain(USER_SEG);
    expect(status).toBe(0); // advisory, never a block
  });

  it("applies explicit owner literals to the sidecar CC hook copy set only", async () => {
    const syntheticOwner = "SyntheticOwnerForTest";
    const ownerEnv = {
      ...process.env,
      PAPERCUSP_RELEASE_OWNER_NAME: syntheticOwner,
    };
    const copiedHook = await runHook(
      {
        file_path: repoFile(
          "apps/operator/scripts/hooks/cc/posttooluse-proof-stale-nudge.mjs",
        ),
        new_string: `// release order from ${syntheticOwner} #302`,
      },
      "Edit",
      ownerEnv,
    );
    expect(copiedHook.text).toContain("identity-leak");
    expect(copiedHook.text).toContain("build-git-name");
    expect(copiedHook.status).toBe(0); // advisory, never a block

    const ordinarySource = await runHook(
      {
        file_path: repoFile("apps/operator/lib/release/owner-identity-env.ts"),
        new_string: `// release note for ${syntheticOwner}`,
      },
      "Edit",
      ownerEnv,
    );
    expect(ordinarySource.text).toBe("");
  });

  it('reports EVERY class present in one edit, not just the first', async () => {
    const { text } = await runHook({
      file_path: repoFile(SRC),
      new_string: `// [owner:${NAME} 2026-07-25] see '${HOME}/${USER_SEG}/CLAUDE.md'`,
    });
    expect(text).toContain('named owner-provenance tag');
    expect(text).toContain('hardcoded home path');
  });

  it('stays silent on a carry surface for the NEW classes too', async () => {
    const { text } = await runHook(
      { file_path: repoFile('docs/plans/some-plan.md'), content: `path: ${HOME}/${USER_SEG}/x` },
      'Write',
    );
    expect(text).toBe('');
  });
});
