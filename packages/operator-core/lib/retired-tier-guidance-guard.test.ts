/**
 * P-005 / D-006 — current guidance may describe the retired tier historically,
 * but may not prescribe it as an executor. The live-tree assertion makes this an
 * enforcing test, while the fixtures prove both error directions are discriminating.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — untyped .mjs guard helper, imported for its pure detector.
import * as retiredGuidance from '../../../scripts/lib/retired-tier-guidance.mjs';

const {
  ACTIVE_RETIRED_GUIDANCE_FILES,
  ACTIVE_RETIRED_GUIDANCE_ROOTS,
  collectActiveRetiredGuidance,
  findRetiredGuidanceOffenders,
  guidanceTextFor,
} = retiredGuidance;

type PendingRootStatusRow = {
  path: string;
  offenders: number;
  current: number;
  graduated: boolean;
  missing: boolean;
};

const pendingRootStatus = retiredGuidance.pendingRootStatus as (
  repoRoot: string,
) => PendingRootStatusRow[];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('retired-tier current-guidance detector', () => {
  it('flags the measured obsolete template mechanism', () => {
    const source = [
      '# Agent work plane',
      '',
      'The -ops hive is the Queen surveying a backlog and placing member harnesses.',
      'Use Queen/bee dispatch to assign the next unit and wake a Mug supervisor.',
    ].join('\n');
    const findings = findRetiredGuidanceOffenders('templates/example/GUIDE.md', source);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'current-guidance', line: 3, roles: ['queen', 'mug'] });
  });

  it('allows explicit historical, retirement, and refusal accounts', () => {
    const source = [
      'Historical note: the Queen once surveyed the backlog and placed bees.',
      '',
      'The Mug-supervised nursery tier is RETIRED permanently; cup:spawn now refuses.',
      '',
      'Never wake the Kettle or dispatch work to the Mug; use canonical plan promotion instead.',
    ].join('\n');
    expect(findRetiredGuidanceOffenders('history.md', source)).toEqual([]);
  });

  it('does not let a historical preface hide a renewed prescription after an adversative', () => {
    const source = 'The Mug was retired, but use the Mug to dispatch ready work and wake the Kettle.';
    expect(findRetiredGuidanceOffenders('bad.md', source)).toEqual([
      expect.objectContaining({ line: 1, roles: ['mug', 'kettle'] }),
    ]);
  });

  it('ignores homonyms without an execution prescription', () => {
    expect(findRetiredGuidanceOffenders('kitchen.md', 'Choose the current kettle and mug size.')).toEqual([]);
  });

  it('flags a retired role given REVIEW/PROMOTE authority, not just execution (WI-1713506)', () => {
    // The regression: this text prescribes a retired role and contains ZERO execution
    // verbs (no launch/spawn/dispatch/place/schedule), so an execution-only detector
    // passed it. It was stamped into every Blender-routed draft's `## Now`, and a draft
    // sat unreviewed for 1d 13h waiting on a reviewer that cannot exist.
    const source = 'Mug reviews this proposal in the loop: it promotes it to greenlight (ready).';
    expect(findRetiredGuidanceOffenders('prompt.ts', source)).toEqual([
      expect.objectContaining({ line: 1, roles: ['mug'] }),
    ]);
  });

  it('does not accept an incidental "never" as a refusal marker (WI-1723896)', () => {
    // The regression: EXPLICIT_REFUSAL_RE matched a bare `never` ANYWHERE in the segment
    // and exempted the whole thing. This is the real runtime string the scout-draft
    // backstop emitted — two incidental `never`s, neither refusing anything, which bought
    // a live "the Queen was never idle" total silence from the guard.
    const source =
      'Scout-draft review backstop: N draft(s) unreviewed (the plan-review idle activity ' +
      'never ran — the hive has been saturated, so the Queen was never idle). Review each ' +
      'and either promote it (= ready) or deprecate it WITH learnings (never just leave it).';
    expect(findRetiredGuidanceOffenders('watchdog.ts', source)).toEqual([
      expect.objectContaining({ line: 1, roles: ['queen'] }),
    ]);
  });

  it('still exempts a refusal that actually GOVERNS a role or an action', () => {
    // The other direction of the same rule — tightening the marker must not turn genuine
    // refusal prose into noise, or the guard gets baselined and stops being read.
    expect(findRetiredGuidanceOffenders('x.md', 'Never route work to the Mug; it is not a placement target.')).toEqual([]);
    expect(findRetiredGuidanceOffenders('x.md', 'Do not ask the Queen to place this; use su instead.')).toEqual([]);
    expect(findRetiredGuidanceOffenders('x.md', 'The Mug tier is retired and no longer reviews drafts.')).toEqual([]);
  });

  it('beats the naive token-only rule on explicitly historical text', () => {
    const historical = 'The Queen once placed bees; this executor is retired and was replaced.';
    const naiveTokenOnly =
      /\b(?:queen|mug|kettle)\b/i.test(historical) && /\b(?:place|dispatch|wake)/i.test(historical);
    expect(naiveTokenOnly).toBe(true);
    expect(findRetiredGuidanceOffenders('history.md', historical)).toEqual([]);
  });
});

/**
 * WI-1726926 — a role name inside a ROLE-ALLOWLIST ARRAY is an access-control
 * VALUE, not guidance. `kettle` is the LIVE wire id of Overwatch
 * (`overwatch/liveness.ts` pins `OVERWATCH_ROLE = 'kettle'`), so
 * `agentRoles: [...SU_ROLES, 'kettle']` GRANTS a running executor access. Flagging
 * it makes the ~93s gate leg red for correct code and pressures the next engineer
 * to DELETE a live grant to get green — the guard becoming the defect.
 *
 * Measured 2026-08-31: all 6 offenders in `agent-tools/dev` and 3 of 4 in
 * `agent-tools/plans` were this shape, every one correct.
 *
 * The narrowing must not become a hole, so all three directions are pinned here:
 * silenced INSIDE the brackets, still flagged OUTSIDE them, and a calibration case
 * proving the detector fires at all (without it, a detector broken to always-return-
 * empty would pass the first two).
 */
describe('role-ALLOWLIST arrays are access-control data, not guidance', () => {
  const offenders = (file: string, source: string) =>
    findRetiredGuidanceOffenders(file, guidanceTextFor(file, source));

  it('does not flag a live role grant inside an agentRoles allowlist', () => {
    expect(
      offenders('t.ts', `defineTool({ agentRoles: [...SU_ROLES, 'kettle'], description: 'reads a plan schema' });`),
    ).toEqual([]);
    // Multi-line, and an identifier that merely ENDS in ROLES.
    expect(
      offenders(
        't.ts',
        `const ALL_ROLES = [\n  'operator', 'mug', 'architect',\n  'worker', 'kettle',\n] as const;\nrunAll(ALL_ROLES);`,
      ),
    ).toEqual([]);
  });

  it('STILL flags a retired-executor prescription outside the brackets', () => {
    // The whole point: one character past `]` is not exempt.
    expect(
      offenders('t.ts', `defineTool({ agentRoles: ['mug'], description: 'The Mug dispatches work to a bee.' });`).length,
    ).toBeGreaterThan(0);
  });

  it('calibration — the detector still fires on ordinary prose (proves the two above are not vacuous)', () => {
    expect(offenders('t.ts', `const t = 'The Mug reviews this proposal and promotes it.';`).length).toBeGreaterThan(0);
    // A .md file has no code to parse, so the narrowing must not reach it.
    expect(offenders('t.md', `agentRoles: ['mug'] — the Mug dispatches work.`).length).toBeGreaterThan(0);
  });

  it('fails OPEN on an unterminated array rather than exempting the rest of the file', () => {
    expect(offenders('t.ts', `const AGENT_ROLES = ['mug', 'The Mug dispatches work to a bee.`).length).toBeGreaterThan(
      0,
    );
  });

  it('is length-preserving, so reported line numbers stay exact', () => {
    // split('') not [...text]: an astral char (this file family really does contain
    // a 📣) would desync UTF-16 indices from code-point ones and blank the wrong span.
    const source = `const x = 1;\ndefineTool({ agentRoles: ['operator','mug'] });\n// 📣\nconst y = 2;\n`;
    const normalized = guidanceTextFor('t.ts', source);
    expect(normalized).toHaveLength(source.length);
    expect(normalized.split('\n')).toHaveLength(source.split('\n').length);
  });
});

/**
 * WI-1726926 — `red-queen` is a DOMAIN TERM (the arms-race hypothesis the gym's
 * adversarial drills and the learning governor are named after), and `\bqueen\b`
 * matches inside it because the hyphen is a word boundary. Measured 2026-08-31:
 * **256 occurrences** across agent-tools/gym, agent-tools/learning,
 * agent-tools/plans, git-pipeline-position.ts and their tests — not one about the
 * retired role. A collision that common cannot be carried as per-file exemptions;
 * the exemption list would become the corpus.
 */
describe('red-queen is the arms-race term, not the retired role', () => {
  const offenders = (file: string, source: string) =>
    findRetiredGuidanceOffenders(file, guidanceTextFor(file, source));

  it('does not flag red-queen drills, in code OR prose', () => {
    expect(offenders('t.ts', `const d = 'Red-queen drill outcomes — the optimizer runs them.';`)).toEqual([]);
    expect(offenders('t.md', 'Red-queen drills are scheduled and run by the gym.')).toEqual([]);
    expect(offenders('t.md', 'The red queen sandbox workspace dispatches drills.')).toEqual([]);
  });

  it('STILL flags the real role, including right after the word "red"', () => {
    // Calibration + the adjacency case: only `red` IMMEDIATELY before `queen` is the term.
    expect(offenders('t.md', 'The Queen dispatches work to a bee.').length).toBeGreaterThan(0);
    expect(offenders('t.md', 'Mark it red. The Queen dispatches work to a bee.').length).toBeGreaterThan(0);
  });

  it('preserves length and casing so line numbers and neighbouring text survive', () => {
    const source = 'Red-queen and red queen and RED-QUEEN.\n';
    const out = guidanceTextFor('t.md', source);
    expect(out).toHaveLength(source.length);
    expect(out.startsWith('Red-')).toBe(true);
    expect(out).toContain('RED-');
  });
});

/**
 * WI-1726926 — a MODULE SPECIFIER is a file path, not a claim about who does the
 * work, and here the guard was flagging the very import that PROVES a tool is
 * retired.
 *
 * `stripCommentsOnly` keeps code, so a contiguous import block is ONE segment,
 * and that block supplies both halves of the offence from two unrelated paths:
 * `'../_mug-kettle-gate'` matches ROLE_RE via `-kettle-` (hyphen = word boundary,
 * exactly as in `red-queen`), and a sibling `'../../pot/wake'` matches
 * EXECUTION_RE via `wake`. Measured 2026-08-31: 6 of the 27 remaining
 * pot/fleet/deploy offenders were import blocks, and FIVE of the six imported
 * `refuseIfMugKettleRetired` / `MUG_KETTLE_RETIRED_ERROR` — the gate was red
 * because those tools correctly REFUSE while the tier is retired. No prose exists
 * to repair at those sites; the only edit that greens them is renaming a live
 * module, which is a booby trap rather than a fix.
 */
describe('module specifiers are paths, not guidance', () => {
  const offenders = (file: string, source: string) =>
    findRetiredGuidanceOffenders(file, guidanceTextFor(file, source));

  it('does not flag an import block that names the retirement gate it calls', () => {
    // The exact measured shape: role word and execution verb from two different paths.
    expect(
      offenders(
        't.ts',
        `import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';\nimport { resolvePotHomeSlug } from '../../pot/wake';\n`,
      ),
    ).toEqual([]);
    expect(
      offenders('t.ts', `import { mugWakeEfficiency } from '../../pot/mug-wake-efficiency';\n`),
    ).toEqual([]);
    expect(offenders('t.ts', `const g = require('../_mug-kettle-gate');\nconst w = require('../pot/wake');\n`)).toEqual(
      [],
    );
  });

  it('STILL flags a real prescription that merely mentions a path', () => {
    // The pass must not become a prose escape hatch: only the quoted specifier is blanked.
    expect(
      offenders('t.ts', `const s = 'the Mug dispatches work, see ../_mug-kettle-gate';`).length,
    ).toBeGreaterThan(0);
  });

  it('does not reach a quoted string containing whitespace (prose, and SQL FROM)', () => {
    // A specifier has no spaces; that is what keeps ordinary sentences out of reach.
    expect(offenders('t.ts', `const q = 'SELECT x FROM the Mug that dispatches work';`).length).toBeGreaterThan(0);
  });

  it('calibration — the detector still fires on ordinary prose (proves the above are not vacuous)', () => {
    expect(offenders('t.ts', `const d = 'The Mug dispatches work to a bee.';`).length).toBeGreaterThan(0);
  });

  it('is length-preserving, so reported line numbers stay exact', () => {
    const source = `import { a } from '../_mug-kettle-gate';\nconst d = 'The Mug dispatches work.';\n`;
    const out = guidanceTextFor('t.ts', source);
    expect(out).toHaveLength(source.length);
    // The surviving offender is still reported on line 2, not line 1.
    expect(offenders('t.ts', source).map((o) => o.line)).toEqual([2]);
  });
});

describe('retired-tier current-guidance live verdict', () => {
  it('scans every canonical active root and the canonical su prompt with zero exemptions-by-baseline', () => {
    const result = collectActiveRetiredGuidance(REPO_ROOT);
    expect(result.missingPaths).toEqual([]);
    expect(result.readErrors).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(ACTIVE_RETIRED_GUIDANCE_FILES.length);
    expect(result.offenders).toEqual([]);

    const scanned = new Set(
      [...ACTIVE_RETIRED_GUIDANCE_ROOTS, ...ACTIVE_RETIRED_GUIDANCE_FILES].map((entry) =>
        entry.split(path.sep).join('/'),
      ),
    );
    expect(scanned).toEqual(
      new Set([
        'templates/papercusp-app',
        'templates/papercusp-ops-pots',
        // WI-1713506: agent-facing guidance is not only .md. The Scout/Blender rails
        // BUILD prompt text in TypeScript, and leaving them outside this corpus is why
        // "Mug reviews this proposal" survived the Mug's retirement and stranded a
        // routed draft for 1d 13h with no reviewer that could exist.
        'packages/operator-core/lib/scout',
        'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
        // WI-1726926: the same reasoning, applied to the three highest-blast-radius
        // prompt BUILDERS. `deriveLaunchPromptText` composes the routing-gate kickoff
        // and is consumed by plans/launch.ts, bootstrap-su AND carry-respawn, so its
        // text reaches essentially every su; the other two compose the launch/respawn
        // context around it. Admitted only after each measured ZERO offenders — this
        // family has no baseline, so a dirty path turns the gate red on arrival.
        //
        // Until 2026-08-31 the routing gate offered "(B) hand it to the Mug" in both
        // profiles — a recipient no agent could reach — and it outlived the tier's
        // whole retirement precisely because nothing scanned this file
        // (EI-21972876172423322).
        'packages/operator-core/lib/agent-tools/plans/launch-prompt.ts',
        'packages/operator-core/lib/carry-respawn.ts',
        'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts',
        // WI-1756049: the tool CATALOG is agent-facing guidance too — a tool's
        // `description` + `guidance.{when,notWhen,chaining}` are injected into the MCP
        // catalog of every agent carrying it. All 8 tools in these two dirs used to
        // attribute themselves to the retired Mug ("Log the Mug's disposition…",
        // `when: "You are the Mug and you've DECIDED…"`) while the live callers are
        // operator/su (29 + 3 invocations by role 'operator'; zero by 'mug'), and the
        // su playbook simultaneously directs su to autonomy:record_disposition.
        //
        // ⚠ decide.ts legitimately still names `kettle`: OVERWATCH_ROLE === "kettle"
        // is LIVE Overwatch's wire id, not tier residue. Do not "correct" it.
        //
        // The WHOLE catalog is admitted, minus ACTIVE_RETIRED_GUIDANCE_PENDING, so a
        // NEW tool directory is in the corpus by DEFAULT rather than outside it until
        // remembered — the allow-list shape is what let the routing gate keep offering
        // a retired recipient for the tier's entire retirement.
        'packages/operator-core/lib/agent-tools',
      ]),
    );
  });
});

describe('the single-file view agrees with the corpus verdict', () => {
  // WI-1726926. `findRetiredGuidanceOffenders` takes ALREADY-NORMALIZED text. The
  // guard's own --check path used to pass raw source, so it scanned comments the
  // corpus scan strips — and reported offenders on files the gate calls clean
  // (measured: launch-prompt.ts 1 vs 0, decide.ts 2 vs 0). That is a false alarm
  // aimed squarely at whoever is verifying their own fix, and it is the same
  // mistake that made a census report 1,325 offenders against a real 382.
  it('normalized and raw scans differ on real files — so the normalization is load-bearing, not decorative', () => {
    const rel = 'packages/operator-core/lib/agent-tools/plans/launch-prompt.ts';
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

    // Positive control: this file DOES carry a historical mention, in a comment.
    expect(findRetiredGuidanceOffenders(rel, source).length).toBeGreaterThan(0);
    // The corpus verdict — the one the gate acts on — is clean.
    expect(findRetiredGuidanceOffenders(rel, guidanceTextFor(rel, source))).toEqual([]);
  });

  it('guidanceTextFor is what reconciles them, for every file the corpus scans', () => {
    // Whole-corpus form of the assertion above: the gate is green, so every scanned
    // file must read clean THROUGH the normalization. If a caller ever reintroduces a
    // raw-source scan, this is the contract it violates.
    const result = collectActiveRetiredGuidance(REPO_ROOT);
    expect(result.offenders).toEqual([]);
  });
});

describe('retired-tier guidance pending backlog cannot rot', () => {
  // WI-1726926. ACTIVE_RETIRED_GUIDANCE_PENDING excludes directories that are not
  // clean YET, so the corpus could be widened without red-pinning the gate. The
  // failure mode of every such list is that it stops being read: a directory gets
  // cleaned and its entry stays, silently excluding a now-clean path forever.
  //
  // These assertions make that unreachable. Cleaning a directory FAILS this test
  // until its entry is deleted, and deleting the entry is what admits it.
  it('every pending directory still has offenders — a clean one must be promoted, not left excluded', () => {
    const graduated = pendingRootStatus(REPO_ROOT).filter((row: PendingRootStatusRow) => row.graduated);
    expect(
      graduated.map((row) => row.path),
      'These directories are now CLEAN. Delete their ACTIVE_RETIRED_GUIDANCE_PENDING ' +
        'entries to admit them to the corpus — that is the promotion step, and leaving ' +
        'them listed would exclude a clean path indefinitely.',
    ).toEqual([]);
  });

  it('no pending entry points at a path that no longer exists', () => {
    const missing = pendingRootStatus(REPO_ROOT).filter((row: PendingRootStatusRow) => row.missing);
    expect(
      missing.map((row) => row.path),
      'A stale pending entry guards nothing while looking like it does. Remove it.',
    ).toEqual([]);
  });

  it('each pending entry records the offender count it actually holds', () => {
    // The counts are the visible DEBT. If they drift, the list reads as authoritative
    // while being wrong about the size of the remaining work.
    const drifted = pendingRootStatus(REPO_ROOT)
      .filter((row: PendingRootStatusRow) => !row.missing && row.current !== row.offenders)
      .map((row: PendingRootStatusRow) => `${row.path}: recorded ${row.offenders}, actual ${row.current}`);
    expect(drifted).toEqual([]);
  });
});
