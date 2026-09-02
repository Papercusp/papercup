/**
 * dispatch-intervention-reachable.test.ts — the PIN behind
 * {@link DISPATCH_INTERVENTION_REACHABLE}.
 *
 * `DISPATCH_INTERVENTION_REACHABLE` is a hand-stated measurement, and a
 * hand-stated fact about code is a second copy of a truth the code owns — it
 * WILL drift (CLAUDE.md, derived-truth ladder). Deriving it at runtime would mean
 * importing the orchestrator's seed lists into a telemetry sampler, and the only
 * export path is the package ROOT, which carries `invoke()` and the whole agent
 * main loop. So this is rung 2: the constant states the measurement and THIS test
 * fails the moment the seed lists stop agreeing with it.
 *
 * The direction that matters is the one nobody is watching for: when someone
 * finally seeds `coord:dispatch` onto a live surface (WI-2142095), this test goes
 * RED and names the constant to flip. Without it, the sampler would keep
 * reporting `interventionReachable: false` after the intervention landed, and the
 * falsifier would sit permanently `undetermined` — a disarmed falsifier that
 * looks armed, which is worse than the wrong-direction verdict it was built to
 * prevent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';
import {
  DISPATCH_INTERVENTION_REACHABLE,
  DISPATCH_TOOL,
  LIVE_SEED_LIST_NAMES,
} from './dispatch-adoption-sample';

/** The file that OWNS the seed lists. */
const INVOKE_TS = fileURLToPath(
  new URL('../../../../../libs/papercusp/packages/orchestrator/src/invoke.ts', import.meta.url),
);

/**
 * Extract every `export const <NAME>_MCP_TOOL_NAMES: readonly string[] = [...]`
 * block and the quoted tool names inside it.
 */
function parseSeedLists(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const header = /export const (\w*MCP_TOOL_NAMES)\s*:\s*readonly string\[\]\s*=\s*\[/g;
  for (let m = header.exec(source); m; m = header.exec(source)) {
    const start = m.index + m[0].length;
    const end = source.indexOf('\n];', start);
    if (end === -1) continue;
    const body = source.slice(start, end);
    out.set(m[1], [...body.matchAll(/'([^']+)'/g)].map((t) => t[1]));
  }
  return out;
}

describe('DISPATCH_INTERVENTION_REACHABLE is pinned to the real seed lists', () => {
  const source = readFileSync(INVOKE_TS, 'utf8');
  const lists = parseSeedLists(source);

  // ── POSITIVE CONTROLS ──────────────────────────────────────────────────────
  // An absence claim needs a positive control, or a broken parser reports a
  // confident "not seeded" that is really "did not read anything".
  it('the parser found the seed lists it is supposed to read', () => {
    expect(lists.size).toBeGreaterThanOrEqual(4);
    expect(lists.has('QUEEN_MCP_TOOL_NAMES')).toBe(true);
    for (const name of LIVE_SEED_LIST_NAMES) expect(lists.has(name)).toBe(true);
  });

  it('the parse matches the list the orchestrator actually exports', () => {
    // Proves the extraction reads real content — not an empty match that would
    // make every `includes()` below vacuously false.
    expect(lists.get('CORE_MCP_TOOL_NAMES')).toEqual([...CORE_MCP_TOOL_NAMES]);
    expect(CORE_MCP_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  // ── THE PIN ────────────────────────────────────────────────────────────────
  it('matches whether coord:dispatch is on any LIVE seeded surface', () => {
    const reachable = LIVE_SEED_LIST_NAMES.some((name) =>
      (lists.get(name) ?? []).includes(DISPATCH_TOOL),
    );
    expect(
      DISPATCH_INTERVENTION_REACHABLE,
      reachable
        ? `${DISPATCH_TOOL} IS now seeded onto a live surface — the P-011 intervention landed. Set DISPATCH_INTERVENTION_REACHABLE = true in dispatch-adoption-sample.ts so the falsifier can return a real verdict again.`
        : `${DISPATCH_TOOL} is NOT on any live seeded surface (${LIVE_SEED_LIST_NAMES.join(', ')}). Set DISPATCH_INTERVENTION_REACHABLE = false; do not flip it to silence a failure.`,
    ).toBe(reachable);
  });

  it('records WHY queen does not count: it is the retired mug tier', () => {
    // The measured 2026-09-02 state (WI-2142095). If this ever fails, the verb
    // moved — re-read the pin above rather than editing this expectation.
    expect((lists.get('QUEEN_MCP_TOOL_NAMES') ?? []).includes(DISPATCH_TOOL)).toBe(true);
    expect(LIVE_SEED_LIST_NAMES as readonly string[]).not.toContain('QUEEN_MCP_TOOL_NAMES');
  });
});
