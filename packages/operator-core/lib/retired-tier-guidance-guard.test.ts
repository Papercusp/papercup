/**
 * P-005 / D-006 — current guidance may describe the retired tier historically,
 * but may not prescribe it as an executor. The live-tree assertion makes this an
 * enforcing test, while the fixtures prove both error directions are discriminating.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — untyped .mjs guard helper, imported for its pure detector.
import * as retiredGuidance from '../../../scripts/lib/retired-tier-guidance.mjs';

const {
  ACTIVE_RETIRED_GUIDANCE_FILES,
  ACTIVE_RETIRED_GUIDANCE_ROOTS,
  collectActiveRetiredGuidance,
  findRetiredGuidanceOffenders,
} = retiredGuidance;

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
        'packages/operator-core/lib/agent-tools/autonomy',
        'packages/operator-core/lib/agent-tools/decision_ledger',
      ]),
    );
  });
});
