/**
 * green-checkpoint: EVERY post-suite leg that can FAIL must red the verdict.
 *
 * `runGreen` computes `green = r.code === 0 && legs.ok` (green-checkpoint.ts), so
 * `legs.ok` IS the gate verdict for everything the suite itself does not cover.
 * `legs.ok` was a HAND-MAINTAINED list of leg fields — and a leg added to
 * `PostSuiteLegs` + `legsNotRun` + its own exec block, but forgotten in that list,
 * is silently excluded from the verdict.
 *
 * Measured 2026-08-09 (P-026): `lintMockCastEscape` was exactly that. It ran at
 * green-checkpoint.ts:5111, set `status:'failed'` and `haltedBy` on a red — which
 * SKIPS every later leg (`lintPlane`, `build`) — while being absent from the
 * `legs.ok` aggregation. Net effect of a `lint:mock-cast-escape` red: the plane
 * lints and the SPA build never ran, and the gate reported GREEN anyway. A false
 * green that also silently drops two real legs is the most expensive shape this
 * file has (cf. the WI-6053 incident in runPostSuiteLegs' own doc comment, where
 * five legs defaulted to `true` and an untypechecked candidate reached `main`).
 *
 * ANCHORED TO THE PROPERTY, NOT TO A NAME LIST. This test does not enumerate legs
 * by hand — a hardcoded list would need the same maintenance the bug came from,
 * and would go stale in the identical way. Instead it DISCOVERS the legs by
 * running the real `runPostSuiteLegs` against the real root package.json with a
 * stubbed exec, recording every `npm run <script>` it invokes, then re-runs once
 * per script failing exactly that one and asserts the invariant:
 *
 *     any leg with status 'failed'  ⇒  legs.ok === false
 *
 * A new leg is therefore covered the moment it is wired, with no edit here.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { runPostSuiteLegs, type CheckpointExec } from './green-checkpoint';

/** Repo root: apps/operator/lib/release/ -> ../../../.. */
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const ok = { code: 0, stdout: '', stderr: '' };

/** The npm script name of an `npm run <script>` / `npm --workspace X run <script>` argv. */
function npmScriptOf(cmd: string, args: string[]): string | null {
  if (cmd !== 'npm') return null;
  const i = args.indexOf('run');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

/**
 * Run the real leg chain with a stub exec. `failScript` (when given) is the ONE npm
 * script that exits non-zero; everything else — including the non-npm `git grep`
 * conflict-marker probe — succeeds.
 */
async function runLegs(failScript: string | null) {
  const invokedScripts: string[] = [];
  const exec: CheckpointExec = async (cmd, args) => {
    const script = npmScriptOf(cmd, args);
    if (script) invokedScripts.push(script);
    // `git grep` for conflict markers: exit 1 == "clean" (no match), which is what we want.
    if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
    if (script && script === failScript) {
      return { code: 1, stdout: `stub: ${script} failed`, stderr: '' };
    }
    return ok;
  };
  const legs = await runPostSuiteLegs(ROOT, {}, exec, '@papercusp/operator-vite');
  return { legs, invokedScripts };
}

/** Every leg field on the result that carries a `status` (i.e. is a LegOutcome). */
function legEntries(legs: Awaited<ReturnType<typeof runLegs>>['legs']) {
  return Object.entries(legs).filter(
    (e): e is [string, { status: string; skipReason?: string }] =>
      typeof e[1] === 'object' && e[1] !== null && 'status' in (e[1] as object),
  );
}

describe('green-checkpoint post-suite legs — verdict coverage', () => {
  it('runs a discoverable set of npm-script legs on the happy path', async () => {
    const { legs, invokedScripts } = await runLegs(null);
    // Sanity: the chain really ran (a zero-leg run would make every assertion below vacuous
    // — the same "green because nothing was measured" failure this file guards against).
    expect(invokedScripts.length).toBeGreaterThan(5);
    expect(legs.ok).toBe(true);
    expect(legEntries(legs).some(([, l]) => l.status === 'failed')).toBe(false);
  });

  it('reds the verdict for EVERY leg script that can fail (no leg excluded from legs.ok)', async () => {
    const { invokedScripts } = await runLegs(null);
    const scripts = [...new Set(invokedScripts)];

    const escaped: { script: string; failedLegs: string[]; skippedAfter: string[] }[] = [];
    for (const script of scripts) {
      const { legs } = await runLegs(script);
      const failed = legEntries(legs)
        .filter(([, l]) => l.status === 'failed')
        .map(([name]) => name);
      if (failed.length > 0 && legs.ok !== false) {
        escaped.push({
          script,
          failedLegs: failed,
          // What a `haltedBy` short-circuit silently dropped on the way past the verdict.
          skippedAfter: legEntries(legs)
            .filter(([, l]) => l.status === 'skipped' && l.skipReason?.includes(script))
            .map(([name]) => name),
        });
      }
    }

    expect(
      escaped,
      `These npm scripts FAILED a post-suite leg but left legs.ok true — the gate would report ` +
        `GREEN on their red (and skip every later leg). Add the leg field to the legs.ok ` +
        `aggregation in runPostSuiteLegs:\n${JSON.stringify(escaped, null, 2)}`,
    ).toEqual([]);
  });
});
