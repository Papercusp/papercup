/**
 * EI-19333354769591247 — the `testing:run` routing row claims a pc-heavy QUEUE
 * BYPASS. This pins that claim to the code that makes it true.
 *
 * WHAT THE ROW NOW SAYS, AND WHY IT IS LOAD-BEARING. `npm run test:file` and
 * `testing:run` reach the SAME router and return the same verdict, so the
 * routing table originally sold the tool on output quality alone (structured
 * failures instead of `2>&1 | tail -60`). Under fleet load that framing is
 * actively misleading: the bash form takes a pc-heavy admission ticket and can
 * queue for tens of minutes — measured 2026-08-02 at 14+ min without starting,
 * with a sibling attempt killed SIGTERM/143 having produced ZERO output, against
 * 1471ms for the identical file list through the tool. An agent who reads only
 * the quality argument concludes the bash form is merely more verbose, and waits.
 *
 * WHY A GUARD RATHER THAN A CAREFUL EDIT. The rendered row lands in CLAUDE.md,
 * which is spliced into every su playbook, so this text is loaded before any
 * agent calls either form. A routing incentive that has quietly stopped being
 * true is worse than none: it is read as measured advice. The claim is also
 * exactly the kind that rots silently — adding `bash scripts/pc-heavy.sh` in
 * front of the tool's spawn, or dropping it from the npm script, changes the
 * answer without touching one word of the prose.
 *
 * FAILS ON DRIFT, NOT ON THE CURRENT ANSWER. If either half of the mechanism
 * legitimately changes, the code pin below fails in the SAME change that changes
 * it, forcing the prose and the code to be corrected together.
 *
 * ⚠ THE WITHHELD HALF IS PINNED TOO. The filing's title pairs `testing:run` with
 * `build:typecheck`, but `build:typecheck` has no queue to bypass: it spawns
 * `npx tsc` directly, the `npx tsc` its row displaces is equally unwrapped, and
 * `npm run lint:tsc` is a bare `node scripts/lint-tsc.mjs`. That absence is
 * asserted here so a later sweep cannot quietly extend the claim to a row where
 * it is false — and so that if `lint:tsc` ever DOES become pc-heavy-wrapped, this
 * fails and the withheld claim gets re-decided on evidence instead of staying
 * withheld out of inertia.
 *
 * ABSENCE ASSERTIONS ARE PAIRED WITH POSITIVE CONTROLS over the same bytes: a
 * moved file, a renamed script or an empty read is otherwise indistinguishable
 * from a genuine absence, and would report this guard as passing while measuring
 * nothing.
 *
 * FALSIFIABILITY. Subject paths are overridable so a pre-fix source can be
 * replayed from git history WITHOUT mutating the shared tree:
 *   scripts/mutation-probe.sh \
 *     --file packages/operator-core/lib/bash-substitution/pairs/tests.ts \
 *     --against-last-without 'pc-heavy admission ticket' \
 *     --positive-control 'tests.router-files' \
 *     --calibration "grep -q 'tests.router-files' {}" \
 *     --test 'DOC_CLAIM_TESTS_PAIRS_PATH={} npm run test:file -- packages/operator-core/lib/doc-claims/testing-run-pc-heavy-bypass.test.ts'
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const TESTS_PAIRS_SRC = process.env.DOC_CLAIM_TESTS_PAIRS_PATH
  ? resolve(process.env.DOC_CLAIM_TESTS_PAIRS_PATH)
  : join(ROOT, 'packages/operator-core/lib/bash-substitution/pairs/tests.ts');

const TESTING_RUN_TOOL = join(ROOT, 'packages/operator-core/lib/agent-tools/testing/run.ts');
const TYPECHECK_TOOL = join(ROOT, 'packages/operator-core/lib/agent-tools/build/typecheck.ts');
const PACKAGE_JSON = join(ROOT, 'package.json');

const read = (path: string): string => readFileSync(path, 'utf8');

/** The npm `scripts` block, read as data rather than grepped out of the raw text. */
function npmScripts(): Record<string, string> {
  const parsed = JSON.parse(read(PACKAGE_JSON)) as { scripts?: Record<string, string> };
  const scripts = parsed.scripts ?? {};
  // Positive control: an empty or reshaped scripts block would make every
  // "does not contain pc-heavy" assertion below vacuously true.
  expect(Object.keys(scripts).length).toBeGreaterThan(20);
  return scripts;
}

describe('EI-19333354769591247 — testing:run is a pc-heavy queue bypass, and the routing row says so', () => {
  it('the bash form it displaces DOES take a pc-heavy admission ticket', () => {
    const scripts = npmScripts();
    expect(scripts['test:file']).toBeDefined();
    expect(scripts['test:file']).toContain('pc-heavy.sh');
    // ...and reaches the same router the tool does, which is what makes the two
    // forms comparable at all. If they ever stop sharing it, the row's premise
    // ("same router, same verdict — only the admission differs") is gone.
    expect(scripts['test:file']).toContain('scripts/test-files.mjs');
  });

  it('testing:run reaches that same router WITHOUT the pc-heavy wrapper', () => {
    const src = read(TESTING_RUN_TOOL);
    // Positive control for the absence assertion that follows.
    expect(src).toContain("'scripts', 'test-files.mjs'");
    expect(src).toContain('process.execPath');
    // The claim itself: no pc-heavy invocation anywhere in the tool's own launch path.
    expect(src).not.toContain('pc-heavy.sh');
  });

  it('the rendered routing row names the queue, not just the output quality', () => {
    const src = read(TESTS_PAIRS_SRC);
    // Positive control: we are reading the intended subject.
    expect(src).toContain("id: 'tests.router-files'");
    // The prose an agent actually reads must state BOTH sides of the mechanism.
    expect(src).toMatch(/pc-heavy admission ticket/);
    expect(src).toMatch(/pc-heavy-wrapped/);
  });

  it('build:typecheck is deliberately NOT sold as a queue bypass, because it is not one', () => {
    const scripts = npmScripts();
    // The bash forms its routing row displaces are equally unwrapped, so there is
    // no queue to bypass. If either of these becomes pc-heavy-wrapped, this fails
    // and the withheld claim is re-decided on evidence.
    expect(scripts['lint:tsc']).toBeDefined();
    expect(scripts['lint:tsc']).not.toContain('pc-heavy.sh');

    const src = read(TYPECHECK_TOOL);
    // Positive control: the tool really does spawn tsc itself...
    expect(src).toContain("spawn('npx', ['tsc'");
    // ...and does so without a pc-heavy wrapper — same posture as the bash form,
    // hence no differential worth routing on.
    expect(src).not.toContain('pc-heavy.sh');
  });
});
