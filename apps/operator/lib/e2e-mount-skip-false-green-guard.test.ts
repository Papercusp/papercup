/**
 * e2e-mount-skip-false-green-guard.test.ts — no Playwright spec may turn a
 * FAILED SPA/dock/shell mount into `test.skip()` (EI-19917451944474469).
 *
 * ## What the guard is for
 *
 * `test.skip()` exits the process with status 0. To anything reading only the
 * exit code — CI, a wrapper script, or an agent claiming "e2e green" — that is
 * indistinguishable from a genuine pass. So a spec that skips when the shell
 * did not mount does not merely fail to test: it LAUNDERS a real regression
 * into a green checkmark. EI-19917451944474469 was filed by an agent who came
 * one step from recording "e2e green" off a run whose entire output was
 * `1 skipped` + exit 0.
 *
 * The sanctioned form is `assertMounted(mounted, context)` from `../e2e/_egress`,
 * which throws. Same class as the zero-work false greens already closed for
 * `tsc -p .`, `test:affected`, and `test:file -t <no match>`.
 *
 * ## What is NOT this class
 *
 * A skip describing a FIXTURE or CREDENTIAL that legitimately may not exist —
 * "no superuser token, can't auth /api/admin/*", "zero plans exist in this
 * workspace", "PG unavailable in this env" — is correct as `test.skip()`. Those
 * conditions are properties of the environment the test was pointed at, not
 * evidence that the thing under test is broken. The predicate below is
 * deliberately narrow so it never argues with them; the known-negative controls
 * pin that narrowness in place.
 *
 * ## Why the controls below are PERMANENT
 *
 * The directory scan runs green today, which proves only the no-false-positive
 * direction. A guard that has only ever passed is a guard nobody has tested: if
 * the predicate silently stopped matching, the scan would keep printing ✔ while
 * the mount-skips crept back — the same "detector cannot see its subject"
 * failure the guard exists to prevent, one level up. The known-positive
 * fixtures therefore live here forever, as literal source text taken from the
 * sites this guard was written to kill, rather than being produced by mutating
 * a real spec. That also sidesteps the repo's mutation hazards entirely: no
 * in-tree mutation means no git-sync sweep race and no restore needed (see
 * CLAUDE.md § "Proving a guard is falsifiable").
 *
 * ## Why this lives in apps/operator (@papercusp/web)
 *
 * `test:affected` selects suites by WORKSPACE, so a guard only protects the
 * paths whose workspace selects it (the guard-enforcement trap, WI-9434/D-034).
 * Every path this scans — `apps/operator/e2e/**` — is inside @papercusp/web, so
 * editing any guarded spec selects this suite by construction. There is no
 * cross-workspace residue here, which is why this needs no `lint:` CLI leg.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const E2E_DIR = resolve(import.meta.dirname, '../e2e');

/**
 * Indicators that a `test.skip(...)` is gating on a MOUNT/RENDER precondition.
 * Matched against the call's full argument text (condition AND message), because
 * the tell lives on whichever side the spec happened to put it: a `!mounted`
 * condition, a `SKIP_MSG_BLANK` message constant, or prose naming the failure.
 *
 * Deliberately does NOT match the word "render" on its own — a legitimate
 * fixture skip reads "no non-legacy plan with items exists — item rendering has
 * no fixture", and flagging that would make the guard argue with the exact
 * carve-out `assertMounted`'s own docstring grants.
 */
const MOUNT_INDICATORS: readonly RegExp[] = [
  /\bmounted\b/i,
  /\bMounts?\s*\(/,
  /\bSKIP_MSG_BLANK\b/,
  /did\s?not\s+mount|failed\s+to\s+mount|didn't\s+mount/i,
  /===\s*['"]blank['"]/,
  /#root/,
];

export interface MountSkip {
  /** The full `test.skip(...)` argument text, as written. */
  args: string;
  /** 1-indexed line of the `test.skip(` token. */
  line: number;
}

/**
 * Find `test.skip(...)` call sites that gate on a mount precondition.
 *
 * Scans by paren-matching rather than by line regex: the sites this guard was
 * written to catch include multi-line calls, and two of them survived an earlier
 * single-line-regex migration precisely because a line-oriented pattern could
 * not see them.
 */
export function findMountSkips(src: string): MountSkip[] {
  const hits: MountSkip[] = [];
  const token = 'test.skip(';
  for (let i = src.indexOf(token); i !== -1; i = src.indexOf(token, i + 1)) {
    // Skip occurrences inside a comment line (docstrings reference the pattern).
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const linePrefix = src.slice(lineStart, i).trimStart();
    if (linePrefix.startsWith('*') || linePrefix.startsWith('//')) continue;

    let depth = 0;
    let end = i + token.length - 1;
    for (let j = i + token.length - 1; j < src.length; j++) {
      const ch = src[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    const args = src.slice(i + token.length, end);
    if (MOUNT_INDICATORS.some((re) => re.test(args))) {
      hits.push({ args, line: src.slice(0, i).split('\n').length });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Known-POSITIVE controls — verbatim shapes this guard was built to kill.
 * ------------------------------------------------------------------ */

/** The single-line form: 45 of the 47 real sites looked exactly like this. */
const PLAIN_MOUNT_SKIP = `
  test('opens the dock', async ({ page }) => {
    const mounted = await dockMounts(page);
    test.skip(!mounted, SKIP_MSG);
    await expect(page.locator('.pc-adv-dock')).toBeVisible();
  });
`;

/** The MULTI-LINE form, which a line-oriented pattern cannot see. */
const MULTILINE_MOUNT_SKIP = `
    test.skip(
      !mounted,
      'The /adv shell did not mount the dock. Run against the prebuilt bundle.',
    );
`;

/** The tri-state form: 'blank' means the SPA never rendered. */
const TRISTATE_MOUNT_SKIP = `
    const state = await gotoDesign(page);
    test.skip(state === 'blank', SKIP_MSG);
`;

/** The indirection form: the tell is only in the message constant's name. */
const INDIRECT_MOUNT_SKIP = `
    test.skip(!(await openPage(page)), SKIP_MSG_BLANK);
`;

/* ------------------------------------------------------------------ *
 * Known-NEGATIVE controls — real skips that must stay legal.
 * ------------------------------------------------------------------ */

const LEGIT_SKIPS = `
    test.skip(!SU_TOKEN, 'no superuser token — cannot auth /api/admin/*');
    test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    test.skip(plans.length === 0, 'zero plans exist in this workspace — no plan detail to open');
    test.skip(!plan, 'no non-legacy plan with items exists — item rendering has no fixture');
    test.skip(true, 'PG unavailable in this env; UI signup flow requires PG');
    test.skip(originalConfig == null, 'agent-config API unreachable');
    test.skip(!projectsReachable, '/api/harness/projects/lite unreachable — cannot resolve a harness slug');
`;

/** The sanctioned replacement must not itself be flagged. */
const SANCTIONED_FORM = `
    const mounted = await dockMounts(page);
    assertMounted(mounted, MOUNT_FAIL_MSG);
`;

describe('e2e mount-skip guard — predicate (known-positive controls)', () => {
  it('FLAGS the single-line !mounted skip', () => {
    expect(findMountSkips(PLAIN_MOUNT_SKIP)).toHaveLength(1);
  });

  it('FLAGS the multi-line skip a line-regex misses', () => {
    const hits = findMountSkips(MULTILINE_MOUNT_SKIP);
    expect(hits).toHaveLength(1);
    expect(hits[0].args).toContain('did not mount');
  });

  it("FLAGS the tri-state state === 'blank' skip", () => {
    expect(findMountSkips(TRISTATE_MOUNT_SKIP)).toHaveLength(1);
  });

  it('FLAGS a skip whose only tell is the SKIP_MSG_BLANK constant', () => {
    expect(findMountSkips(INDIRECT_MOUNT_SKIP)).toHaveLength(1);
  });
});

describe('e2e mount-skip guard — predicate (known-negative controls)', () => {
  it('does NOT flag fixture/credential/environment skips', () => {
    expect(findMountSkips(LEGIT_SKIPS)).toEqual([]);
  });

  it('does NOT flag the sanctioned assertMounted form', () => {
    expect(findMountSkips(SANCTIONED_FORM)).toEqual([]);
  });

  it('does NOT flag the pattern quoted inside a doc comment', () => {
    const src = ` * to \`test.skip(!mounted, SKIP_MSG)\`, which exits 0 and reads as a pass.\n`;
    expect(findMountSkips(src)).toEqual([]);
  });
});

describe('e2e mount-skip guard — the real spec directory', () => {
  const specs = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'));

  it('scans a non-empty population (the scan itself is falsifiable)', () => {
    // A guard whose glob silently matched nothing would pass forever. Pin the
    // instrument, not just the verdict: an absence claim needs a positive
    // control (CLAUDE.md § grep false-absence).
    expect(specs.length).toBeGreaterThan(10);
  });

  it('has ZERO mount-preconditioned test.skip() sites', () => {
    const offenders: string[] = [];
    for (const file of specs) {
      const src = readFileSync(resolve(E2E_DIR, file), 'utf8');
      for (const hit of findMountSkips(src)) {
        offenders.push(`${file}:${hit.line}  test.skip(${hit.args.trim().slice(0, 90)}…`);
      }
    }
    expect(
      offenders,
      `A mount/render failure must be LOUD, not a skip — test.skip() exits 0 and reads as a ` +
        `pass (EI-19917451944474469). Use assertMounted(mounted, context) from ./_egress ` +
        `instead. Offending sites:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
